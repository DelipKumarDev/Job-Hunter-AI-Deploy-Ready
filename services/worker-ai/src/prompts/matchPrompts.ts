// ============================================================
// AI Match Engine — Prompt Templates
// Carefully engineered prompts for Claude to score job fits.
// Uses structured JSON output for reliable parsing.
// ============================================================

import type { CandidateProfile, JobListingForMatch } from '../types.js';
import { SCORE_WEIGHTS } from '../types.js';

// ── System prompt ─────────────────────────────────────────────
export const MATCH_SYSTEM_PROMPT = `You are an expert talent acquisition specialist and career coach with 15+ years of experience evaluating job fit. Your task is to analyze how well a candidate's profile matches a specific job listing.

You evaluate matches across 4 dimensions with specific weights:
- Skills Match (${SCORE_WEIGHTS.SKILLS}%): Technical skills, tools, frameworks, domain knowledge
- Experience Relevance (${SCORE_WEIGHTS.EXPERIENCE}%): Years of experience, seniority level, industry, role similarity  
- Location Fit (${SCORE_WEIGHTS.LOCATION}%): Geographic compatibility, remote work preferences, relocation willingness
- Salary Alignment (${SCORE_WEIGHTS.SALARY}%): Whether compensation ranges overlap

SCORING GUIDELINES:
90-100: Exceptional match — candidate is highly qualified, nearly perfect fit
75-89: Strong match — well qualified, minor gaps only  
60-74: Good match — qualified but some notable gaps
45-59: Partial match — could work but significant gaps exist
30-44: Weak match — major misalignment in key areas
0-29: Poor match — fundamental misalignment

CRITICAL RULES:
- Be honest and accurate. Do NOT inflate scores to be nice.
- Base scores strictly on evidence in the provided data.
- A candidate with 2 years experience should NOT score 85% on experience for a "10+ years required" role.
- Missing required skills should significantly reduce the skills score.
- Location mismatch with no remote option = low location score.
- If salary data is missing for either party, give location a neutral score of 60.

OUTPUT FORMAT: You MUST respond with ONLY valid JSON matching this exact schema. No preamble, no explanation, no markdown:

{
  "skillsScore": {
    "raw": <integer 0-100>,
    "rationale": "<2-3 sentence explanation>",
    "signals": ["<specific evidence 1>", "<specific evidence 2>", ...]
  },
  "experienceScore": {
    "raw": <integer 0-100>,
    "rationale": "<2-3 sentence explanation>",
    "signals": ["<specific evidence 1>", "<specific evidence 2>", ...]
  },
  "locationScore": {
    "raw": <integer 0-100>,
    "rationale": "<1-2 sentence explanation>",
    "signals": ["<specific evidence>"]
  },
  "salaryScore": {
    "raw": <integer 0-100>,
    "rationale": "<1-2 sentence explanation>",
    "signals": ["<specific evidence>"]
  },
  "missingSkills": ["<skill not in profile but required/preferred by job>", ...],
  "strengthAreas": ["<area where candidate clearly exceeds requirements>", ...],
  "redFlags": ["<serious concern that might disqualify>", ...],
  "keyHighlights": ["<top reason this is a good match>", ...],
  "summary": "<3-4 sentence overall assessment. Be specific and actionable.>"
}`;

