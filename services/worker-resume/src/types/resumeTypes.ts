// ============================================================
// Resume Intelligence Engine — Core Types
// Complete type system for extraction pipeline and
// the canonical CandidateProfile JSON structure
// ============================================================

// ── Queue payload ─────────────────────────────────────────────
export interface ResumeParsePayload {
  resumeId: string;
  userId: string;
  s3Url: string;
  fileType: 'pdf' | 'docx';
  version: number;
  forceReparse?: boolean;
}

// ─────────────────────────────────────────────────────────────
// CANONICAL CANDIDATE PROFILE
// The structured output of the NLP extraction pipeline.
// This is persisted as JSONB in the resumes table.
// ─────────────────────────────────────────────────────────────
export interface CandidateProfile {
  // ── Identity ──────────────────────────────────────────────
  name:             string | null;
  email:            string | null;
  phone:            string | null;
  location:         string | null;
  linkedinUrl:      string | null;
  githubUrl:        string | null;
  portfolioUrl:     string | null;

  // ── Career summary ─────────────────────────────────────────
  summary:          string | null;       // Professional summary / objective
  currentTitle:     string | null;       // Most recent job title
  seniorityLevel:   SeniorityLevel;
  experience_years: number;              // Total years of professional experience
  roles:            string[];            // All unique job titles held
  industries:       string[];            // Inferred industry sectors

  // ── Skills (flat list for embedding, categorised for display) ──
  skills:           Skill[];
  skills_flat:      string[];            // ["React", "Python", "AWS", …]

  // ── Technologies (tools, frameworks, platforms) ───────────
  technologies:     Technology[];
  technologies_flat: string[];

  // ── Experience (structured work history) ──────────────────
  experience:       WorkExperience[];

  // ── Education ─────────────────────────────────────────────
  education:        Education[];
  highest_degree:   DegreeLevel | null;

  // ── Certifications / Licenses ──────────────────────────────
  certifications:   Certification[];

  // ── Languages ─────────────────────────────────────────────
  languages:        Language[];

  // ── Extraction metadata ────────────────────────────────────
  _meta: ExtractionMeta;
}

// ── Individual skill ──────────────────────────────────────────
export interface Skill {
  name:        string;
  category:    SkillCategory;
  proficiency: ProficiencyLevel;
  yearsUsed:   number | null;
  explicit:    boolean;      // true = mentioned in resume, false = inferred
}

// ── Technology / tool ─────────────────────────────────────────
export interface Technology {
  name:     string;
  type:     TechType;
  version:  string | null;    // e.g. "React 18", "Python 3.11"
}

// ── Work experience entry ─────────────────────────────────────
export interface WorkExperience {
  title:          string;
  company:        string;
  location:       string | null;
  startDate:      string | null;    // "2020-03" or "2020" or null
  endDate:        string | null;    // null = current
  isCurrent:      boolean;
  durationMonths: number | null;    // Computed from dates
  description:    string | null;    // Raw bullet points
  achievements:   string[];         // Extracted achievement sentences
  skills:         string[];         // Skills mentioned in this role
  technologies:   string[];         // Tech mentioned in this role
}

// ── Education entry ───────────────────────────────────────────
export interface Education {
  institution:  string;
  degree:       string | null;
  field:        string | null;
  level:        DegreeLevel;
  startYear:    number | null;
  endYear:      number | null;
  gpa:          number | null;
  honors:       string | null;
}

// ── Certification ─────────────────────────────────────────────
export interface Certification {
  name:         string;
  issuer:       string | null;
  issuedDate:   string | null;
  expiryDate:   string | null;
  credentialId: string | null;
}

// ── Language ──────────────────────────────────────────────────
export interface Language {
  name:        string;
  proficiency: 'Native' | 'Fluent' | 'Professional' | 'Conversational' | 'Basic';
}

// ── Extraction metadata ───────────────────────────────────────
export interface ExtractionMeta {
  extractedAt:    string;       // ISO timestamp
  modelUsed:      string;
  tokensUsed:     number;
  parserVersion:  string;
  rawTextLength:  number;
  confidence:     number;       // 0–1, overall extraction confidence
  warnings:       string[];     // Non-fatal issues during extraction
}

// ─────────────────────────────────────────────────────────────
// ENUMS & LITERAL TYPES
// ─────────────────────────────────────────────────────────────

export type SeniorityLevel =
  | 'student'
  | 'entry'
  | 'junior'
  | 'mid'
  | 'senior'
  | 'lead'
  | 'principal'
  | 'staff'
  | 'director'
  | 'vp'
  | 'c_level'
  | 'unknown';

export type ProficiencyLevel =
  | 'expert'
  | 'advanced'
  | 'intermediate'
  | 'beginner'
  | 'exposure';

export type SkillCategory =
  | 'programming_language'
  | 'framework'
  | 'database'
  | 'cloud'
  | 'devops'
  | 'testing'
  | 'design'
  | 'data_science'
  | 'security'
  | 'mobile'
  | 'soft_skill'
  | 'domain_knowledge'
  | 'tool'
  | 'methodology'
  | 'other';

export type TechType =
  | 'language'
  | 'framework'
  | 'library'
  | 'database'
  | 'cloud_service'
  | 'devops_tool'
  | 'platform'
  | 'api'
  | 'protocol'
  | 'tool'
  | 'other';

export type DegreeLevel =
  | 'phd'
  | 'masters'
  | 'bachelors'
  | 'associates'
  | 'diploma'
  | 'bootcamp'
  | 'certification'
  | 'high_school'
  | 'other';

// ─────────────────────────────────────────────────────────────
// EMBEDDING TYPES
// ─────────────────────────────────────────────────────────────

export interface ResumeEmbedding {
  resumeId:    string;
  userId:      string;
  vector:      number[];           // 1536-dim text-embedding-3-small
  dimensions:  number;
  model:       string;
  textUsed:    string;             // The text that was embedded
  createdAt:   string;
}

// Different embedding strategies for different use cases
export type EmbeddingStrategy =
  | 'full_text'          // Entire resume text (best for overall matching)
  | 'skills_only'        // Skills + tech flat list (fast skill matching)
  | 'experience_summary' // Role titles + company + dates (career trajectory)
  | 'combined';          // Weighted combination of above

// ─────────────────────────────────────────────────────────────
// PARSING INTERMEDIATES
// ─────────────────────────────────────────────────────────────

export interface RawResumeText {
  full:     string;              // Complete extracted text
  sections: ResumeSection[];    // Detected sections
  metadata: {
    pageCount:   number;
    wordCount:   number;
    charCount:   number;
    hasStructure: boolean;       // Was there clear section structure?
  };
}

export interface ResumeSection {
  title:    string;              // "Experience", "Skills", "Education" etc.
  content:  string;              // Raw text of the section
  type:     SectionType;
}

export type SectionType =
  | 'contact'
  | 'summary'
  | 'experience'
  | 'education'
  | 'skills'
  | 'certifications'
  | 'projects'
  | 'languages'
  | 'awards'
  | 'publications'
  | 'volunteer'
  | 'unknown';

// ─────────────────────────────────────────────────────────────
// FULL PIPELINE RESULT
// ─────────────────────────────────────────────────────────────

export interface ResumeIntelligenceResult {
  resumeId:         string;
  userId:           string;
  profile:          CandidateProfile;
  embedding:        ResumeEmbedding | null;
  skillsExtracted:  number;
  techExtracted:    number;
  rolesExtracted:   number;
  educationCount:   number;
  experienceYears:  number;
  processingMs:     number;
  tokensUsed:       number;
}
