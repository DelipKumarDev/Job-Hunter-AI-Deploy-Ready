// ============================================================
// Application Automation Bot — Core Types
// ============================================================

export type ApplicationStatus =
  | 'queued' | 'starting' | 'navigating' | 'detecting_form'
  | 'filling_form' | 'uploading_files' | 'submitting'
  | 'applied' | 'failed' | 'skipped' | 'already_applied';

export type FieldCategory =
  | 'first_name' | 'last_name' | 'full_name' | 'email' | 'phone'
  | 'linkedin' | 'github' | 'portfolio' | 'location' | 'city'
  | 'state' | 'country' | 'zip' | 'address'
  | 'resume' | 'cover_letter' | 'work_sample'
  | 'years_experience' | 'current_company' | 'current_title' | 'salary_expectation'
  | 'start_date' | 'notice_period' | 'availability'
  | 'work_authorization' | 'require_sponsorship' | 'relocation'
  | 'gender' | 'ethnicity' | 'veteran' | 'disability'    // EEO — always decline
  | 'education_level' | 'school' | 'degree' | 'graduation_year'
  | 'cover_letter_text' | 'summary' | 'headline'
  | 'remote_preference' | 'willing_to_travel'
  | 'referral_source' | 'heard_about_us'
  | 'custom_question'
  | 'unknown';

export type FieldType =
  | 'text' | 'email' | 'tel' | 'number' | 'date' | 'url'
  | 'textarea' | 'select' | 'radio' | 'checkbox' | 'file'
  | 'hidden' | 'unknown';

// ── Detected form field ───────────────────────────────────────
export interface DetectedField {
  selector:    string;        // CSS selector to locate element
  label:       string;        // Human-readable label text
  category:    FieldCategory;
  fieldType:   FieldType;
  isRequired:  boolean;
  options?:    string[];      // For select/radio/checkbox
  placeholder?: string;
  currentValue?: string;
  confidence:  number;        // 0–1 confidence of category detection
}

// ── Form step ─────────────────────────────────────────────────
export interface FormStep {
  stepNumber:  number;
  totalSteps:  number | null;
  title:       string | null;
  fields:      DetectedField[];
  hasNextBtn:  boolean;
  hasPrevBtn:  boolean;
  isReview:    boolean;       // Final review/confirm step
}

// ── Candidate data assembled from DB ─────────────────────────
export interface CandidateFormData {
  // Identity
  firstName:    string;
  lastName:     string;
  fullName:     string;
  email:        string;
  phone:        string | null;
  location:     string | null;
  city:         string | null;
  country:      string | null;

  // Online presence
  linkedinUrl:  string | null;
  githubUrl:    string | null;
  portfolioUrl: string | null;

  // Career
  currentTitle: string | null;
  currentCompany: string | null;
  yearsExperience: number | null;
  educationLevel:  string | null;
  school:          string | null;
  degree:          string | null;
  graduationYear:  number | null;

  // Preferences
  salaryExpectation: number | null;
  noticePeriod:      string | null;
  workAuthorization: string;    // "Yes" / "No"
  requireSponsorship: string;   // "Yes" / "No"
  willingToRelocate: string;    // "Yes" / "No"
  remotePreference:  string;    // "Remote" / "Hybrid" / "Onsite"

  // Files
  resumeS3Url:      string;
  coverLetterS3Url: string | null;
  resumeFileName:   string;
  coverLetterFileName: string | null;

  // Text content
  coverLetterText:  string | null;
  professionalSummary: string | null;
}

// ── Bot session ───────────────────────────────────────────────
export interface BotSession {
  sessionId:    string;
  userId:       string;
  jobListingId: string;
  applyUrl:     string;
  candidate:    CandidateFormData;
  startedAt:    Date;
}

// ── Bot run result ────────────────────────────────────────────
export interface BotRunResult {
  sessionId:      string;
  status:         ApplicationStatus;
  screenshotUrl:  string | null;
  fieldsDetected: number;
  fieldsFilled:   number;
  stepsCompleted: number;
  durationMs:     number;
  error:          string | null;
  warnings:       string[];
}

// ── Queue payload ─────────────────────────────────────────────
export interface BotJobPayload {
  userId:       string;
  applicationId: string;
  jobListingId: string;
  applyUrl:     string;
  resumeId:     string;
  coverLetterId?: string;
}
