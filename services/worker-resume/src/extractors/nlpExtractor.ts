// ============================================================
// Claude NLP Extractor
// Uses Claude claude-sonnet-4-6 to extract structured data from
// resume text. Returns a fully-typed CandidateProfile.
//
// Pipeline:
//   1. Pre-process: regex extraction for dates, contacts
//   2. Section-aware: send each section to targeted prompts
//   3. Claude: structured JSON extraction with Zod validation
//   4. Post-process: compute derived fields (total years, etc.)
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type {
  CandidateProfile,
  RawResumeText,
  WorkExperience,
  Education,
  Skill,
  Technology,
  Certification,
  Language,
  SeniorityLevel,
  ProficiencyLevel,
  SkillCategory,
  TechType,
  DegreeLevel,
} from '../types/resumeTypes.js';
import { TECH_TAXONOMY, lookupTech, normalizeTechName } from './techTaxonomy.js';
import { logger } from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────
const EXTRACTION_SYSTEM_PROMPT = `You are a precision resume parser and NLP extraction engine. 
You extract structured information from resume text with high accuracy.

RULES:
1. Extract ONLY information explicitly present in the text. Do NOT invent or infer.
2. For dates: use format "YYYY-MM" when month is known, "YYYY" when only year is known, null when unknown.
3. For "current" roles: endDate = null, isCurrent = true.
4. Skills: extract ONLY skills mentioned explicitly. Do NOT add skills not in the text.
5. experience_years: calculate from earliest start date to today. If only years, assume Jan 1.
6. Seniority: infer from most recent title and total experience, NOT from job level expectations.
7. All string arrays: return empty [] NOT null when nothing found.
8. Return ONLY valid JSON. No preamble, no explanation, no markdown.`;

// ─────────────────────────────────────────────────────────────
// EXTRACTION PROMPT BUILDER
// ─────────────────────────────────────────────────────────────
function buildExtractionPrompt(resume: RawResumeText): string {
  // Cap text to avoid exceeding context window
  const MAX_CHARS = 12000;
  const text = resume.full.length > MAX_CHARS
    ? resume.full.substring(0, MAX_CHARS) + '\n[...truncated...]'
    : resume.full;

  const today = new Date().toISOString().split('T')[0];

  return `Today's date: ${today}

## RESUME TEXT
${text}

## INSTRUCTION
Extract ALL information from this resume and return a JSON object with this EXACT structure:

{
  "name": string | null,
  "email": string | null,
  "phone": string | null,
  "location": string | null,
  "linkedinUrl": string | null,
  "githubUrl": string | null,
  "portfolioUrl": string | null,
  "summary": string | null,
  "currentTitle": string | null,
  "seniorityLevel": "student"|"entry"|"junior"|"mid"|"senior"|"lead"|"principal"|"staff"|"director"|"vp"|"c_level"|"unknown",
  "experience_years": number,
  "roles": string[],
  "industries": string[],
  "skills": [
    {
      "name": string,
      "category": "programming_language"|"framework"|"database"|"cloud"|"devops"|"testing"|"design"|"data_science"|"security"|"mobile"|"soft_skill"|"domain_knowledge"|"tool"|"methodology"|"other",
      "proficiency": "expert"|"advanced"|"intermediate"|"beginner"|"exposure",
      "yearsUsed": number | null,
      "explicit": true
    }
  ],
  "technologies": [
    {
      "name": string,
      "type": "language"|"framework"|"library"|"database"|"cloud_service"|"devops_tool"|"platform"|"api"|"protocol"|"tool"|"other",
      "version": string | null
    }
  ],
  "experience": [
    {
      "title": string,
      "company": string,
      "location": string | null,
      "startDate": string | null,
      "endDate": string | null,
      "isCurrent": boolean,
      "durationMonths": number | null,
      "description": string | null,
      "achievements": string[],
      "skills": string[],
      "technologies": string[]
    }
  ],
  "education": [
    {
      "institution": string,
      "degree": string | null,
      "field": string | null,
      "level": "phd"|"masters"|"bachelors"|"associates"|"diploma"|"bootcamp"|"certification"|"high_school"|"other",
      "startYear": number | null,
      "endYear": number | null,
      "gpa": number | null,
      "honors": string | null
    }
  ],
  "certifications": [
    {
      "name": string,
      "issuer": string | null,
      "issuedDate": string | null,
      "expiryDate": string | null,
      "credentialId": string | null
    }
  ],
  "languages": [
    {
      "name": string,
      "proficiency": "Native"|"Fluent"|"Professional"|"Conversational"|"Basic"
    }
  ]
}`;
}

