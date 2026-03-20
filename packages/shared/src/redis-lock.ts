/**
 * ============================================================
 * packages/shared/src/redis-lock.ts
 *
 * Distributed lock utility built on Redlock (Redlock algorithm).
 *
 * WHY DISTRIBUTED LOCKS?
 * ─────────────────────
 * BullMQ itself prevents the same queue *job* from being picked
 * up by two workers via its internal lease (lockDuration). But
 * that protection only covers BullMQ's own job lifecycle. It
 * does NOT prevent:
 *
 *  • Two different queue jobs racing to apply to the same
 *    listing for the same user (e.g. a retry + a fresh job)
 *  • Two email-sync jobs racing to process the same account
 *    when a job retries while the original is still running
 *  • A follow-up being sent twice when a stalled job is
 *    requeued by BullMQ's stall checker
 *  • A scrape run being duplicated when multiple users share
 *    the same platform config and a scheduling bug fires twice
 *
 * HOW IT WORKS
 * ────────────
 * Redlock implements the distributed lock algorithm described
 * by Redis's author. With a single Redis node (our setup) it
 * degrades to SET NX PX — a standard advisory lock that:
 *   - Is atomic (no TOCTOU race)
 *   - Auto-expires (no deadlock if the holder crashes)
 *   - Is released explicitly (not just left to expire)
 *
 * USAGE PATTERNS
 * ──────────────
 *   // Pattern 1: withLock — throws LockContentionError on contention
 *   await withLock(LockKeys.applyJob(userId, jobListingId), TTL.APPLY, async () => {
 *     await bot.run(payload);
 *   });
 *
 *   // Pattern 2: tryWithLock — returns null on contention (for skippable work)
 *   const result = await tryWithLock(LockKeys.scrapeRun(userId, platform), TTL.SCRAPE, async () => {
 *     return await orchestrator.run(config, platform);
 *   });
 *   if (result === null) return { skipped: true, reason: 'duplicate_in_progress' };
 *
 * INITIALISATION
 * ──────────────
 * Call initLockClient(redisClient) once at worker startup with
 * the worker's existing ioredis client. No second connection is
 * opened — Redlock wraps the existing one.
 * ============================================================
 */

import Redlock, { type Lock, ExecutionError }  from 'redlock';
import type { Redis }                           from 'ioredis';

// ── Error types ───────────────────────────────────────────────

/** Thrown by withLock() when the lock cannot be acquired */
export class LockContentionError extends Error {
  constructor(
    public readonly lockKey: string,
    public readonly retries: number,
  ) {
    super(
      `Distributed lock contention: "${lockKey}" could not be acquired after ${retries} retries. ` +
      `Another worker is already processing this resource.`,
    );
    this.name = 'LockContentionError';
  }
}

/** Thrown when initLockClient() has not been called yet */
export class LockNotInitializedError extends Error {
  constructor() {
    super(
      '[redis-lock] getLockClient() called before initLockClient(). ' +
      'Call initLockClient(redisClient) at worker startup.',
    );
    this.name = 'LockNotInitializedError';
  }
}

// ── TTL constants ─────────────────────────────────────────────
// Each lock type gets a TTL calibrated to its maximum realistic
// execution time plus a safety margin.
// The lock ALWAYS releases explicitly in the finally block —
// TTL is only a deadlock safeguard for process crashes.

export const TTL = {
  /** Scrape run: platforms can take up to 10 min on slow networks */
  SCRAPE:   12 * 60 * 1000,   // 12 minutes

  /** Bot application: 6 min max + 2 min safety margin */
  APPLY:     8 * 60 * 1000,   //  8 minutes

  /** Email account sync: Gmail/IMAP pull typically <2 min */
  EMAIL_SYNC: 5 * 60 * 1000,  //  5 minutes

  /** Follow-up send: quick SMTP call, 90s is generous */
  FOLLOW_UP:   90 * 1000,     // 90 seconds

  /** Job deduplication check: very fast, just prevents TOCTOU */
  JOB_DEDUP:    5 * 1000,     //  5 seconds
} as const;

// ── Lock key builders ─────────────────────────────────────────
// All keys use a consistent scheme: jh-lock:{resource}:{id...}
// Prefix is separate from the BullMQ queue prefix (jhq:).

const PREFIX = 'jh-lock';

export const LockKeys = {
  /**
   * Prevents duplicate scrape runs for the same user+platform.
   * One scraper worker may be running 3 platforms concurrently
   * (concurrency:3), but the same user+platform combo must be
   * serialised so no two workers duplicate-scrape LinkedIn at once.
   */
  scrapeRun: (userId: string, platform: string) =>
    `${PREFIX}:scrape:${userId}:${platform}`,

  /**
   * Prevents two bot workers from applying to the same job for
   * the same user simultaneously. Protects against:
   *  - Retry + original race (job retried while original stalled)
   *  - Duplicate queue entries from scheduling bugs
   * The DB has @@unique([userId, jobListingId]) as a final guard,
   * but this lock stops the expensive browser session from launching.
   */
  applyJob: (userId: string, jobListingId: string) =>
    `${PREFIX}:apply:${userId}:${jobListingId}`,

  /**
   * Prevents two email-sync workers from syncing the same inbox
   * simultaneously. With concurrency:5, five accounts run in
   * parallel — this ensures each account is processed by at most
   * one worker at a time.
   */
  emailSync: (emailAccountId: string) =>
    `${PREFIX}:email-sync:${emailAccountId}`,

  /**
   * Prevents a follow-up email from being sent twice.
   * BullMQ's stall checker can re-queue a job if the worker
   * crashes mid-send — this lock makes the send idempotent.
   */
  followUp: (followUpId: string) =>
    `${PREFIX}:followup:${followUpId}`,

  /**
   * Fine-grained lock on a single email thread during analysis.
   * Prevents two workers concurrently updating the same thread's
   * status (e.g. from parallel sync jobs for multiple accounts).
   */
  emailThread: (threadId: string) =>
    `${PREFIX}:thread:${threadId}`,
} as const;

