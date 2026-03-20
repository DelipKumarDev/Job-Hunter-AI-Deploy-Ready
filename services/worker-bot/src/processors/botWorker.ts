// ============================================================
// Bot Queue Worker
// Consumes 'job-apply-queue' — concurrency 2.
// Low concurrency is intentional: each browser session uses
// significant memory and we want to avoid rate-limiting.
//
// DISTRIBUTED LOCK: jh-lock:apply:{userId}:{jobListingId}
// ─────────────────────────────────────────────────────────
// Guards against:
//  1. Retry race — BullMQ's stall checker requeues a job while
//     the original is still running (browser crashed + recovered)
//  2. Duplicate queue entries — a scheduling bug or manual
//     re-trigger fires a second apply job for the same listing
//  3. DB race — @@unique([userId, jobListingId]) catches the
//     insert, but this lock prevents launching an expensive
//     browser session that was always going to fail
//
// Strategy: tryWithLock with retryCount:0
//   No retries — if the lock is held, this is a duplicate and
//   should be skipped immediately, not queued behind the first.
// ============================================================

import { Worker, type Job } from 'bullmq';
import { PrismaClient }     from '@prisma/client';
import { ApplicationBot }   from '../bot/applicationBot.js';
import type { BotJobPayload, BotRunResult } from '../types/botTypes.js';
import { getRedisConnection, getRedis } from '../utils/redis.js';
import { logger }           from '../utils/logger.js';
import {
  initLockClient,
  tryWithLock,
  LockKeys,
  TTL,
  LockContentionError,
} from '@job-hunter/shared';

const BOT_TIMEOUT_MS = 6 * 60 * 1000; // 6 min max per application

// ── Lock client init ──────────────────────────────────────────
let _lockInitialised = false;
function ensureLockClient(): void {
  if (_lockInitialised) return;
  initLockClient(getRedis(), {
    // Bot lock: no retries — skip immediately if another worker
    // is applying to the same job. We don't want two browsers
    // racing toward the same job portal.
    retryCount:    0,
    retryDelayMs:  0,
    retryJitterMs: 0,
  });
  _lockInitialised = true;
}

// ─────────────────────────────────────────────────────────────
let worker: Worker | null = null;

export function startBotWorker(prisma: PrismaClient): Worker {
  const concurrency = parseInt(process.env['BOT_CONCURRENCY'] ?? '2', 10);

  worker = new Worker<BotJobPayload>(
    'job-apply-queue',
    async (job: Job<BotJobPayload>) => {
      const { userId, applicationId, jobListingId, applyUrl } = job.data;

      ensureLockClient();

      logger.info('Bot worker: processing application', {
        jobId: job.id, applicationId, jobListingId, applyUrl,
        attempt: job.attemptsMade + 1,
      });
      await job.updateProgress(5);

      // ── Acquire distributed lock ────────────────────────────
      // Lock key: jh-lock:apply:{userId}:{jobListingId}
      // TTL is longer than the bot timeout to survive crashes.
      // retryCount:0 means we skip without retrying — a duplicate
      // application attempt should never proceed.
      const lockKey = LockKeys.applyJob(userId, jobListingId);

      const result = await tryWithLock(
        lockKey,
        TTL.APPLY,
        async (_lock) => {
          logger.debug('Bot lock acquired', { lockKey, applicationId });
          await job.updateProgress(10);

          const bot = new ApplicationBot(prisma);
          return await withTimeout(
            bot.run(job.data),
            BOT_TIMEOUT_MS,
            `Application bot timed out after ${BOT_TIMEOUT_MS / 1000}s`,
          );
        },
        // Per-call: no retries for application locks
        { retryCount: 0 },
      );

      // ── Lock contended — duplicate application in progress ──
      if (result === null) {
        logger.warn('Bot: application skipped — duplicate in progress', {
          jobId: job.id, userId, jobListingId, applicationId, lockKey,
        });

        // Return a structured skipped result rather than throwing,
        // so BullMQ records a clean completion with context.
        const skippedResult: BotRunResult = {
          sessionId:      `skipped_${applicationId}`,
          status:         'skipped',
          screenshotUrl:  null,
          fieldsDetected: 0,
          fieldsFilled:   0,
          stepsCompleted: 0,
          durationMs:     0,
          error:          'duplicate_application_in_progress',
          warnings:       ['Another worker is already processing this application'],
        };
        return skippedResult;
      }

      await job.updateProgress(100);
      logger.info('Bot worker: application complete', {
        jobId: job.id, applicationId,
        status:         result.status,
        stepsCompleted: result.stepsCompleted,
        fieldsFilled:   result.fieldsFilled,
        durationMs:     result.durationMs,
        warnings:       result.warnings.length,
      });

      return result;
    },
    {
      connection:   getRedisConnection(),
      prefix:       process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
      concurrency,
      // BullMQ's job-level lock: longer than the bot timeout so the
      // job isn't marked stalled while the browser is running.
      // Separate from the Redlock distributed lock.
      lockDuration: BOT_TIMEOUT_MS + 60_000,
      // backoffStrategy set at the Worker level in index.ts
      // via RETRY[QUEUE_NAMES.JOB_APPLY].backoffStrategy
    },
  );

  worker.on('completed', (job, result) => {
    if (result?.status === 'skipped') {
      logger.info('Bot job skipped (duplicate locked)', {
        jobId: job.id, appId: job.data.applicationId,
        reason: result?.error,
      });
    } else {
      logger.info('Bot job completed', {
        jobId:  job.id,
        status: result?.status,
        appId:  job.data.applicationId,
      });
    }
  });

  worker.on('failed', (job, err) => {
    logger.error('Bot job failed', {
      jobId:    job?.id,
      appId:    job?.data?.applicationId,
      error:    err.message,
      attempts: job?.attemptsMade,
      isLockContention: err instanceof LockContentionError,
    });
  });

  worker.on('stalled', (jobId) => {
    logger.warn('Bot job stalled (browser likely crashed)', { jobId });
    // Note: when BullMQ requeues a stalled job, the Redlock TTL ensures
    // the lock has auto-expired by the time the retry starts (~8 min TTL).
  });

  logger.info('Bot worker started', {
    concurrency,
    timeoutSec:   BOT_TIMEOUT_MS / 1000,
    lockTtlSec:   TTL.APPLY / 1000,
  });

  return worker;
}

export async function stopBotWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('Bot worker stopped');
  }
}

// ── Promise.race timeout wrapper ──────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    ),
  ]);
}