// ── User prompt builder ────────────────────────────────────────
export function buildMatchPrompt(
  candidate: CandidateProfile,
  job: JobListingForMatch,
): string {
  const skillsList = candidate.skills
    .map(s => `  - ${s.name} (${s.proficiency}${s.category ? `, ${s.category}` : ''})`)
    .join('\n') || '  (No skills listed)';

  const candidateSalaryRange = candidate.preferences?.salaryMin && candidate.preferences?.salaryMax
    ? `${candidate.preferences.salaryCurrency} ${formatSalary(candidate.preferences.salaryMin)} – ${formatSalary(candidate.preferences.salaryMax)}/year`
    : candidate.preferences?.salaryMin
      ? `${candidate.preferences.salaryCurrency} ${formatSalary(candidate.preferences.salaryMin)}+/year`
      : 'Not specified';

  const jobSalaryRange = job.salaryMin && job.salaryMax
    ? `${job.salaryCurrency ?? 'USD'} ${formatSalary(job.salaryMin)} – ${formatSalary(job.salaryMax)}/year`
    : job.salaryMin
      ? `${job.salaryCurrency ?? 'USD'} ${formatSalary(job.salaryMin)}+/year`
      : 'Not disclosed';

  const remotePreference = formatRemotePreference(candidate.preferences?.remotePreference ?? 'NO_PREFERENCE');
  const jobRemote = job.remoteType ?? 'Not specified';

  const targetRoles = candidate.preferences?.targetRoles?.join(', ') || 'Not specified';
  const preferredLocations = candidate.preferences?.preferredLocations?.join(', ') || 'Not specified';

  // Truncate resume to avoid exceeding context window (keep ~3000 chars)
  const resumeSnippet = candidate.resumeText
    ? candidate.resumeText.substring(0, 3000) + (candidate.resumeText.length > 3000 ? '\n[... truncated ...]' : '')
    : null;

  // Truncate job description to ~2000 chars
  const descriptionSnippet = job.description.substring(0, 2000)
    + (job.description.length > 2000 ? '\n[... truncated ...]' : '');

  const requirementsSnippet = job.requirements
    ? job.requirements.substring(0, 1000) + (job.requirements.length > 1000 ? '\n[... truncated ...]' : '')
    : null;

  return `## CANDIDATE PROFILE

**Name:** ${candidate.firstName} ${candidate.lastName}
**Current Title:** ${candidate.currentTitle ?? 'Not specified'}
**Seniority Level:** ${candidate.seniorityLevel ?? 'Not specified'}
**Years of Experience:** ${candidate.yearsExperience != null ? `${candidate.yearsExperience} years` : 'Not specified'}
**Location:** ${candidate.location ?? 'Not specified'} (${candidate.country ?? 'Unknown country'})
**Headline:** ${candidate.headline ?? 'Not specified'}

**Skills (${candidate.skills.length} total):**
${skillsList}

**Target Roles:** ${targetRoles}
**Preferred Locations:** ${preferredLocations}
**Remote Preference:** ${remotePreference}
**Expected Salary:** ${candidateSalaryRange}

${candidate.bio ? `**Professional Summary:**\n${candidate.bio.substring(0, 500)}\n` : ''}
${resumeSnippet ? `**Resume Excerpt:**\n${resumeSnippet}\n` : ''}

---

## JOB LISTING

**Title:** ${job.title}
**Company:** ${job.company}
**Location:** ${job.location ?? 'Not specified'} (${job.country ?? 'Unknown'})
**Remote Type:** ${jobRemote}
**Job Type:** ${job.jobType ?? 'Not specified'}
**Experience Level:** ${job.experienceLevel ?? 'Not specified'}
**Salary Range:** ${jobSalaryRange}
**Platform:** ${job.sourcePlatform}

**Job Description:**
${descriptionSnippet}

${requirementsSnippet ? `**Requirements:**\n${requirementsSnippet}` : ''}

---

Evaluate this match. Respond with ONLY the JSON object as specified.`;
}

// ── Retry prompt for malformed responses ─────────────────────
export const RETRY_SYSTEM_PROMPT = `You previously responded with malformed JSON. 
Respond ONLY with valid JSON matching the schema. No markdown, no backticks, no explanation.
Start your response with { and end with }.`;

// ── Helpers ───────────────────────────────────────────────────

function formatSalary(amount: number): string {
  if (amount >= 1000000) return `${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 1000) return `${Math.round(amount / 1000)}k`;
  return String(amount);
}

function formatRemotePreference(pref: string): string {
  const map: Record<string, string> = {
    REMOTE_ONLY: 'Remote only',
    HYBRID_OK: 'Hybrid OK, prefers remote',
    ON_SITE_OK: 'On-site OK',
    NO_PREFERENCE: 'No preference',
  };
  return map[pref] ?? pref;
}

// ── Token estimator (rough, pre-API-call) ─────────────────────
export function estimateTokens(text: string): number {
  // ~4 chars per token for English text
  return Math.ceil(text.length / 4);
}