// ─────────────────────────────────────────────────────────────
// ZOD VALIDATION SCHEMA
// ─────────────────────────────────────────────────────────────
const SkillSchema = z.object({
  name:        z.string(),
  category:    z.enum(['programming_language','framework','database','cloud','devops','testing','design','data_science','security','mobile','soft_skill','domain_knowledge','tool','methodology','other']),
  proficiency: z.enum(['expert','advanced','intermediate','beginner','exposure']),
  yearsUsed:   z.number().nullable().default(null),
  explicit:    z.boolean().default(true),
});

const TechSchema = z.object({
  name:    z.string(),
  type:    z.enum(['language','framework','library','database','cloud_service','devops_tool','platform','api','protocol','tool','other']),
  version: z.string().nullable().default(null),
});

const ExperienceSchema = z.object({
  title:          z.string(),
  company:        z.string(),
  location:       z.string().nullable().default(null),
  startDate:      z.string().nullable().default(null),
  endDate:        z.string().nullable().default(null),
  isCurrent:      z.boolean().default(false),
  durationMonths: z.number().nullable().default(null),
  description:    z.string().nullable().default(null),
  achievements:   z.array(z.string()).default([]),
  skills:         z.array(z.string()).default([]),
  technologies:   z.array(z.string()).default([]),
});

const EducationSchema = z.object({
  institution: z.string(),
  degree:      z.string().nullable().default(null),
  field:       z.string().nullable().default(null),
  level:       z.enum(['phd','masters','bachelors','associates','diploma','bootcamp','certification','high_school','other']),
  startYear:   z.number().nullable().default(null),
  endYear:     z.number().nullable().default(null),
  gpa:         z.number().nullable().default(null),
  honors:      z.string().nullable().default(null),
});

const CertSchema = z.object({
  name:         z.string(),
  issuer:       z.string().nullable().default(null),
  issuedDate:   z.string().nullable().default(null),
  expiryDate:   z.string().nullable().default(null),
  credentialId: z.string().nullable().default(null),
});

const LangSchema = z.object({
  name:        z.string(),
  proficiency: z.enum(['Native','Fluent','Professional','Conversational','Basic']),
});

const ExtractionSchema = z.object({
  name:           z.string().nullable().default(null),
  email:          z.string().nullable().default(null),
  phone:          z.string().nullable().default(null),
  location:       z.string().nullable().default(null),
  linkedinUrl:    z.string().nullable().default(null),
  githubUrl:      z.string().nullable().default(null),
  portfolioUrl:   z.string().nullable().default(null),
  summary:        z.string().nullable().default(null),
  currentTitle:   z.string().nullable().default(null),
  seniorityLevel: z.enum(['student','entry','junior','mid','senior','lead','principal','staff','director','vp','c_level','unknown']).default('unknown'),
  experience_years: z.number().default(0),
  roles:          z.array(z.string()).default([]),
  industries:     z.array(z.string()).default([]),
  skills:         z.array(SkillSchema).default([]),
  technologies:   z.array(TechSchema).default([]),
  experience:     z.array(ExperienceSchema).default([]),
  education:      z.array(EducationSchema).default([]),
  certifications: z.array(CertSchema).default([]),
  languages:      z.array(LangSchema).default([]),
});

type ExtractionOutput = z.infer<typeof ExtractionSchema>;

// ─────────────────────────────────────────────────────────────
// CLAUDE API CALL
// ─────────────────────────────────────────────────────────────
let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });
  return client;
}

