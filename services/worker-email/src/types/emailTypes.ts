// ============================================================
// Email Follow-Up System — Core Types
// ============================================================

// ── Email account types ───────────────────────────────────────
export type EmailProvider = 'gmail' | 'outlook' | 'imap';

export type EmailClassification =
  | 'interview_invite'
  | 'offer'
  | 'rejection'
  | 'recruiter_reply'
  | 'auto_reply'
  | 'application_received'
  | 'follow_up_sent'
  | 'unrelated'
  | 'unknown';

export type FollowUpStatus =
  | 'pending'
  | 'sent'
  | 'cancelled'
  | 'failed';

export type ThreadStatus =
  | 'active'          // Awaiting response, follow-ups scheduled
  | 'replied'         // Recruiter responded
  | 'interview'       // Interview scheduled
  | 'rejected'        // Rejected
  | 'offered'         // Offer received
  | 'closed';         // No follow-up needed

// ── Raw email from provider ───────────────────────────────────
export interface RawEmail {
  messageId:    string;       // Provider message ID
  threadId:     string;       // Conversation thread ID
  externalId:   string;       // Provider-specific ID
  subject:      string;
  fromEmail:    string;
  fromName:     string | null;
  toEmail:      string;
  toName:       string | null;
  bodyText:     string;       // Plain text
  bodyHtml:     string | null;
  receivedAt:   Date;
  isFromUser:   boolean;      // true = sent by user, false = received
  inReplyTo:    string | null;
  labels:       string[];     // Gmail labels or IMAP flags
}

// ── Classified email thread ───────────────────────────────────
export interface EmailThread {
  id:              string;
  userId:          string;
  applicationId:   string | null;
  externalThreadId: string;
  subject:         string;
  recruiterEmail:  string;
  recruiterName:   string | null;
  companyName:     string | null;
  jobTitle:        string | null;
  classification:  EmailClassification;
  classificationScore: number;    // 0–1
  status:          ThreadStatus;
  lastMessageAt:   Date;
  messageCount:    number;
  followUpCount:   number;
  linkedApplicationId: string | null;
}

// ── Follow-up schedule ────────────────────────────────────────
export interface FollowUpSchedule {
  id:              string;
  userId:          string;
  applicationId:   string;
  threadId:        string | null;
  followUpNumber:  1 | 2 | 3;     // 1=day3, 2=day7, 3=day14
  scheduledAt:     Date;
  sentAt:          Date | null;
  status:          FollowUpStatus;
  emailSubject:    string | null;
  emailBody:       string | null;
  cancelledReason: string | null;
}

// ── Email sync context ────────────────────────────────────────
export interface EmailSyncContext {
  userId:       string;
  accountEmail: string;
  provider:     EmailProvider;
  lastSyncAt:   Date | null;
  accessToken:  string | null;
  refreshToken: string | null;
  imapPassword: string | null;
  imapHost:     string | null;
  imapPort:     number | null;
}

// ── Follow-up generation context ─────────────────────────────
export interface FollowUpContext {
  candidateName:   string;
  candidateEmail:  string;
  jobTitle:        string;
  companyName:     string;
  recruiterName:   string | null;
  recruiterEmail:  string;
  applicationDate: Date;
  followUpNumber:  1 | 2 | 3;
  previousEmails:  Array<{ role: 'sent' | 'received'; content: string; date: Date }>;
  linkedinUrl:     string | null;
  phoneNumber:     string | null;
}

// ── Generated follow-up email ─────────────────────────────────
export interface GeneratedFollowUp {
  subject:    string;
  bodyText:   string;
  bodyHtml:   string;
  tone:       'warm' | 'professional' | 'brief';
  wordCount:  number;
  tokensUsed: number;
}

// ── BullMQ payloads ───────────────────────────────────────────
export interface EmailSyncPayload {
  userId:       string;
  emailAccountId: string;
  fullSync:     boolean;   // true = fetch all, false = incremental
}

export interface FollowUpPayload {
  userId:        string;
  applicationId: string;
  followUpId:    string;
  followUpNumber: 1 | 2 | 3;
}

export interface ClassifyPayload {
  userId:    string;
  messageId: string;
  threadId:  string;
}
