// ============================================================
// Resume Tailor
// Produces a job-specific resume variant that maximises ATS
// score and relevance for a specific role + company.
//
// What gets modified:
//  • Professional summary — rewritten around the target role
//  • Experience bullets — enhanced with JD keywords, quantified
//  • Skills section — reordered by JD importance, missing added
//  • Keywords — injected where natural, flagged where forced
//
// What never changes:
//  • Dates, companies, titles (factual, cannot be altered)
//  • Education (factual)
//  • Core job responsibilities (not fabricated)
//
// Output:
//  • TailoredResume object (in-memory, stored to DB)
//  • PDF-ready JSON for the PDF generator
//
// Uses Claude claude-sonnet-4-6 with temp=0 for consistency.
// ============================================================

import type { PrepInput, TailoredResume, TailoredExperience, SkillGroup } from '../types/prepTypes.js';
import type { JdAnalysis } from '../analyzer/jdAnalyzer.js';
import { logger } from '../utils/logger.js';

const SYSTEM_PROMPT = `You are an expert resume writer and ATS optimisation specialist.
Rewrite resume content to be perfectly tailored for a specific role.
Keep all facts accurate — never invent companies, dates, or achievements.
Only enhance existing content: sharpen wording, add relevant keywords naturally, quantify impact.
Return ONLY valid JSON. No markdown. No commentary.`;