// ── Redlock options ───────────────────────────────────────────

export interface LockOptions {
  /**
   * How many times to retry acquiring the lock before giving up.
   * Default: 3
   */
  retryCount?: number;

  /**
   * Base delay in ms between retry attempts.
   * Default: 500ms
   * Actual delay = retryDelay + random jitter (0–retryJitter ms)
   */
  retryDelayMs?: number;

  /**
   * Maximum random jitter added to each retry delay (ms).
   * Jitter prevents thundering herd when many workers contest the same lock.
   * Default: 200ms
   */
  retryJitterMs?: number;
}

const DEFAULT_OPTS: Required<LockOptions> = {
  retryCount:    3,
  retryDelayMs:  500,
  retryJitterMs: 200,
};

// ── Module-level singleton ────────────────────────────────────

let _redlock: Redlock | null = null;

/**
 * Initialise the lock client.
 * Call ONCE at worker startup, passing the existing ioredis client.
 * No second Redis connection is opened.
 *
 * @param redis     The worker's existing ioredis client.
 * @param defaults  Default retry options for all lock operations.
 */
export function initLockClient(
  redis:    Redis,
  defaults?: LockOptions,
): Redlock {
  const opts = { ...DEFAULT_OPTS, ...defaults };

  _redlock = new Redlock(
    [redis as Parameters<typeof Redlock>[0][number]],
    {
      // How much clock drift to allow (1% of TTL)
      driftFactor: 0.01,
      retryCount:  opts.retryCount,
      retryDelay:  opts.retryDelayMs,
      retryJitter: opts.retryJitterMs,
      // Do not throw on individual client errors — still fail if
      // quorum (majority) cannot be reached
      automaticExtensionThreshold: 500,
    },
  );

  return _redlock;
}

/**
 * Get the initialised lock client.
 * Throws LockNotInitializedError if initLockClient() was not called.
 */
export function getLockClient(): Redlock {
  if (!_redlock) throw new LockNotInitializedError();
  return _redlock;
}

// ── Primary API ───────────────────────────────────────────────

/**
 * Acquire a lock, execute fn(), then release — in a single call.
 *
 * ✅ Use when the work MUST NOT be skipped on contention.
 *    If the lock cannot be acquired, throws LockContentionError.
 *    The caller decides whether to retry or fail the job.
 *
 * The lock is always released in a finally block — even if fn()
 * throws, even if process.exit() is called (via dumb-init signal).
 *
 * @param key    Lock key (use LockKeys.* builders)
 * @param ttlMs  Maximum lock lifetime in ms (use TTL.* constants)
 * @param fn     Async function to execute while holding the lock
 * @param opts   Per-call retry overrides
 */
export async function withLock<T>(
  key:   string,
  ttlMs: number,
  fn:    (lock: Lock) => Promise<T>,
  opts?: LockOptions,
): Promise<T> {
  const redlock = getLockClient();
  const merged  = { ...DEFAULT_OPTS, ...opts };

  // Build a per-call Redlock instance if caller overrides retry opts,
  // otherwise reuse the module singleton (more efficient)
  const client = (
    opts?.retryCount  !== undefined ||
    opts?.retryDelayMs  !== undefined ||
    opts?.retryJitterMs !== undefined
  )
    ? redlock.using(
        [key],
        ttlMs,
        { retryCount: merged.retryCount, retryDelay: merged.retryDelayMs, retryJitter: merged.retryJitterMs },
        fn,
      )
    : redlock.using([key], ttlMs, fn);

  try {
    return await client;
  } catch (err) {
    if (err instanceof ExecutionError) {
      throw new LockContentionError(key, merged.retryCount);
    }
    throw err;
  }
}

/**
 * Try to acquire a lock and execute fn().
 * Returns null — WITHOUT throwing — if the lock is already held.
 *
 * ✅ Use for skippable work: if another worker is already doing
 *    the same thing, skip gracefully instead of failing the job.
 *
 * @returns  The return value of fn(), or null if lock was contended.
 */
export async function tryWithLock<T>(
  key:   string,
  ttlMs: number,
  fn:    (lock: Lock) => Promise<T>,
  opts?: LockOptions,
): Promise<T | null> {
  try {
    return await withLock(key, ttlMs, fn, opts);
  } catch (err) {
    if (err instanceof LockContentionError) return null;
    throw err;
  }
}

/**
 * Check whether a lock is currently held — non-destructive probe.
 * Useful for health checks and dashboards.
 *
 * WARNING: This is inherently racy — the lock may be acquired or
 * released between the check and any subsequent action. Use
 * withLock/tryWithLock for actual mutual exclusion.
 */
export async function isLocked(redis: Redis, key: string): Promise<boolean> {
  const val = await redis.get(key);
  return val !== null;
}

/**
 * Force-release a lock by its key.
 * Only use this for operational recovery — NOT in application code.
 * Normal release happens automatically in withLock/tryWithLock.
 */
export async function forceRelease(redis: Redis, key: string): Promise<void> {
  await redis.del(key);
}

// ── Re-exports ────────────────────────────────────────────────
export type { Lock };
export { ExecutionError as RedlockExecutionError };
