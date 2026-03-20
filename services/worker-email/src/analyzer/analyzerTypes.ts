// ============================================================
// Deep Email Analyzer — Types
// ============================================================

// ── 12 fine-grained response intents ─────────────────────────
export type ResponseIntent =
  // ★ Interview / scheduling
  | 'interview_scheduled'      // Date + time confirmed
  | 'interview_request'        // "Would you be available for a call?"
  | 'availability_request'     // "Please share your availability"
  | 'calendar_link_sent'       // Calendly / cal.com link

  // ★ Positive progression
  | 'request_for_information'  // Need docs, references, portfolio
  | 'offer_extended'           // Formal or informal offer
  | 'moved_to_next_stage'      // "Moving forward" but vague
  | 'assessment_sent'          // Coding test / take-home link

  // ★ Negative / neutral
  | 'rejection'                // Definitive no
  | 'rejection_soft'           // "Not a fit right now" but door open
  | 'auto_reply'               // OOO, bounce, automation
  | 'unclassified';            // None of the above

// ── Interview types ───────────────────────────────────────────
export type InterviewFormat =
  | 'phone_screen'
  | 'video_call'
  | 'technical_interview'
  | 'take_home_assessment'
  | 'onsite'
  | 'panel'
  | 'informal_chat'
  | 'unknown';

// ── Extracted datetime ────────────────────────────────────────
export interface ExtractedDatetime {
  rawText:      string;         // Original text from email: "Tuesday Feb 25 at 3pm EST"
  isoDatetime:  string | null;  // ISO 8601 with offset: "2026-02-25T15:00:00-05:00"
  timezone:     string | null;  // IANA zone: "America/New_York"
  isRange:      boolean;        // "between 2pm and 4pm"
  rangeEnd?:    string;         // ISO end if range
  confidence:   number;         // 0–1
  isConfirmed:  boolean;        // true = definite, false = proposed/tentative
}

// ── Extracted meeting details ─────────────────────────────────
export interface MeetingDetails {
  format:        InterviewFormat;
  platform:      string | null;     // "Zoom", "Google Meet", "Teams", "Phone"
  meetingLink:   string | null;     // Full URL
  dialInNumber:  string | null;
  calendarLink:  string | null;     // Calendly / cal.com URL
  duration:      number | null;     // Minutes
  interviewers:  string[];          // Names extracted from email
  notes:         string | null;     // Additional context
}

// ── Extracted entities ────────────────────────────────────────
export interface ExtractedEntities {
  companyName:    string | null;
  jobTitle:       string | null;
  recruiterName:  string | null;
  recruiterTitle: string | null;    // "Head of Talent", "Sr. Recruiter"
  hiringManager:  string | null;
  location:       string | null;    // Office city or "Remote"

  // For information requests
  requestedDocuments: string[];     // "references", "portfolio", "transcript"
  deadlineText:       string | null;

  // For assessments
  assessmentLink:     string | null;
  assessmentDeadline: string | null;

  // For offers
  salaryMentioned:    string | null;
  startDateMentioned: string | null;
}

// ── Full analysis result ──────────────────────────────────────
export interface EmailAnalysisResult {
  // Core
  emailId:        string;
  threadId:       string;
  analyzedAt:     Date;

  // Classification
  intent:         ResponseIntent;
  confidence:     number;           // 0–1
  method:         'regex' | 'heuristic' | 'claude';

  // Sentiment
  sentiment:      'very_positive' | 'positive' | 'neutral' | 'negative' | 'very_negative';
  sentimentScore: number;           // -1 to +1
  urgency:        'high' | 'medium' | 'low';

  // Structured extractions
  datetime:       ExtractedDatetime | null;
  meeting:        MeetingDetails | null;
  entities:       ExtractedEntities;

  // DB actions taken
  actionsApplied: ApplicationAction[];

  // Raw Claude output (for debugging)
  rawExtraction:  Record<string, unknown> | null;
  tokensUsed:     number;
}

// ── DB write actions ──────────────────────────────────────────
export type ApplicationAction =
  | { type: 'status_updated';       from: string; to: string }
  | { type: 'interview_created';    interviewId: string; scheduledAt: string }
  | { type: 'interview_updated';    interviewId: string; field: string; value: string }
  | { type: 'followups_cancelled';  count: number; reason: string }
  | { type: 'notification_sent';    channel: string }
  | { type: 'application_linked';   applicationId: string }
  | { type: 'document_requested';   documents: string[] };

// ── BullMQ job payload ────────────────────────────────────────
export interface AnalyzeEmailPayload {
  userId:      string;
  emailId:     string;    // DB id of email_threads record
  threadId:    string;    // externalThreadId from provider
  rawBody:     string;
  subject:     string;
  fromEmail:   string;
  fromName:    string | null;
  receivedAt:  string;    // ISO
  applicationId: string | null;
}
