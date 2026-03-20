/**
 * ============================================================
 * packages/shared/src/queue-config.ts
 *
 * Single source of truth for every queue's retry policy,
 * backoff curve, removal windows, and DLQ routing.
 *
 * WHY CENTRALISE THIS?
 * Each worker currently defines its own retry parameters in
 * different places: some in Worker options, some in queue.add()
 * calls, some implicit (no config = BullMQ defaults = 0 retries).
 * Inconsistency means:
 *   • A scraper job silently drops after 1 failure
 *   • A follow-up email retries forever with no cap
 *   • The bot uses a different backoff curve than email
 *
 * This file defines the authoritative config. Workers import
 * RETRY and use it for both the Worker constructor and every
 * queue.add() call. If a policy needs to change, one edit here
 * propagates everywhere.
 *
 * RETRY DESIGN RATIONALE
 * ─────────────────────
 * All queues use:
 *   attempts: 5     — enough for transient failures without
 *                     overwhelming the DLQ on systemic issues
 *   exponential backoff starting at 10s
 *
 * Per-queue max delays differ because the underlying operations
 * have different expected recovery times:
 *
 *   job-discovery  300s max — scrape rate limits clear in minutes
 *   job-apply      600s max — browser / portal issues need time
 *   email-monitor  300s max — IMAP/Gmail quota resets quickly
 *   followup       3600s max — SMTP 4xx errors need extended wait
 *   notification   120s max — WhatsApp API is usually fast to recover
 *
 * DEAD-LETTER ROUTING
 * ──────────────────
 * After all attempts are exhausted BullMQ moves the job to its
 * own "failed" set. We additionally mirror it to the shared
 * `failed-jobs` queue so operators have one place to inspect all
 * permanently-failed work across all queues.
 * ============================================================
 */

import type { JobsOptions, BackoffOptions } from 'bullmq';

// ── Queue name registry ───────────────────────────────────────
// Single source of truth for queue names.
// Workers must import from here rather than hard-coding strings.

export const QUEUE_NAMES = {
  JOB_DISCOVERY:  'job-discovery-queue',
  JOB_APPLY:      'job-apply-queue',
  EMAIL_MONITOR:  'email-monitor-queue',
  FOLLOW_UP:      'followup-queue',
  NOTIFICATION:   'notification-queue',
  AI_MATCH:       'ai-match-queue',
  RESUME_TAILOR:  'resume-tailor-queue',
  INTERVIEW_PREP: 'interview-prep-queue',

  // Dead letter queue — receives all permanently-failed jobs
  DEAD_LETTER:    'failed-jobs',
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];

// ── Backoff options ───────────────────────────────────────────
// Re-used across queues; the delay here is the base interval.
// With exponential backoff, delays are: 10s, 20s, 40s, 80s, 160s
// (capped per queue at maxDelay in BACKOFF_STRATEGIES).

const BASE_BACKOFF_DELAY_MS = 10_000; // 10 seconds — as specified

export type BackoffStrategy = BackoffOptions & { maxDelayMs: number };

// Per-queue backoff caps
const BACKOFF: Record<string, BackoffStrategy> = {
  [QUEUE_NAMES.JOB_DISCOVERY]: {
    type: 'exponential',
    delay: BASE_BACKOFF_DELAY_MS,
    maxDelayMs: 5 * 60 * 1000,   // 5 min — rate limits clear quickly
  },
  [QUEUE_NAMES.JOB_APPLY]: {
    type: 'exponential',
    delay: BASE_BACKOFF_DELAY_MS,
    maxDelayMs: 10 * 60 * 1000,  // 10 min — portal / browser recovery
  },
  [QUEUE_NAMES.EMAIL_MONITOR]: {
    type: 'exponential',
    delay: BASE_BACKOFF_DELAY_MS,
    maxDelayMs: 5 * 60 * 1000,   // 5 min — IMAP/OAuth quota resets
  },
  [QUEUE_NAMES.FOLLOW_UP]: {
    type: 'exponential',
    delay: BASE_BACKOFF_DELAY_MS,
    maxDelayMs: 60 * 60 * 1000,  // 1 hour — SMTP 4xx (greylisting etc.)
  },
  [QUEUE_NAMES.NOTIFICATION]: {
    type: 'exponential',
    delay: BASE_BACKOFF_DELAY_MS,
    maxDelayMs: 2 * 60 * 1000,   // 2 min — WhatsApp API usually fast
  },
  [QUEUE_NAMES.AI_MATCH]: {
    type: 'exponential',
    delay: BASE_BACKOFF_DELAY_MS,
    maxDelayMs: 3 * 60 * 1000,   // 3 min — Claude API backpressure
  },
};

// ── Removal windows ───────────────────────────────────────────
// How long to keep completed / failed jobs in Redis.
// Failed jobs are kept longer for post-mortem inspection.