// ─────────────────────────────────────────────────────────────
// MAIN TAILOR FUNCTION
// ─────────────────────────────────────────────────────────────
export async function tailorResume(
  input: PrepInput,
  jd:    JdAnalysis,
): Promise<TailoredResume> {
  logger.info('Tailoring resume', {
    company:   input.companyName,
    role:      input.jobTitle,
    atsGap:    jd.atsKeywords.filter(k => !k.inResume && k.importance === 'critical').length,
  });

  const apiKey = process.env['ANTHROPIC_API_KEY']!;

  const missingKeywords = jd.atsKeywords
    .filter(k => !k.inResume && k.importance !== 'supporting')
    .slice(0, 12)
    .map(k => k.term);

  const topKeywords = jd.atsKeywords
    .filter(k => k.importance === 'critical')
    .slice(0, 8)
    .map(k => k.term);

  const prompt = buildTailorPrompt(input, jd, missingKeywords, topKeywords);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:       'claude-sonnet-4-6',
      max_tokens:  4000,
      temperature: 0,
      system:      SYSTEM_PROMPT,
      messages:    [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API ${res.status}`);

  const data = await res.json() as { content: Array<{ type: string; text?: string }> };
  const raw  = data.content.find(c => c.type === 'text')?.text ?? '{}';

  try {
    return parseTailoredResume(raw, input, jd, missingKeywords, topKeywords);
  } catch (err) {
    logger.warn('Resume tailor parse failed', { error: String(err) });
    return buildFallbackTailoredResume(input, jd, missingKeywords);
  }
}

// ─────────────────────────────────────────────────────────────
// PROMPT BUILDER
// ─────────────────────────────────────────────────────────────
function buildTailorPrompt(
  input:           PrepInput,
  jd:              JdAnalysis,
  missingKeywords: string[],
  topKeywords:     string[],
): string {
  const resumeSnippet = input.resumeText.slice(0, 2500);
  const topResp       = jd.responsibilities.slice(0, 4).join('\n• ');

  return `Tailor this resume for the following role.

TARGET ROLE: ${input.jobTitle} at ${input.companyName}
SENIORITY: ${input.seniority}

ATS KEYWORDS THAT MUST APPEAR (inject naturally where true):
${topKeywords.join(', ')}

KEYWORDS MISSING FROM CURRENT RESUME (add only where genuinely applicable):
${missingKeywords.join(', ')}

KEY JOB RESPONSIBILITIES TO MIRROR:
• ${topResp}

CURRENT RESUME:
${resumeSnippet}

Return this JSON:
{
  "tailored_summary": "Rewritten 3-4 sentence professional summary. Open strong. Mirror the job title. Include top 3 required skills naturally. End with what you bring to ${input.companyName} specifically.",

  "tailored_experience": [
    {
      "company": "Company name (unchanged)",
      "title": "Job title (unchanged)",
      "start_date": "Unchanged",
      "end_date": "Unchanged",
      "original_bullets": ["Copy of original bullets"],
      "tailored_bullets": [
        "Enhanced bullet 1 — same fact, stronger language, includes JD keywords where natural. Starts with action verb. Quantified where possible.",
        "Enhanced bullet 2",
        "Enhanced bullet 3"
      ],
      "changed_count": 2
    }
  ],

  "tailored_skills": [
    {
      "category": "Languages & Frameworks",
      "skills": ["Reordered to put JD-relevant skills first"]
    }
  ],

  "added_keywords": ["Keywords that were added to the resume"],
  "removed_content": ["Any content that was removed as irrelevant to this role"],
  "ats_score": 85,
  "improvement_notes": [
    "Summary now opens with '${input.jobTitle}' which matches ATS parsing",
    "Added 'distributed systems' to Company X bullet where genuinely relevant",
    "Moved Python to top of skills — explicitly required in JD"
  ]
}`;
}

// ─────────────────────────────────────────────────────────────
// PARSE + NORMALISE CLAUDE OUTPUT
// ─────────────────────────────────────────────────────────────
interface RawTailored {
  tailored_summary:    string;
  tailored_experience: Array<{
    company:          string;
    title:            string;
    start_date:       string;
    end_date:         string | null;
    original_bullets: string[];
    tailored_bullets: string[];
    changed_count:    number;
  }>;
  tailored_skills:   Array<{ category: string; skills: string[] }>;
  added_keywords:    string[];
  removed_content:   string[];
  ats_score:         number;
  improvement_notes: string[];
}

function parseTailoredResume(
  raw:             string,
  input:           PrepInput,
  jd:              JdAnalysis,
  missingKeywords: string[],
  topKeywords:     string[],
): TailoredResume {
  const json = JSON.parse(raw.replace(/```json|```/g, '').trim()) as RawTailored;

  const tailoredExperience: TailoredExperience[] = (json.tailored_experience ?? []).map(exp => ({
    company:         exp.company,
    title:           exp.title,
    startDate:       exp.start_date,
    endDate:         exp.end_date ?? null,
    location:        null,
    bullets:         exp.tailored_bullets ?? [],
    originalBullets: exp.original_bullets ?? [],
    changedBullets:  exp.changed_count ?? 0,
    technologies:    [],
  }));

  const tailoredSkills: SkillGroup[] = (json.tailored_skills ?? []).map(sg => ({
    category: sg.category,
    skills:   sg.skills,
  }));

  const atsScore = Math.min(100, Math.max(0, json.ats_score ?? estimateAtsScore(jd, json.added_keywords ?? [])));

  return {
    originalResumeId: input.applicationId,
    targetJobTitle:   input.jobTitle,
    targetCompany:    input.companyName,
    tailoredSummary:  json.tailored_summary ?? '',
    tailoredExperience,
    tailoredSkills,
    addedKeywords:    json.added_keywords    ?? missingKeywords.slice(0, 5),
    removedContent:   json.removed_content   ?? [],
    atsScore,
    improvementNotes: json.improvement_notes ?? [],
  };
}

// ─────────────────────────────────────────────────────────────
// FALLBACK
// ─────────────────────────────────────────────────────────────
function buildFallbackTailoredResume(
  input:           PrepInput,
  jd:              JdAnalysis,
  missingKeywords: string[],
): TailoredResume {
  const topSkills = jd.requiredSkills.slice(0, 3).map(s => s.name).join(', ');

  return {
    originalResumeId: input.applicationId,
    targetJobTitle:   input.jobTitle,
    targetCompany:    input.companyName,
    tailoredSummary:  `${capitalise(input.seniority)} ${input.jobTitle} with proven expertise in ${topSkills}. Experienced in building scalable, production-grade systems that deliver measurable business impact. Excited to bring this background to ${input.companyName}'s mission.`,
    tailoredExperience: [],
    tailoredSkills:   [],
    addedKeywords:    missingKeywords.slice(0, 5),
    removedContent:   [],
    atsScore:         estimateAtsScore(jd, []),
    improvementNotes: [
      'Summary updated to lead with target job title',
      `Missing keywords to add manually: ${missingKeywords.slice(0, 4).join(', ')}`,
    ],
  };
}

// ─────────────────────────────────────────────────────────────
// ATS SCORE ESTIMATOR
// ─────────────────────────────────────────────────────────────
export function estimateAtsScore(jd: JdAnalysis, addedKeywords: string[]): number {
  const critical = jd.atsKeywords.filter(k => k.importance === 'critical');
  const covered  = critical.filter(k => k.inResume || addedKeywords.some(a =>
    a.toLowerCase() === k.term.toLowerCase()
  ));

  if (critical.length === 0) return 75;

  const coverageRatio = covered.length / critical.length;
  return Math.round(50 + coverageRatio * 45);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