async function callClaudeForExtraction(
  resume: RawResumeText,
): Promise<{ data: ExtractionOutput; tokensUsed: number; model: string }> {
  const systemPrompt = EXTRACTION_SYSTEM_PROMPT;
  const userPrompt   = buildExtractionPrompt(resume);
  const model        = process.env['ANTHROPIC_MODEL_SMART'] ?? 'claude-sonnet-4-6';

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await getClient().messages.create({
        model,
        max_tokens: 4096,
        temperature: 0,      // Zero temperature for deterministic extraction
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const rawText = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text)
        .join('');

      // Strip markdown fences
      let jsonText = rawText.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '');
      const fb = jsonText.indexOf('{');
      const lb = jsonText.lastIndexOf('}');
      if (fb !== -1 && lb !== -1) jsonText = jsonText.slice(fb, lb + 1);

      const parsed = JSON.parse(jsonText) as unknown;
      const validated = ExtractionSchema.parse(parsed);

      return {
        data: validated,
        tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
        model,
      };

    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isRetryable = lastError.message.includes('429') || lastError.message.includes('529');
      if (isRetryable && attempt < 3) {
        const delay = 5000 * attempt;
        logger.warn(`Claude extraction rate limited, retry in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError!;
}

// ─────────────────────────────────────────────────────────────
// POST-PROCESSING
// ─────────────────────────────────────────────────────────────

/** Compute total experience years from work history dates */
function computeExperienceYears(experience: ExtractionOutput['experience']): number {
  if (experience.length === 0) return 0;

  const today = new Date();
  let totalMonths = 0;

  for (const exp of experience) {
    const start = parseFlexDate(exp.startDate);
    const end   = exp.isCurrent || !exp.endDate ? today : parseFlexDate(exp.endDate);

    if (start && end) {
      const months = (end.getFullYear() - start.getFullYear()) * 12
        + (end.getMonth() - start.getMonth());
      totalMonths += Math.max(0, months);
    } else if (exp.durationMonths) {
      totalMonths += exp.durationMonths;
    }
  }

  return Math.round((totalMonths / 12) * 10) / 10; // 1 decimal
}

function parseFlexDate(dateStr: string | null): Date | null {
  if (!dateStr) return null;
  // "2020-03" → March 2020, "2020" → Jan 2020
  if (/^\d{4}-\d{2}$/.test(dateStr)) return new Date(`${dateStr}-01`);
  if (/^\d{4}$/.test(dateStr))       return new Date(`${dateStr}-01-01`);
  try { return new Date(dateStr); } catch { return null; }
}

/** Compute duration months for each experience entry */
function enrichExperienceDurations(
  experience: ExtractionOutput['experience'],
): WorkExperience[] {
  const today = new Date();

  return experience.map(exp => {
    let durationMonths = exp.durationMonths;

    if (!durationMonths) {
      const start = parseFlexDate(exp.startDate);
      const end   = exp.isCurrent || !exp.endDate ? today : parseFlexDate(exp.endDate);
      if (start && end) {
        durationMonths = Math.max(0,
          (end.getFullYear() - start.getFullYear()) * 12
          + (end.getMonth() - start.getMonth())
        );
      }
    }

    return { ...exp, durationMonths };
  });
}

/** Normalise skill names using taxonomy */
function normaliseSkills(skills: ExtractionOutput['skills']): Skill[] {
  const seen = new Set<string>();
  return skills
    .map(skill => {
      const normalised = normalizeTechName(skill.name);
      const entry      = lookupTech(skill.name);
      return {
        ...skill,
        name:     normalised,
        category: (entry?.category ?? skill.category) as SkillCategory,
      };
    })
    .filter(skill => {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Normalise tech names using taxonomy, add missing entries from skills */
function normaliseTech(
  technologies: ExtractionOutput['technologies'],
  skills: Skill[],
): Technology[] {
  const seen = new Set<string>();
  const result: Technology[] = [];

  // From Claude's extraction
  for (const tech of technologies) {
    const entry = lookupTech(tech.name);
    const canonical = entry ? entry.canonical : tech.name;
    if (!seen.has(canonical.toLowerCase())) {
      seen.add(canonical.toLowerCase());
      result.push({ ...tech, name: canonical, type: (entry?.type ?? tech.type) as TechType });
    }
  }

  // Add technical skills not already in tech list
  const techCategories: SkillCategory[] = ['programming_language','framework','database','cloud','devops','testing','mobile','data_science'];
  for (const skill of skills) {
    if (techCategories.includes(skill.category) && !seen.has(skill.name.toLowerCase())) {
      const entry = lookupTech(skill.name);
      seen.add(skill.name.toLowerCase());
      result.push({
        name:    skill.name,
        type:    (entry?.type ?? 'other') as TechType,
        version: null,
      });
    }
  }

  return result;
}

/** Infer highest degree from education */
function inferHighestDegree(education: Education[]): DegreeLevel | null {
  const order: DegreeLevel[] = ['phd','masters','bachelors','associates','diploma','bootcamp','certification','high_school','other'];
  for (const level of order) {
    if (education.some(e => e.level === level)) return level;
  }
  return education.length > 0 ? 'other' : null;
}

// ─────────────────────────────────────────────────────────────
// REGEX PRE-EXTRACTION (before Claude call)
// Extracts common patterns to validate/augment Claude output
// ─────────────────────────────────────────────────────────────
function regexPreExtract(text: string): {
  email:       string | null;
  phone:       string | null;
  linkedinUrl: string | null;
  githubUrl:   string | null;
} {
  const emailMatch   = text.match(/[\w.+\-]+@[\w\-]+\.[\w.]{2,}/);
  const phoneMatch   = text.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|(?:\+\d{1,3}[-.\s]?)?\d{8,15}/);
  const linkedinMatch = text.match(/(?:linkedin\.com\/in\/)([\w\-]+)/i);
  const githubMatch  = text.match(/(?:github\.com\/)([\w\-]+)/i);

  return {
    email:       emailMatch?.[0] ?? null,
    phone:       phoneMatch?.[0] ?? null,
    linkedinUrl: linkedinMatch ? `https://linkedin.com/in/${linkedinMatch[1]}` : null,
    githubUrl:   githubMatch   ? `https://github.com/${githubMatch[1]}`        : null,
  };
}

// ─────────────────────────────────────────────────────────────
// MAIN EXTRACTION FUNCTION
// ─────────────────────────────────────────────────────────────
export async function extractCandidateProfile(
  resume: RawResumeText,
): Promise<{ profile: CandidateProfile; tokensUsed: number; model: string }> {
  const startMs = Date.now();

  // Step 1: Regex pre-extraction (free, instant)
  const regexData = regexPreExtract(resume.full);

  // Step 2: Claude NLP extraction
  const { data, tokensUsed, model } = await callClaudeForExtraction(resume);

  // Step 3: Post-process and enrich
  const skills       = normaliseSkills(data.skills);
  const enrichedExp  = enrichExperienceDurations(data.experience);
  const technologies = normaliseTech(data.technologies, skills);
  const expYears     = computeExperienceYears(enrichedExp);

  // Merge regex data (higher confidence for contact info)
  const finalEmail       = regexData.email       ?? data.email;
  const finalPhone       = regexData.phone       ?? data.phone;
  const finalLinkedin    = regexData.linkedinUrl ?? data.linkedinUrl;
  const finalGithub      = regexData.githubUrl   ?? data.githubUrl;

  const profile: CandidateProfile = {
    // Contact
    name:         data.name,
    email:        finalEmail,
    phone:        finalPhone,
    location:     data.location,
    linkedinUrl:  finalLinkedin,
    githubUrl:    finalGithub,
    portfolioUrl: data.portfolioUrl,

    // Career
    summary:          data.summary,
    currentTitle:     data.currentTitle ?? (enrichedExp[0]?.title ?? null),
    seniorityLevel:   data.seniorityLevel as SeniorityLevel,
    experience_years: expYears > 0 ? expYears : data.experience_years,
    roles:            [...new Set([...data.roles, ...enrichedExp.map(e => e.title)])],
    industries:       data.industries,

    // Skills & Tech
    skills,
    skills_flat: skills.map(s => s.name),
    technologies,
    technologies_flat: technologies.map(t => t.name),

    // History
    experience:    enrichedExp,
    education:     data.education as Education[],
    highest_degree: inferHighestDegree(data.education as Education[]),
    certifications: data.certifications as Certification[],
    languages:      data.languages as Language[],

    // Meta
    _meta: {
      extractedAt:   new Date().toISOString(),
      modelUsed:     model,
      tokensUsed,
      parserVersion: '2.0.0',
      rawTextLength: resume.full.length,
      confidence:    computeConfidence(data, resume),
      warnings:      buildWarnings(data, resume),
    },
  };

  logger.info('Extraction complete', {
    skills:  skills.length,
    tech:    technologies.length,
    roles:   profile.roles.length,
    expYears: profile.experience_years,
    education: profile.education.length,
    ms:      Date.now() - startMs,
  });

  return { profile, tokensUsed, model };
}

// ─────────────────────────────────────────────────────────────
// CONFIDENCE SCORING
// ─────────────────────────────────────────────────────────────
function computeConfidence(data: ExtractionOutput, resume: RawResumeText): number {
  let score = 1.0;

  if (!data.name)         score -= 0.05;
  if (!data.email)        score -= 0.05;
  if (data.skills.length === 0)     score -= 0.15;
  if (data.experience.length === 0) score -= 0.20;
  if (!resume.metadata.hasStructure) score -= 0.10;
  if (resume.metadata.wordCount < 100) score -= 0.20;
  if (data.experience_years === 0)  score -= 0.05;

  return Math.max(0, Math.round(score * 100) / 100);
}

function buildWarnings(data: ExtractionOutput, resume: RawResumeText): string[] {
  const warnings: string[] = [];

  if (!data.name)          warnings.push('Candidate name not found');
  if (!data.email)         warnings.push('Email address not found');
  if (data.skills.length === 0)     warnings.push('No skills extracted');
  if (data.experience.length === 0) warnings.push('No work experience found');
  if (resume.metadata.wordCount < 100) warnings.push('Resume text very short — may be parsing issue');
  if (!resume.metadata.hasStructure)   warnings.push('No clear section structure detected');

  return warnings;
}
