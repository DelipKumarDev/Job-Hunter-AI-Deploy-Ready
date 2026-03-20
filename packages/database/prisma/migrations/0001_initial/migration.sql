-- ============================================================
-- Job Hunter AI — Initial Database Migration
-- Generated from Prisma schema v1.0
-- ============================================================

-- Enums
CREATE TYPE "UserRole"             AS ENUM ('USER', 'ADMIN');
CREATE TYPE "SkillProficiency"     AS ENUM ('BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT');
CREATE TYPE "JobType"              AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'FREELANCE', 'INTERNSHIP');
CREATE TYPE "RemoteType"           AS ENUM ('REMOTE', 'HYBRID', 'ON_SITE');
CREATE TYPE "JobSource"            AS ENUM ('LINKEDIN','INDEED','NAUKRI','WELLFOUND','COMPANY_PAGE','GLASSDOOR','OTHER');
CREATE TYPE "MatchRecommendation"  AS ENUM ('YES', 'MAYBE', 'NO');
CREATE TYPE "ApplicationStatus"    AS ENUM ('PENDING','APPLYING','APPLIED','UNDER_REVIEW','INTERVIEW','OFFER','REJECTED','WITHDRAWN','FAILED');
CREATE TYPE "EmailClassification"  AS ENUM ('RECRUITER_REPLY','INTERVIEW_INVITE','REJECTION','AUTO_RESPONSE','OFFER_LETTER','REQUEST_FOR_INFO','OTHER');
CREATE TYPE "FollowUpStatus"       AS ENUM ('SCHEDULED', 'SENT', 'FAILED', 'CANCELLED');
CREATE TYPE "InterviewType"        AS ENUM ('PHONE_SCREEN','VIDEO_CALL','TECHNICAL','BEHAVIORAL','PANEL','ONSITE','FINAL_ROUND');
CREATE TYPE "InterviewStatus"      AS ENUM ('SCHEDULED','CONFIRMED','COMPLETED','CANCELLED','NO_SHOW');
CREATE TYPE "SubscriptionStatus"   AS ENUM ('ACTIVE','TRIALING','PAST_DUE','CANCELED','INCOMPLETE');
CREATE TYPE "SubscriptionPlan"     AS ENUM ('FREE','STARTER','PROFESSIONAL','ENTERPRISE');

