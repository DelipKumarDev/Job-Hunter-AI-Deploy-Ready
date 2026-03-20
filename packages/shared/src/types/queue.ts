// ============================================================
// Shared Queue Payload Types
// Single source of truth for all BullMQ job payloads.
// Both producers (API) and consumers (workers) import from here.
// ============================================================

// ── Discovery / Scraper ───────────────────────────────────────
export interface DiscoveryJobPayload {
  userId:    string;
  runId:     string;
  platforms: string[];
  config: {
    userId:                string;
    platforms:             string[];
    keywords:              string[];
    location?:             string;
    remote?:               boolean;
    maxResultsPerPlatform?: number;
  };
}

// ── AI Match ──────────────────────────────────────────────────
export interface AiMatchJobPayload {
  userId:       string;
  jobListingId: string;
  forceRescore?: boolean;
}

// ── Bot Apply ─────────────────────────────────────────────────
export interface BotApplyJobPayload {
  userId:        string;
  applicationId: string;
  jobListingId:  string;
  applyUrl:      string;
  resumeId:      string;
  coverLetterId?: string;
}

// ── Email Monitor ─────────────────────────────────────────────
export interface EmailMonitorJobPayload {
  userId:         string;
  emailAccountId: string;
}

// ── Follow-up ─────────────────────────────────────────────────
export interface FollowUpJobPayload {
  userId:          string;
  applicationId:   string;
  followUpId:      string;
  followUpNumber:  number;
}

// ── Notification ──────────────────────────────────────────────
export interface NotificationJobPayload {
  userId:         string;
  event:          string;
  briefing?:      Record<string, unknown>;
  applicationId?: string;
  rawData?:       Record<string, unknown>;
}

// ── Resume Tailor ─────────────────────────────────────────────
export interface ResumeTailorJobPayload {
  userId:        string;
  resumeId:      string;
  jobListingId:  string;
  applicationId?: string;
}

// ── Interview Prep ────────────────────────────────────────────
export interface InterviewPrepJobPayload {
  userId:        string;
  applicationId: string;
  jobListingId:  string;
  resumeId:      string;
}
