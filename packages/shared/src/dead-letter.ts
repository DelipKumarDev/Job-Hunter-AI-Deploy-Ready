/**
 * ============================================================
 * packages/shared/src/dead-letter.ts
 *
 * Dead-Letter Queue (DLQ) Manager
 *
 * WHAT IS A DEAD-LETTER QUEUE?
 * When a BullMQ job exhausts all retry attempts, BullMQ moves
 * it to that queue's internal "failed" set. This is useful for
 * the Bull Board UI, but problematic for operations:
 *
 *   • Failed jobs are siloed per-queue — no single view
 *   • The failed set has no TTL — it grows unbounded
 *   • There's no way to query "all permanently failed jobs
 *     for user X across all queues"
 *   • No audit trail of what was in the job, why it failed,
 *     or what remediation was attempted
 *
 * The DLQ solves this by funneling ALL permanently-failed jobs
 * from all queues into one place: `failed-jobs`.
 *
 * ARCHITECTURE
 * ────────────
 * 1. Each worker's `worker.on('failed')` handler calls
 *    `maybeMoveToDeadLetter(job, err)`.
 *
 * 2. `maybeMoveToDeadLetter` checks `job.attemptsMade >= maxAttempts`.
 *    If so, it calls `moveToDeadLetter`.
 *
 * 3. `moveToDeadLetter` writes a `DeadLetterEntry` to the DLQ
 *    with the original payload, failure chain, timestamps, and
 *    remediation hints.
 *
 * 4. The DLQ is a normal BullMQ queue. A separate monitor
 *    (job-monitor.ts) reads it for dashboards and alerting.
 *    An operator can re-queue jobs via the Bull Board UI or the
 *    `requeueDeadLetterJob` helper.
 *
 * DLQ ENTRY SCHEMA
 * ────────────────
 *   sourceQueue    — original queue name
 *   sourceJobId    — original BullMQ job ID
 *   name           — original job name (e.g. 'discover', 'apply')
 *   payload        — original job data (deep copy)
 *   failureChain   — array of { attempt, error, timestamp }
 *                    for every failed attempt, not just the last
 *   finalError     — last error message and stack
 *   totalAttempts  — how many times the job ran
 *   firstFailedAt  — timestamp of first failure
 *   movedToDlqAt   — timestamp of DLQ insertion
 *   workerService  — 'worker-scraper' | 'worker-bot' | 'worker-email'
 *   userId         — extracted from payload.userId if present
 *   remediationHint — auto-generated hint for operators
 * ============================================================
 */

import { Queue, type Job } from 'bullmq';
import type { Redis }       from 'ioredis';
import { QUEUE_NAMES, DLQ_JOB_OPTIONS, getRetryConfig } from './queue-config.js';

// ── DLQ entry type ────────────────────────────────────────────

export interface FailureRecord {
  attempt:   number;
  error:     string;
  stack?:    string;
  timestamp: string; // ISO 8601
}

export interface DeadLetterEntry {
  // Provenance
  sourceQueue:   string;
  sourceJobId:   string;
  name:          string;
  workerService: string;
  userId:        string | null;

  // Original payload (deep copy — safe to re-queue)
  payload: unknown;

  // Failure chain — one record per failed attempt
  failureChain:  FailureRecord[];
  finalError:    string;
  finalStack:    string | undefined;

  // Timing
  totalAttempts:  number;
  firstFailedAt:  string;  // ISO 8601
  movedToDlqAt:   string;  // ISO 8601

  // Operator hint
  remediationHint: string;
}

// ── Module-level DLQ singleton ────────────────────────────────

let _dlq: Queue<DeadLetterEntry> | null = null;

/**
 * Initialise the DLQ queue handle.
 * Call once at worker startup (before any jobs are processed).
 * Uses the worker's existing Redis URL — no new connection needed.
 */
export function initDeadLetterQueue(redisUrl: string, prefix?: string): Queue<DeadLetterEntry> {
  if (_dlq) return _dlq;

  const parsed = new URL(redisUrl);
  _dlq = new Queue<DeadLetterEntry>(QUEUE_NAMES.DEAD_LETTER, {
    connection: {
      host:     parsed.hostname,
      port:     parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
      maxRetriesPerRequest: null,
    },
    prefix: prefix ?? 'jhq',
    defaultJobOptions: DLQ_JOB_OPTIONS,
  });

  return _dlq;
}