-- Users
CREATE TABLE "users" (
    "id"            TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "email"         TEXT        NOT NULL UNIQUE,
    "password_hash" TEXT,
    "name"          TEXT        NOT NULL,
    "role"          "UserRole"  NOT NULL DEFAULT 'USER',
    "is_active"     BOOLEAN     NOT NULL DEFAULT true,
    "email_verified" BOOLEAN    NOT NULL DEFAULT false,
    "google_id"     TEXT,
    "avatar_url"    TEXT,
    "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- Profiles
CREATE TABLE "profiles" (
    "id"               TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "user_id"          TEXT        NOT NULL UNIQUE,
    "phone"            TEXT,
    "whatsapp_number"  TEXT,
    "location"         TEXT,
    "linkedin_url"     TEXT,
    "github_url"       TEXT,
    "portfolio_url"    TEXT,
    "bio"              TEXT,
    "years_experience" INTEGER,
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- Resumes
CREATE TABLE "resumes" (
    "id"            TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "user_id"       TEXT        NOT NULL,
    "file_name"     TEXT        NOT NULL,
    "file_url"      TEXT        NOT NULL,
    "file_type"     TEXT        NOT NULL,
    "file_size"     INTEGER,
    "is_primary"    BOOLEAN     NOT NULL DEFAULT false,
    "parsed_at"     TIMESTAMPTZ,
    "full_text"     TEXT,
    "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "resumes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "resumes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- Job Preferences
CREATE TABLE "job_preferences" (
    "id"                      TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "user_id"                 TEXT        NOT NULL UNIQUE,
    "target_roles"            TEXT[]      NOT NULL DEFAULT '{}',
    "target_companies"        TEXT[]      NOT NULL DEFAULT '{}',
    "excluded_companies"      TEXT[]      NOT NULL DEFAULT '{}',
    "locations"               TEXT[]      NOT NULL DEFAULT '{}',
    "remote_preference"       "RemoteType" NOT NULL DEFAULT 'REMOTE',
    "min_salary"              INTEGER,
    "max_salary"              INTEGER,
    "job_types"               "JobType"[] NOT NULL DEFAULT '{}',
    "platforms"               "JobSource"[] NOT NULL DEFAULT '{}',
    "min_match_score"         INTEGER     NOT NULL DEFAULT 60,
    "max_applications_per_day" INTEGER    NOT NULL DEFAULT 10,
    "auto_apply"              BOOLEAN     NOT NULL DEFAULT false,
    "keywords"                TEXT[]      NOT NULL DEFAULT '{}',
    "created_at"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "job_preferences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "job_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- Job Listings
CREATE TABLE "job_listings" (
    "id"            TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "source_url"    TEXT        NOT NULL UNIQUE,
    "source"        "JobSource" NOT NULL,
    "external_id"   TEXT,
    "title"         TEXT        NOT NULL,
    "company"       TEXT        NOT NULL,
    "location"      TEXT,
    "remote_type"   "RemoteType" NOT NULL DEFAULT 'ON_SITE',
    "job_type"      "JobType"   NOT NULL DEFAULT 'FULL_TIME',
    "description"   TEXT,
    "requirements"  TEXT,
    "salary_min"    INTEGER,
    "salary_max"    INTEGER,
    "salary_currency" TEXT      DEFAULT 'USD',
    "posted_at"     TIMESTAMPTZ,
    "expires_at"    TIMESTAMPTZ,
    "is_active"     BOOLEAN     NOT NULL DEFAULT true,
    "apply_url"     TEXT,
    "content_hash"  TEXT        UNIQUE,
    "scraped_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "job_listings_pkey" PRIMARY KEY ("id")
);

-- Job Matches
CREATE TABLE "job_matches" (
    "id"             TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "user_id"        TEXT        NOT NULL,
    "job_listing_id" TEXT        NOT NULL,
    "total_score"    INTEGER     NOT NULL DEFAULT 0,
    "skill_score"    INTEGER     NOT NULL DEFAULT 0,
    "experience_score" INTEGER   NOT NULL DEFAULT 0,
    "location_score" INTEGER     NOT NULL DEFAULT 0,
    "recommendation" "MatchRecommendation" NOT NULL DEFAULT 'NO',
    "reasons"        TEXT[]      NOT NULL DEFAULT '{}',
    "scored_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "created_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "job_matches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "job_matches_user_job_unique" UNIQUE ("user_id","job_listing_id"),
    CONSTRAINT "job_matches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
    CONSTRAINT "job_matches_job_id_fkey" FOREIGN KEY ("job_listing_id") REFERENCES "job_listings"("id") ON DELETE CASCADE
);

-- Applications
CREATE TABLE "applications" (
    "id"               TEXT               NOT NULL DEFAULT gen_random_uuid()::text,
    "user_id"          TEXT               NOT NULL,
    "job_listing_id"   TEXT               NOT NULL,
    "resume_id"        TEXT,
    "tailored_resume_id" TEXT,
    "status"           "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "applied_at"       TIMESTAMPTZ,
    "applied_via"      TEXT,
    "confirmation_url" TEXT,
    "screenshot_url"   TEXT,
    "cover_letter"     TEXT,
    "custom_answers"   JSONB,
    "notes"            TEXT,
    "bot_job_id"       TEXT,
    "failure_reason"   TEXT,
    "follow_up_count"  INTEGER            NOT NULL DEFAULT 0,
    "last_follow_up_at" TIMESTAMPTZ,
    "created_at"       TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
    "updated_at"       TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
    CONSTRAINT "applications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "applications_user_job_unique" UNIQUE ("user_id","job_listing_id"),
    CONSTRAINT "applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
    CONSTRAINT "applications_job_id_fkey" FOREIGN KEY ("job_listing_id") REFERENCES "job_listings"("id") ON DELETE CASCADE
);

-- Application Status History
CREATE TABLE "application_status_history" (
    "id"             TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "application_id" TEXT        NOT NULL,
    "status"         "ApplicationStatus" NOT NULL,
    "note"           TEXT,
    "created_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "application_status_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "app_history_app_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE
);

-- User Email Accounts
CREATE TABLE "user_email_accounts" (
    "id"            TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "user_id"       TEXT        NOT NULL,
    "email"         TEXT        NOT NULL,
    "provider"      TEXT        NOT NULL,
    "access_token"  TEXT,
    "refresh_token" TEXT,
    "imap_host"     TEXT,
    "imap_port"     INTEGER,
    "imap_password" TEXT,
    "is_active"     BOOLEAN     NOT NULL DEFAULT true,
    "last_sync_at"  TIMESTAMPTZ,
    "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "user_email_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_email_accounts_user_email_unique" UNIQUE ("user_id","email"),
    CONSTRAINT "user_email_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- Email Threads
CREATE TABLE "email_threads" (
    "id"                  TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "user_id"             TEXT        NOT NULL,
    "application_id"      TEXT,
    "external_thread_id"  TEXT        NOT NULL,
    "subject"             TEXT        NOT NULL,
    "recruiter_email"     TEXT        NOT NULL,
    "recruiter_name"      TEXT,
    "company_name"        TEXT,
    "job_title"           TEXT,
    "classification"      "EmailClassification" NOT NULL DEFAULT 'OTHER',
    "classification_score" FLOAT,
    "status"              TEXT        NOT NULL DEFAULT 'active',
    "last_message_at"     TIMESTAMPTZ,
    "message_count"       INTEGER     NOT NULL DEFAULT 1,
    "raw_content"         TEXT,
    "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "email_threads_pkey"     PRIMARY KEY ("id"),
    CONSTRAINT "email_threads_ext_unique" UNIQUE ("external_thread_id"),
    CONSTRAINT "email_threads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- Followup Logs
CREATE TABLE "followup_logs" (
    "id"             TEXT           NOT NULL DEFAULT gen_random_uuid()::text,
    "application_id" TEXT           NOT NULL,
    "user_id"        TEXT           NOT NULL,
    "follow_up_number" INTEGER      NOT NULL,
    "status"         "FollowUpStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduled_at"   TIMESTAMPTZ    NOT NULL,
    "sent_at"        TIMESTAMPTZ,
    "subject"        TEXT,
    "body"           TEXT,
    "cancelled_reason" TEXT,
    "created_at"     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    CONSTRAINT "followup_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "followup_logs_app_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE
);

-- Interview Schedules
CREATE TABLE "interview_schedules" (
    "id"             TEXT             NOT NULL DEFAULT gen_random_uuid()::text,
    "application_id" TEXT             NOT NULL,
    "round"          INTEGER          NOT NULL DEFAULT 1,
    "type"           "InterviewType"  NOT NULL DEFAULT 'PHONE_SCREEN',
    "status"         "InterviewStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduled_at"   TIMESTAMPTZ,
    "duration_mins"  INTEGER,
    "location"       TEXT,
    "meeting_link"   TEXT,
    "interviewer_names" TEXT[]        DEFAULT '{}',
    "notes"          TEXT,
    "prep_pack_url"  TEXT,
    "created_at"     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    "updated_at"     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    CONSTRAINT "interview_schedules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "interview_schedules_app_round_unique" UNIQUE ("application_id","round"),
    CONSTRAINT "interview_schedules_app_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE
);

-- Notifications
CREATE TABLE "notifications" (
    "id"         TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "user_id"    TEXT        NOT NULL,
    "type"       TEXT        NOT NULL,
    "title"      TEXT        NOT NULL,
    "body"       TEXT        NOT NULL,
    "data"       JSONB,
    "read"       BOOLEAN     NOT NULL DEFAULT false,
    "sent_via"   TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- Subscriptions
CREATE TABLE "subscriptions" (
    "id"                TEXT                 NOT NULL DEFAULT gen_random_uuid()::text,
    "user_id"           TEXT                 NOT NULL UNIQUE,
    "stripe_customer_id" TEXT               UNIQUE,
    "stripe_subscription_id" TEXT           UNIQUE,
    "plan"              "SubscriptionPlan"   NOT NULL DEFAULT 'FREE',
    "status"            "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "current_period_start" TIMESTAMPTZ,
    "current_period_end"   TIMESTAMPTZ,
    "cancel_at"         TIMESTAMPTZ,
    "created_at"        TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
    "updated_at"        TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- Indexes for common queries
CREATE INDEX "idx_job_listings_source"          ON "job_listings"("source");
CREATE INDEX "idx_job_listings_is_active"       ON "job_listings"("is_active");
CREATE INDEX "idx_job_matches_user_score"       ON "job_matches"("user_id","total_score" DESC);
CREATE INDEX "idx_applications_user_status"     ON "applications"("user_id","status");
CREATE INDEX "idx_applications_status"          ON "applications"("status");
CREATE INDEX "idx_followup_logs_app_status"     ON "followup_logs"("application_id","status");
CREATE INDEX "idx_email_threads_user"           ON "email_threads"("user_id");
CREATE INDEX "idx_notifications_user_read"      ON "notifications"("user_id","read");

-- _prisma_migrations tracking table (Prisma requires this)
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    TEXT        NOT NULL,
    "checksum"              TEXT        NOT NULL,
    "finished_at"           TIMESTAMPTZ,
    "migration_name"        TEXT        NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        TIMESTAMPTZ,
    "started_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "applied_steps_count"   INTEGER     NOT NULL DEFAULT 0,
    CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY ("id")
);
