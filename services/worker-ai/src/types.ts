// ============================================================
// AI Match Engine — Types & Interfaces
// All types used across the matching pipeline
// ============================================================

// ── Scoring weights (must sum to 100) ─────────────────────────
export const SCORE_WEIGHTS = {
  SKILLS: 40,        // Technical + domain skill alignment
  EXPERIENCE: 30,    // Seniority, years, relevance of past roles
  LOCATION: 20,      // Geographic fit + remote preference
  SALARY: 10,        // Compensation range alignment
} as const;

export type ScoreWeightKey = keyof typeof SCORE_WEIGHTS;

// ── Individual dimension scores ───────────────────────────────
export interface DimensionScore {
  raw: number;           // 0–100 raw score for this dimension
  weighted: number;      // raw * (weight/100)
  rationale: string;     // Human-readable explanation
  signals: string[];     // Specific evidence for this score
}

// ── Full match analysis result from Claude ────────────────────
export interface MatchAnalysis {
  // Dimension scores
  skillsScore: DimensionScore;
  experienceScore: DimensionScore;
  locationScore: DimensionScore;
  salaryScore: DimensionScore;

  // Final composite score (0–100)
  totalScore: number;

  // Recommendation
  recommendation: 'YES' | 'MAYBE' | 'NO';

  // Actionable insight
  summary: string;
  missingSkills: string[];
  strengthAreas: string[];
  redFlags: string[];
  keyHighlights: string[];

  // Token usage tracking
  tokensUsed: number;
  modelUsed: string;
  processingMs: number;
}

// ── Candidate profile passed to scorer ───────────────────────
export interface CandidateProfile {
  userId: string;

  // Identity
  firstName: string;
  lastName: string;
  headline: string | null;
  currentTitle: string | null;
  yearsExperience: number | null;
  seniorityLevel: string | null;
  bio: string | null;

  // Location
  location: string | null;
  country: string | null;

  // Skills
  skills: Array<{
    name: string;
    proficiency: string;
    category: string | null;
  }>;

  // Experience summary
  experienceSummary: string | null;

  // Resume text (parsed from PDF)
  resumeText: string | null;

  // Preferences
  preferences: {
    targetRoles: string[];
    preferredLocations: string[];
    remotePreference: string;
    salaryMin: number | null;
    salaryMax: number | null;
    salaryCurrency: string;
    jobTypes: string[];
    minMatchScore: number;
  } | null;
}

// ── Job listing passed to scorer ──────────────────────────────
export interface JobListingForMatch {
  id: string;
  title: string;
  company: string;
  location: string | null;
  country: string | null;
  remoteType: string | null;
  jobType: string | null;
  description: string;
  requirements: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  sourcePlatform: string;
  experienceLevel: string | null;
}

// ── Match queue job payload ────────────────────────────────────
export interface AiMatchPayload {
  userId: string;
  jobListingId: string;
  forceRescore?: boolean;
}

// ── Match result stored in DB ─────────────────────────────────
export interface StoredMatchResult {
  id: string;
  userId: string;
  jobListingId: string;
  matchScore: number;
  recommendation: 'YES' | 'MAYBE' | 'NO';
  skillsScore: number;
  experienceScore: number;
  locationScore: number;
  salaryScore: number;
  missingSkills: string[];
  strengthAreas: string[];
  summary: string | null;
  tokensUsed: number | null;
  createdAt: Date;
}

// ── Score threshold configuration ────────────────────────────
export interface ThresholdConfig {
  autoApply: number;     // Above this → queue for auto-application
  recommend: number;     // Above this → show as recommended to user
  hide: number;          // Below this → don't show to user at all
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  autoApply: 75,
  recommend: 60,
  hide: 30,
};

// ── Batch match request ───────────────────────────────────────
export interface BatchMatchRequest {
  userId: string;
  jobIds: string[];
  forceRescore?: boolean;
}

export interface BatchMatchResult {
  userId: string;
  processed: number;
  skipped: number;       // Already scored, no forceRescore
  failed: number;
  qualifiedForApply: number;  // Above autoApply threshold
  totalTokensUsed: number;
  durationMs: number;
}