export function getDeadLetterQueue(): Queue<DeadLetterEntry> {
  if (!_dlq) throw new Error('[dead-letter] getDeadLetterQueue() called before initDeadLetterQueue()');
  return _dlq;
}

// ── Failure chain tracking in Redis ──────────────────────────
// We store the per-job failure chain in Redis so that when the
// final attempt fails, we can reconstruct the full history.
// Key: jh-dlq:chain:{sourceQueue}:{jobId}
// TTL: 24h (enough to outlive 5 retries with max backoff)

const CHAIN_TTL_SECS = 24 * 60 * 60;

function chainKey(queueName: string, jobId: string): string {
  return `jh-dlq:chain:${queueName}:${jobId}`;
}

/**
 * Record one failed attempt in Redis.
 * Call from worker.on('failed') on EVERY failure (not just the last).
 */
export async function recordFailedAttempt(
  redis:     Redis,
  queueName: string,
  jobId:     string,
  attempt:   number,
  error:     Error,
): Promise<void> {
  const record: FailureRecord = {
    attempt,
    error:     error.message,
    stack:     error.stack,
    timestamp: new Date().toISOString(),
  };

  const key = chainKey(queueName, jobId);
  await redis.rpush(key, JSON.stringify(record));
  await redis.expire(key, CHAIN_TTL_SECS);
}

/**
 * Retrieve and delete the failure chain for a job.
 * Used when moving to DLQ — cleans up the chain from Redis.
 */
async function consumeFailureChain(
  redis:     Redis,
  queueName: string,
  jobId:     string,
): Promise<FailureRecord[]> {
  const key = chainKey(queueName, jobId);
  const raw = await redis.lrange(key, 0, -1);
  await redis.del(key);

  return raw.map(r => {
    try { return JSON.parse(r) as FailureRecord; }
    catch { return { attempt: 0, error: r, timestamp: new Date().toISOString() }; }
  });
}

// ── Remediation hint generator ────────────────────────────────

function buildRemediationHint(queueName: string, errorMessage: string): string {
  const err = errorMessage.toLowerCase();

  if (queueName === QUEUE_NAMES.JOB_APPLY) {
    if (err.includes('timeout'))     return 'Browser session timed out. Check if the job portal is reachable and not rate-limiting. Consider rotating proxies.';
    if (err.includes('captcha'))     return 'CAPTCHA detected. The stealth profile may need rotation or the portal has tightened its bot detection. Check captcha-detector logs.';
    if (err.includes('navigator'))   return 'Browser crash or network error. Check available memory on the bot worker host.';
    if (err.includes('unique'))      return 'Duplicate application: DB unique constraint. The application was likely already submitted manually. Safe to discard.';
  }

  if (queueName === QUEUE_NAMES.JOB_DISCOVERY) {
    if (err.includes('rate') || err.includes('429')) return 'Platform rate-limited the scraper. Increase scrape interval or reduce concurrency for this platform.';
    if (err.includes('login') || err.includes('auth')) return 'Session expired. The scraper may need fresh cookies or credentials for this platform.';
  }

  if (queueName === QUEUE_NAMES.EMAIL_MONITOR) {
    if (err.includes('token') || err.includes('oauth')) return 'OAuth token refresh failed. User may need to re-authorise their Gmail/Outlook account.';
    if (err.includes('imap'))   return 'IMAP connection failed. Check if the user\'s IMAP password has changed or 2FA was enabled.';
    if (err.includes('quota'))  return 'Gmail API quota exceeded. Back off for 24h or request a quota increase.';
  }

  if (queueName === QUEUE_NAMES.FOLLOW_UP) {
    if (err.includes('smtp') || err.includes('nodemailer')) return 'SMTP delivery failed. Check SMTP credentials and whether the sender domain is blacklisted.';
    if (err.includes('cancelled')) return 'Follow-up was cancelled during retry (recruiter replied). Safe to discard.';
  }

  return `Job failed ${queueName} after all retries. Review stack trace and check worker logs around the timestamps in the failure chain.`;
}

// ── Core DLQ move function ────────────────────────────────────

/**
 * Move a permanently-failed job to the dead-letter queue.
 *
 * Extracts: original payload, full failure chain, timing metadata.
 * Generates: operator remediation hint.
 * Writes:    DeadLetterEntry to the `failed-jobs` BullMQ queue.
 *
 * This function is idempotent — if the DLQ write fails we log
 * but do not throw, so the worker's failure handler doesn't
 * compound the problem with a second error.
 */