const REMOVAL = {
  // How many completed jobs to keep per queue
  completedCount: {
    [QUEUE_NAMES.JOB_DISCOVERY]:  200,
    [QUEUE_NAMES.JOB_APPLY]:      500,  // Keep more — audit trail
    [QUEUE_NAMES.EMAIL_MONITOR]:  300,
    [QUEUE_NAMES.FOLLOW_UP]:      1000, // Full history useful
    [QUEUE_NAMES.NOTIFICATION]:   1000,
    [QUEUE_NAMES.AI_MATCH]:       200,
  } as Record<string, number>,

  // How many failed jobs to keep in the BullMQ failed set
  // (separate from the DLQ — BullMQ keeps its own set for the UI)
  failedCount: {
    [QUEUE_NAMES.JOB_DISCOVERY]:  100,
    [QUEUE_NAMES.JOB_APPLY]:      500,
    [QUEUE_NAMES.EMAIL_MONITOR]:  200,
    [QUEUE_NAMES.FOLLOW_UP]:      500,
    [QUEUE_NAMES.NOTIFICATION]:   200,
    [QUEUE_NAMES.AI_MATCH]:       100,
  } as Record<string, number>,
} as const;

// ── Per-queue JobsOptions ─────────────────────────────────────

export interface QueueJobConfig {
  /** Retry options to apply when calling queue.add() */
  addOptions: Pick<JobsOptions, 'attempts' | 'backoff' | 'removeOnComplete' | 'removeOnFail'>;

  /** Worker-level backoffStrategy function (overrides addOptions.backoff in worker) */
  backoffStrategy: (attemptsMade: number) => number;

  /** How many attempts before a job is considered permanently failed */
  maxAttempts: number;

  /** Attempt number at which to fire a warning alert (before final failure) */
  warnAttempt: number;
}

function buildConfig(queueName: string, maxAttempts = 5): QueueJobConfig {
  const b = BACKOFF[queueName] ?? { type: 'exponential', delay: BASE_BACKOFF_DELAY_MS, maxDelayMs: 300_000 };
  const maxDelayMs = b.maxDelayMs;

  return {
    maxAttempts,
    warnAttempt: Math.ceil(maxAttempts / 2), // e.g. attempt 3 of 5

    addOptions: {
      attempts:         maxAttempts,
      backoff:          { type: 'exponential', delay: BASE_BACKOFF_DELAY_MS },
      removeOnComplete: { count: REMOVAL.completedCount[queueName] ?? 200 },
      removeOnFail:     { count: REMOVAL.failedCount[queueName]    ?? 100 },
    },

    // BullMQ Worker-level strategy (more precise than addOptions.backoff
    // because it receives the actual attemptsMade counter)
    backoffStrategy: (attemptsMade: number) => {
      const delay = BASE_BACKOFF_DELAY_MS * Math.pow(2, attemptsMade - 1);
      return Math.min(delay, maxDelayMs);
    },
  };
}

// ── The exported RETRY map ────────────────────────────────────
// Import this in workers: import { RETRY } from '@job-hunter/shared';

export const RETRY: Record<string, QueueJobConfig> = {
  [QUEUE_NAMES.JOB_DISCOVERY]:  buildConfig(QUEUE_NAMES.JOB_DISCOVERY,  5),
  [QUEUE_NAMES.JOB_APPLY]:      buildConfig(QUEUE_NAMES.JOB_APPLY,      5),
  [QUEUE_NAMES.EMAIL_MONITOR]:  buildConfig(QUEUE_NAMES.EMAIL_MONITOR,  5),
  [QUEUE_NAMES.FOLLOW_UP]:      buildConfig(QUEUE_NAMES.FOLLOW_UP,       5),
  [QUEUE_NAMES.NOTIFICATION]:   buildConfig(QUEUE_NAMES.NOTIFICATION,    3),
  [QUEUE_NAMES.AI_MATCH]:       buildConfig(QUEUE_NAMES.AI_MATCH,        5),
  [QUEUE_NAMES.RESUME_TAILOR]:  buildConfig(QUEUE_NAMES.RESUME_TAILOR,   5),
  [QUEUE_NAMES.INTERVIEW_PREP]: buildConfig(QUEUE_NAMES.INTERVIEW_PREP,  5),
};

/**
 * Helper: get retry config for a queue. Returns a sensible default
 * for unknown queues rather than throwing.
 */
export function getRetryConfig(queueName: string): QueueJobConfig {
  return RETRY[queueName] ?? buildConfig(queueName, 5);
}

// ── Dead-letter queue job options ─────────────────────────────
// Jobs in the DLQ are never auto-removed — they stay for operator
// inspection. Retention can be controlled via Bull Board or the
// DLQ monitor's purge API.

export const DLQ_JOB_OPTIONS: JobsOptions = {
  attempts:         1,           // DLQ jobs are not retried
  removeOnComplete: false,       // Keep forever until manually cleared
  removeOnFail:     false,
};

// ── Scheduler add-options helper ─────────────────────────────
/**
 * Returns the options object to pass to queue.add() for a given
 * queue. Merges per-queue config with any caller overrides.
 *
 * Usage:
 *   await discoveryQueue.add('discover', payload, jobAddOptions(QUEUE_NAMES.JOB_DISCOVERY));
 */
export function jobAddOptions(
  queueName: string,
  overrides?: Partial<JobsOptions>,
): JobsOptions {
  const config = getRetryConfig(queueName);
  return { ...config.addOptions, ...overrides };
}
