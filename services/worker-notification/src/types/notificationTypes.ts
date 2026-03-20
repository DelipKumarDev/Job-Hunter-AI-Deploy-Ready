// ============================================================
// WhatsApp Notification System — Core Types
// ============================================================

// ── Notification event kinds ──────────────────────────────────
export type NotificationEvent =
  | 'interview_scheduled'       // Full briefing: date, prep, questions
  | 'interview_request'         // Recruiter wants to schedule
  | 'availability_requested'    // Send your availability
  | 'offer_received'            // Job offer arrived
  | 'rejection'                 // Application rejected
  | 'soft_rejection'            // Not right now, kept on file
  | 'application_submitted'     // Bot applied successfully
  | 'follow_up_sent'            // Follow-up email dispatched
  | 'assessment_received'       // Coding test / take-home
  | 'info_requested'            // Recruiter needs docs
  | 'stage_advanced'            // Moved to next round
  | 'daily_digest';             // Morning summary

// ── WhatsApp message types we send ───────────────────────────
export type WaMessageType = 'text' | 'interactive' | 'template';

// ── Interview briefing payload (richest notification) ─────────
export interface InterviewBriefing {
  // Core metadata
  companyName:      string;
  jobTitle:         string;
  recruiterName:    string | null;
  recruiterEmail:   string;

  // Scheduling
  interviewDate:    Date | null;
  interviewTime:    string | null;     // "3:00 PM EST"
  timezone:         string | null;
  format:           string;            // "Phone Screen" / "Video Call" / "Onsite"
  platform:         string | null;     // "Zoom" / "Google Meet"
  meetingLink:      string | null;
  duration:         number | null;     // minutes
  interviewers:     string[];

  // Job details
  jobDescription:   string | null;    // Full text for AI to summarise
  applicationDate:  Date;

  // User context
  candidateName:    string;
  candidatePhone:   string;           // E.164 format: +1234567890
  resumeText:       string | null;    // For personalised question generation
}

// ── AI-generated briefing content ────────────────────────────
export interface GeneratedBriefing {
  companySummary:       string;       // 2–3 sentences about the company
  roleHighlights:       string[];     // 3–4 key responsibilities
  suggestedQuestions:   QuestionSet;
  keyTopics:            string[];     // Technical / domain areas to prepare
  salaryInsight:        string | null;
  cultureInsight:       string | null;
  tokensUsed:           number;
}

export interface QuestionSet {
  behavioural:  string[];   // 3 STAR-format questions
  technical:    string[];   // 3 role-specific technical questions
  toAsk:        string[];   // 3 questions for the interviewer
}

// ── WhatsApp Cloud API types ──────────────────────────────────
export interface WaTextMessage {
  messaging_product: 'whatsapp';
  to:                string;
  type:              'text';
  text:              { body: string; preview_url?: boolean };
}

export interface WaInteractiveMessage {
  messaging_product: 'whatsapp';
  to:                string;
  type:              'interactive';
  interactive: {
    type:   'button';
    body:   { text: string };
    action: {
      buttons: Array<{ type: 'reply'; reply: { id: string; title: string } }>;
    };
  };
}

export interface WaTemplateMessage {
  messaging_product: 'whatsapp';
  to:                string;
  type:              'template';
  template: {
    name:       string;
    language:   { code: string };
    components: WaTemplateComponent[];
  };
}

export interface WaTemplateComponent {
  type:       'header' | 'body' | 'button';
  sub_type?:  'quick_reply' | 'url';
  index?:     number;
  parameters: Array<
    | { type: 'text';     text:     string }
    | { type: 'image';    image:    { link: string } }
    | { type: 'document'; document: { link: string; filename?: string } }
    | { type: 'payload';  payload:  string }
  >;
}

export type WaMessage = WaTextMessage | WaInteractiveMessage | WaTemplateMessage;

// ── Send result ───────────────────────────────────────────────
export interface WaSendResult {
  success:    boolean;
  messageId:  string | null;
  waMessageId: string | null;    // WhatsApp's own ID
  error:      string | null;
  timestamp:  Date;
}

// ── Webhook event (incoming from Meta) ────────────────────────
export interface WaWebhookEntry {
  id:      string;
  changes: Array<{
    value: {
      messaging_product: string;
      metadata:          { display_phone_number: string; phone_number_id: string };
      contacts?:         Array<{ profile: { name: string }; wa_id: string }>;
      messages?:         Array<WaInboundMessage>;
      statuses?:         Array<WaStatusUpdate>;
    };
    field: string;
  }>;
}

export interface WaInboundMessage {
  id:        string;
  from:      string;           // Phone in E.164 without +
  timestamp: string;
  type:      'text' | 'interactive' | 'button';
  text?:     { body: string };
  interactive?: { type: string; button_reply?: { id: string; title: string } };
  button?:   { payload: string; text: string };
}

export interface WaStatusUpdate {
  id:          string;
  status:      'sent' | 'delivered' | 'read' | 'failed';
  timestamp:   string;
  recipient_id: string;
  errors?:     Array<{ code: number; title: string; message: string }>;
}

// ── BullMQ job payload ────────────────────────────────────────
export interface WhatsAppJobPayload {
  userId:         string;
  event:          NotificationEvent;
  briefing?:      InterviewBriefing;
  applicationId?: string;
  rawData?:       Record<string, unknown>;
}
