// ============================================================
// Interview Prep + Resume Tailor — Type System
// ============================================================

// ── Input ─────────────────────────────────────────────────────
export interface PrepInput {
  userId:         string;
  applicationId:  string;

  // Source data
  jobDescription: string;
  companyName:    string;
  jobTitle:       string;
  companyContext: string | null;   // Extra info (Crunchbase, LinkedIn, news)

  // Candidate
  resumeText:     string;
  resumeJson:     ParsedResume | null;

  // Options
  interviewFormat: InterviewFormat;
  seniority:       SeniorityLevel;
  includeResumeTailor: boolean;
}

export type InterviewFormat =
  | 'phone_screen'
  | 'technical'
  | 'behavioral'
  | 'system_design'
  | 'case_study'
  | 'panel'
  | 'final_round'
  | 'general';

export type SeniorityLevel = 'junior' | 'mid' | 'senior' | 'staff' | 'principal' | 'director';

// ── Parsed resume structure ───────────────────────────────────
export interface ParsedResume {
  name:         string | null;
  email:        string | null;
  phone:        string | null;
  location:     string | null;
  linkedinUrl:  string | null;
  summary:      string | null;
  experience:   WorkExperience[];
  education:    Education[];
  skills:       SkillGroup[];
  projects:     Project[];
  certifications: string[];
  languages:    string[];
}

export interface WorkExperience {
  company:      string;
  title:        string;
  startDate:    string;
  endDate:      string | null;   // null = present
  location:     string | null;
  bullets:      string[];        // Achievement bullets
  technologies: string[];
}

export interface Education {
  institution:  string;
  degree:       string;
  field:        string | null;
  startYear:    number | null;
  endYear:      number | null;
  gpa:          string | null;
  honors:       string | null;
}

export interface SkillGroup {
  category:  string;   // "Languages", "Frameworks", "Cloud"
  skills:    string[];
}

export interface Project {
  name:         string;
  description:  string;
  technologies: string[];
  url:          string | null;
}

// ── Interview questions ───────────────────────────────────────
export type QuestionCategory =
  | 'behavioral'         // STAR-format soft skills
  | 'technical'          // Role/stack-specific
  | 'system_design'      // Architecture and scale
  | 'culture_fit'        // Values, working style
  | 'situational'        // Hypothetical scenarios
  | 'role_specific'      // JD-derived specifics
  | 'company_knowledge'  // "Why us?" / product questions
  | 'closing';           // Questions TO ask them

export interface InterviewQuestion {
  id:           string;
  category:     QuestionCategory;
  question:     string;
  difficulty:   'easy' | 'medium' | 'hard';
  frequency:    'common' | 'likely' | 'curveball';
  rationale:    string;    // Why this question will likely come up
  timeLimit:    number;    // Suggested answer time in seconds
  followUps:    string[];  // Likely follow-up questions
}

// ── Suggested answers ─────────────────────────────────────────
export interface SuggestedAnswer {
  questionId:    string;
  format:        'STAR' | 'direct' | 'structured' | 'narrative';
  answer:        string;
  keyPoints:     string[];    // 3–5 things to hit
  avoidPoints:   string[];    // Pitfalls to dodge
  customisedFor: string;      // "Tailored using your [company] experience"
  strengthsUsed: string[];    // From candidate's resume
  wordCount:     number;
}

// ── Technical preparation topics ─────────────────────────────
export interface PrepTopic {
  id:          string;
  area:        string;        // "Distributed Systems", "React", "SQL Optimisation"
  priority:    'critical' | 'high' | 'medium' | 'nice_to_have';
  source:      'jd_explicit' | 'jd_implied' | 'company_stack' | 'role_standard';
  description: string;
  subtopics:   string[];
  resources:   PrepResource[];
  estimatedHours: number;
}

export interface PrepResource {
  type:  'documentation' | 'article' | 'video' | 'practice' | 'book';
  title: string;
  url:   string | null;
}

// ── Company analysis ──────────────────────────────────────────
export interface CompanyAnalysis {
  name:          string;
  oneLiner:      string;
  productSummary: string;
  techStack:     string[];
  culture:       string[];     // Culture signals from JD and research
  recentNews:    string[];     // From web search
  interviewStyle: string;      // Known interview process
  values:        string[];
  competitors:   string[];
  growthStage:   string | null; // "Series B", "Public", "Bootstrapped"
}

// ── Tailored resume ───────────────────────────────────────────
export interface TailoredResume {
  originalResumeId: string;
  targetJobTitle:   string;
  targetCompany:    string;

  // Modified content
  tailoredSummary:    string;
  tailoredExperience: TailoredExperience[];
  tailoredSkills:     SkillGroup[];
  addedKeywords:      string[];
  removedContent:     string[];
  atsScore:           number;       // 0–100 predicted ATS match
  improvementNotes:   string[];     // What was changed and why
}

export interface TailoredExperience extends WorkExperience {
  originalBullets:  string[];   // Before tailoring
  changedBullets:   number;     // Count of modified bullets
}

// ── Full prep package ─────────────────────────────────────────
export interface PrepPackage {
  id:              string;
  userId:          string;
  applicationId:   string;
  generatedAt:     Date;

  companyAnalysis: CompanyAnalysis;
  questions:       InterviewQuestion[];
  answers:         SuggestedAnswer[];
  topics:          PrepTopic[];
  tailoredResume:  TailoredResume | null;

  // Meta
  totalQuestions:  number;
  tokensUsed:      number;
  generationMs:    number;
  pdfUrl:          string | null;  // S3 URL of generated PDF
}

// ── BullMQ payload ────────────────────────────────────────────
export interface PrepJobPayload {
  userId:         string;
  applicationId:  string;
  prepInputId:    string;   // DB record ID to load full input from
}

// ── Resume Tailor Queue Payload ───────────────────────────────
export interface ResumeTailorPayload {
  userId:         string;
  resumeId:       string;
  jobListingId:   string;
  applicationId?: string;
}
