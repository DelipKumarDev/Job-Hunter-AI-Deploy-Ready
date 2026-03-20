// ============================================================
// Job Discovery Engine — Core Types
// The NormalisedJob is the single canonical JSON format all
// scrapers must produce. All downstream consumers (AI matcher,
// notification engine, dashboard) read this format only.
// ============================================================

export type JobPlatform =
  | 'linkedin' | 'indeed' | 'naukri' | 'wellfound'
  | 'greenhouse' | 'lever' | 'workday' | 'ashby'
  | 'smartrecruiters' | 'bamboohr' | 'company_page' | 'unknown';

export type JobType       = 'full_time' | 'part_time' | 'contract' | 'internship' | 'freelance' | 'unknown';
export type RemoteType    = 'remote' | 'hybrid' | 'onsite' | 'unknown';
export type ExperienceLevel = 'entry' | 'mid' | 'senior' | 'lead' | 'executive' | 'unknown';

// ─────────────────────────────────────────────────────────────
// THE CANONICAL NORMALISED JOB FORMAT
// Every scraper produces this. Stored in job_listings table.
// ─────────────────────────────────────────────────────────────
export interface NormalisedJob {
  // ── Identity ──────────────────────────────────────────────
  job_title:     string;
  company:       string;
  platform:      JobPlatform;
  source_job_id: string | null;   // Platform's own ID (e.g. LinkedIn job ID)
  content_hash:  string;          // SHA-256 of title+company+url — dedup key

  // ── Location ──────────────────────────────────────────────
  location:      string | null;   // Raw location string
  city:          string | null;
  country:       string | null;
  remote_type:   RemoteType;

  // ── Role details ──────────────────────────────────────────
  description:      string | null;   // Full job description (HTML-stripped)
  requirements:     string | null;   // Requirements section if separate
  job_type:         JobType;
  experience_level: ExperienceLevel;

  // ── Salary ────────────────────────────────────────────────
  salary: {
    raw:          string | null;   // Original string e.g. "$120k–$150k/yr"
    min:          number | null;   // Normalised annual amount
    max:          number | null;
    currency:     string | null;   // "USD" | "INR" | "GBP" | "EUR" etc.
    period:       'annual' | 'monthly' | 'hourly' | 'unknown';
    is_estimated: boolean;         // true when marked as estimated
  };

  // ── Links ─────────────────────────────────────────────────
  apply_link:       string;
  company_logo_url: string | null;

  // ── Timing ────────────────────────────────────────────────
  posted_at:  Date | null;   // Parsed from "3 days ago", ISO date, etc.
  scraped_at: Date;
  is_active:  boolean;
}

// ─────────────────────────────────────────────────────────────
// RAW JOB — what each scraper returns before normalisation
// ─────────────────────────────────────────────────────────────
export interface RawJob {
  // Required
  job_title:  string;
  company:    string;
  apply_link: string;
  platform:   JobPlatform;
  scraped_at: string;             // ISO timestamp

  // Optional — normaliser handles null
  location:        string | null;
  salary_raw:      string | null;
  description:     string | null;
  requirements:    string | null;
  posted_date_raw: string | null;
  job_type_raw:    string | null;
  remote_raw:      string | null;
  experience_raw:  string | null;
  source_job_id:   string | null;
  company_logo_url: string | null;
}

// ─────────────────────────────────────────────────────────────
// SCRAPER CONFIG — built from user's job preferences
// ─────────────────────────────────────────────────────────────
export interface ScraperConfig {
  userId:               string;
  keywords:             string[];     // ["Senior React Developer", "Frontend Engineer"]
  locations:            string[];     // ["Remote", "Bangalore", "New York"]
  experienceLevel:      ExperienceLevel;
  jobTypes:             JobType[];
  remoteOnly:           boolean;
  excludedCompanies:    string[];
  salaryMin:            number | null;
  platforms:            JobPlatform[];
  maxResultsPerPlatform: number;      // Default 50
}

// ─────────────────────────────────────────────────────────────
// SCRAPER INTERFACE — all scrapers implement this
// ─────────────────────────────────────────────────────────────
export interface JobScraper {
  readonly platform:    JobPlatform;
  readonly displayName: string;
  readonly baseDelay:   number;       // ms between requests

  /** Stream raw jobs — caller normalises them */
  scrape(config: ScraperConfig): AsyncGenerator<RawJob>;
}

// ─────────────────────────────────────────────────────────────
// DISCOVERY RUN RESULT
// ─────────────────────────────────────────────────────────────
export interface ScrapeRunResult {
  userId:        string;
  platform:      JobPlatform;
  jobsFound:     number;
  jobsNew:       number;
  jobsDuplicate: number;
  jobsFailed:    number;
  durationMs:    number;
  errors:        string[];
  ranAt:         Date;
}

// ─────────────────────────────────────────────────────────────
// QUEUE PAYLOADS
// ─────────────────────────────────────────────────────────────
export interface DiscoveryQueuePayload {
  userId:   string;
  platform: JobPlatform;
  config:   ScraperConfig;
  runId:    string;
}
