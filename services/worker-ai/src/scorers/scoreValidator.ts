// ============================================================
// Score Validator
// Validates, clamps, and post-processes Claude's raw JSON
// output into a fully-typed MatchAnalysis object.
// Applies weighted formula to compute final total score.
// ============================================================

import { z } from 'zod';
import type { MatchAnalysis, DimensionScore } from '../types.js';
import { SCORE_WEIGHTS } from '../types.js';

// ── Zod schema for Claude's raw output ───────────────────────
const DimensionSchema = z.object({
  raw: z.number().min(0).max(100),
  rationale: z.string().min(1),
  signals: z.array(z.string()).default([]),
});

export const ClaudeMatchOutputSchema = z.object({
  skillsScore: DimensionSchema,
  experienceScore: DimensionSchema,
  locationScore: DimensionSchema,
  salaryScore: DimensionSchema,
  missingSkills: z.array(z.string()).default([]),
  strengthAreas: z.array(z.string()).default([]),
  redFlags: z.array(z.string()).default([]),
  keyHighlights: z.array(z.string()).default([]),
  summary: z.string().min(1),
});

export type ClaudeMatchOutput = z.infer<typeof ClaudeMatchOutputSchema>;

// ── Validate Claude's raw JSON ────────────────────────────────
export function validateClaudeOutput(raw: unknown): ClaudeMatchOutput {
  const result = ClaudeMatchOutputSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Claude output validation failed: ${issues}`);
  }

  return result.data;
}

// ── Apply weighted scoring formula ───────────────────────────
//
// Formula:
//   totalScore = (skillsRaw × 0.40)
//              + (experienceRaw × 0.30)
//              + (locationRaw × 0.20)
//              + (salaryRaw × 0.10)
//
export function computeWeightedScore(output: ClaudeMatchOutput): number {
  const weightedSkills      = output.skillsScore.raw      * (SCORE_WEIGHTS.SKILLS      / 100);
  const weightedExperience  = output.experienceScore.raw  * (SCORE_WEIGHTS.EXPERIENCE  / 100);
  const weightedLocation    = output.locationScore.raw    * (SCORE_WEIGHTS.LOCATION    / 100);
  const weightedSalary      = output.salaryScore.raw      * (SCORE_WEIGHTS.SALARY      / 100);

  const total = weightedSkills + weightedExperience + weightedLocation + weightedSalary;

  // Clamp to 0–100 and round to nearest integer
  return Math.round(Math.max(0, Math.min(100, total)));
}

// ── Compute recommendation from total score ───────────────────
export function computeRecommendation(
  totalScore: number,
  hasRedFlags: boolean,
): 'YES' | 'MAYBE' | 'NO' {
  // Red flags downgrade recommendation
  if (hasRedFlags && totalScore < 70) return 'NO';
  if (hasRedFlags && totalScore < 85) return 'MAYBE';

  if (totalScore >= 75) return 'YES';
  if (totalScore >= 50) return 'MAYBE';
  return 'NO';
}

// ── Build full DimensionScore with weighted value ─────────────
function buildDimensionScore(
  raw: number,
  weight: number,
  rationale: string,
  signals: string[],
): DimensionScore {
  return {
    raw: Math.round(clamp(raw, 0, 100)),
    weighted: Math.round(raw * (weight / 100) * 10) / 10,
    rationale,
    signals,
  };
}

// ── Assemble full MatchAnalysis ───────────────────────────────
export function buildMatchAnalysis(
  output: ClaudeMatchOutput,
  tokensUsed: number,
  modelUsed: string,
  processingMs: number,
): MatchAnalysis {
  const totalScore = computeWeightedScore(output);
  const hasRedFlags = output.redFlags.length > 0;
  const recommendation = computeRecommendation(totalScore, hasRedFlags);

  return {
    skillsScore: buildDimensionScore(
      output.skillsScore.raw,
      SCORE_WEIGHTS.SKILLS,
      output.skillsScore.rationale,
      output.skillsScore.signals,
    ),
    experienceScore: buildDimensionScore(
      output.experienceScore.raw,
      SCORE_WEIGHTS.EXPERIENCE,
      output.experienceScore.rationale,
      output.experienceScore.signals,
    ),
    locationScore: buildDimensionScore(
      output.locationScore.raw,
      SCORE_WEIGHTS.LOCATION,
      output.locationScore.rationale,
      output.locationScore.signals,
    ),
    salaryScore: buildDimensionScore(
      output.salaryScore.raw,
      SCORE_WEIGHTS.SALARY,
      output.salaryScore.rationale,
      output.salaryScore.signals,
    ),
    totalScore,
    recommendation,
    summary: output.summary,
    missingSkills: output.missingSkills.slice(0, 10),     // Cap at 10 items
    strengthAreas: output.strengthAreas.slice(0, 8),
    redFlags: output.redFlags.slice(0, 5),
    keyHighlights: output.keyHighlights.slice(0, 5),
    tokensUsed,
    modelUsed,
    processingMs,
  };
}

// ── Score breakdown for display ───────────────────────────────
export interface ScoreBreakdown {
  label: string;
  weight: number;
  raw: number;
  weighted: number;
  bar: number;        // 0–100 for progress bar display
  grade: string;      // A+, A, B, C, D, F
}

export function buildScoreBreakdown(analysis: MatchAnalysis): ScoreBreakdown[] {
  return [
    {
      label: 'Skills Match',
      weight: SCORE_WEIGHTS.SKILLS,
      raw: analysis.skillsScore.raw,
      weighted: analysis.skillsScore.weighted,
      bar: analysis.skillsScore.raw,
      grade: toLetterGrade(analysis.skillsScore.raw),
    },
    {
      label: 'Experience',
      weight: SCORE_WEIGHTS.EXPERIENCE,
      raw: analysis.experienceScore.raw,
      weighted: analysis.experienceScore.weighted,
      bar: analysis.experienceScore.raw,
      grade: toLetterGrade(analysis.experienceScore.raw),
    },
    {
      label: 'Location Fit',
      weight: SCORE_WEIGHTS.LOCATION,
      raw: analysis.locationScore.raw,
      weighted: analysis.locationScore.weighted,
      bar: analysis.locationScore.raw,
      grade: toLetterGrade(analysis.locationScore.raw),
    },
    {
      label: 'Salary Alignment',
      weight: SCORE_WEIGHTS.SALARY,
      raw: analysis.salaryScore.raw,
      weighted: analysis.salaryScore.weighted,
      bar: analysis.salaryScore.raw,
      grade: toLetterGrade(analysis.salaryScore.raw),
    },
  ];
}

// ── Helpers ───────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function toLetterGrade(score: number): string {
  if (score >= 93) return 'A+';
  if (score >= 87) return 'A';
  if (score >= 80) return 'A-';
  if (score >= 73) return 'B+';
  if (score >= 67) return 'B';
  if (score >= 60) return 'B-';
  if (score >= 53) return 'C+';
  if (score >= 47) return 'C';
  if (score >= 40) return 'C-';
  if (score >= 33) return 'D+';
  if (score >= 27) return 'D';
  return 'F';
}