export async function moveToDeadLetter(
  redis:         Redis,
  job:           Job,
  error:         Error,
  workerService: string,
): Promise<string | null> {
  const queueName = job.queueName;
  const jobId     = job.id ?? 'unknown';

  // Retrieve full failure chain from Redis
  const chain = await consumeFailureChain(redis, queueName, jobId);

  // If chain is empty (e.g. first attempt was the only one), build from current error
  if (chain.length === 0) {
    chain.push({
      attempt:   job.attemptsMade,
      error:     error.message,
      stack:     error.stack,
      timestamp: new Date().toISOString(),
    });
  }

  const firstFailedAt = chain[0]?.timestamp ?? new Date().toISOString();
  const userId = (job.data as Record<string, unknown>)?.userId as string | null ?? null;

  const entry: DeadLetterEntry = {
    sourceQueue:    queueName,
    sourceJobId:    jobId,
    name:           job.name,
    workerService,
    userId,
    payload:        job.data,
    failureChain:   chain,
    finalError:     error.message,
    finalStack:     error.stack,
    totalAttempts:  job.attemptsMade,
    firstFailedAt,
    movedToDlqAt:   new Date().toISOString(),
    remediationHint: buildRemediationHint(queueName, error.message),
  };

  try {
    const dlq    = getDeadLetterQueue();
    const jobName = `dlq:${queueName}:${jobId}`;

    const dlqJob = await dlq.add(jobName, entry, {
      // Use a deterministic job ID so re-queuing the same failure
      // doesn't create duplicates in the DLQ
      jobId:            `dlq-${queueName}-${jobId}`,
      ...DLQ_JOB_OPTIONS,
    });

    return dlqJob.id ?? null;
  } catch (dlqErr) {
    // DLQ write failure must not throw — we're already in an error handler
    console.error('[dead-letter] Failed to write to DLQ', {
      sourceQueue: queueName,
      sourceJobId: jobId,
      dlqError:    String(dlqErr),
    });
    return null;
  }
}

/**
 * Main entry point for worker failure handlers.
 *
 * Call this from EVERY worker.on('failed') event.
 * It handles both partial failures (recording to chain) and
 * final failures (moving to DLQ) based on attempt count.
 *
 * @returns 'dlq'       if the job was moved to the DLQ
 * @returns 'retrying'  if more attempts remain
 * @returns 'skipped'   if the job has no ID (should not happen)
 */
export async function maybeMoveToDeadLetter(
  redis:         Redis,
  job:           Job | undefined,
  error:         Error,
  workerService: string,
): Promise<'dlq' | 'retrying' | 'skipped'> {
  if (!job?.id) return 'skipped';

  const queueName  = job.queueName;
  const config     = getRetryConfig(queueName);
  const maxAttempts = config.maxAttempts;

  // Always record this attempt to the chain
  await recordFailedAttempt(redis, queueName, job.id, job.attemptsMade, error);

  // If this is the final attempt, move to DLQ
  if (job.attemptsMade >= maxAttempts) {
    await moveToDeadLetter(redis, job, error, workerService);
    return 'dlq';
  }

  return 'retrying';
}

// ── Re-queue helper (operator tool) ──────────────────────────

/**
 * Re-queue a dead-letter job back to its original queue.
 * Useful for operator-driven remediation after fixing the root cause.
 *
 * @param dlqJobId  The job ID in the failed-jobs queue
 * @param targetQueue  The BullMQ Queue instance to re-queue into
 */
export async function requeueDeadLetterJob(
  dlqJobId:    string,
  targetQueue: Queue,
): Promise<string | null> {
  const dlq    = getDeadLetterQueue();
  const dlqJob = await dlq.getJob(dlqJobId);

  if (!dlqJob) {
    console.warn('[dead-letter] requeueDeadLetterJob: DLQ job not found', { dlqJobId });
    return null;
  }

  const entry = dlqJob.data;

  const requeued = await targetQueue.add(
    entry.name,
    entry.payload,
    { attempts: 5, backoff: { type: 'exponential', delay: 10_000 } },
  );

  // Remove from DLQ after successful re-queue
  await dlqJob.remove();

  return requeued.id ?? null;
}

export async function closeDeadLetterQueue(): Promise<void> {
  if (_dlq) {
    await _dlq.close();
    _dlq = null;
  }
}
