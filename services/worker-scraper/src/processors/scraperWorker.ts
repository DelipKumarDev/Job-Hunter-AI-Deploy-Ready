// ============================================================
// Job Discovery Queue Worker
// Consumes jobs from 'job-discovery-queue'.
// Each job = one platform × one user.
// Concurrency = 3 (3 platforms run simultaneously per user).
//
// DISTRIBUTED LOCK: jh-lock:scrape:{userId}:{platform}
// ─────────────────────────────────────────────────────────
// BullMQ's internal lease prevents the same *queue job* from
// being picked up twice, but it cannot prevent the case where
// a second queue job for the same userId+platform arrives
// before the first completes (e.g. a scheduled run fires while
// a manual run is still in flight, or a retry overlaps).
//
// tryWithLock returns null immediately if the lock is held —
// the job exits cleanly so BullMQ marks it completed rather
// than failed, avoiding useless retries for an inherently
// idempotent operation.
// ============================================================

import { Worker, type Job } from 'bullmq';
import { PrismaClient }     from '@prisma/client';
import { DiscoveryOrchestrator }  from './orchestrator.js';
import type { DiscoveryQueuePayload } from '../types/scraperTypes.js';
import { getRedisConnection, getRedis } from '../utils/redis.js';
import { logger }           from '../utils/logger.js';
import {
  initLockClient,
  tryWithLock,
  LockKeys,
  TTL,
  LockContentionError,
} from '@job-hunter/shared';

// ── Lock client init ──────────────────────────────────────────
// Wraps the existing ioredis instance — no second connection.
// Called once per process on the first job received, by which
// point connectRedis() has already been called by index.ts.
let _lockInitialised = false;
function ensureLockClient(): void {
  if (_lockInitialised) return;
  initLockClient(getRedis(), {
    retryCount:    2,
    retryDelayMs:  2_000,
    retryJitterMs: 400,
  });
  _lockInitialised = true;
}

// ─────────────────────────────────────────────────────────────
let worker: Worker | null = null;

export function startScraperWorker(prisma: PrismaClient): Worker {
  const concurrency = parseInt(process.env['SCRAPER_CONCURRENCY'] ?? '3', 10);

  worker = new Worker<DiscoveryQueuePayload>(
    'job-discovery-queue',
    async (job: Job<DiscoveryQueuePayload>) => {
      const { userId, platform, config, runId } = job.data;

      // Initialise lock client lazily on first job
      ensureLockClient();

      logger.info('Scraper worker: processing', { jobId: job.id, userId, platform, runId });
      await job.updateProgress(5);

      // ── Acquire distributed lock ────────────────────────────
      // Lock key: jh-lock:scrape:{userId}:{platform}
      // Returns null immediately if another worker holds this lock.
      const lockKey = LockKeys.scrapeRun(userId, platform);

      const result = await tryWithLock(
        lockKey,
        TTL.SCRAPE,
        async (_lock) => {
          logger.debug('Scraper lock acquired', { lockKey, runId });
          await job.updateProgress(15);

          const orchestrator = new DiscoveryOrchestrator(prisma, getRedis());
          try {
            return await orchestrator.run(config, platform);
          } finally {
            // Close queue connections before releasing the lock
            await orchestrator.close();
          }
        },
      );

      // ── Lock contended — another worker owns this run ───────
      if (result === null) {
        logger.warn('Scraper: run skipped — duplicate in flight', {
          jobId: job.id, userId, platform, runId, lockKey,
        });
        // Return a clean result so BullMQ marks this completed,
        // not failed — retrying a duplicate is pointless.
        return {
          runId, platform,
          jobsFound: 0, jobsNew: 0, jobsDuplicate: 0, jobsFailed: 0,
          durationMs: 0, skipped: true, skipReason: 'lock_contended',
        };
      }

      await job.updateProgress(100);
      logger.info('Scraper: run complete', {
        jobId: job.id, platform, runId,
        found: result.jobsFound,
        new:   result.jobsNew,
        dup:   result.jobsDuplicate,
        ms:    result.durationMs,
      });

      return {
        runId, platform,
        jobsFound:     result.jobsFound,
        jobsNew:       result.jobsNew,
        jobsDuplicate: result.jobsDuplicate,
        jobsFailed:    result.jobsFailed,
        durationMs:    result.durationMs,
        skipped:       false,
      };
    },
    {
      connection: getRedisConnection(),
      prefix:     process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
      concurrency,
      // backoffStrategy is set at the Worker level in index.ts
      // via RETRY[QUEUE_NAMES.JOB_DISCOVERY].backoffStrategy
    },
  );

  worker.on('completed', (job, result) => {
    if (result?.skipped) {
      logger.info('Scraper job skipped (lock contended — duplicate run in flight)', {
        jobId: job.id, platform: result?.platform,
      });
    } else {
      logger.info('Scraper job completed', {
        jobId: job.id, platform: result?.platform,
        new: result?.jobsNew, found: result?.jobsFound, ms: result?.durationMs,
      });
    }
  });

  worker.on('failed', (job, err) => {
    logger.error('Scraper job failed', {
      jobId:    job?.id,
      platform: job?.data?.platform,
      error:    err.message,
      attempts: job?.attemptsMade,
      isLockContention: err instanceof LockContentionError,
    });
  });

  logger.info('Scraper worker started', { concurrency });
  return worker;
}

export async function stopScraperWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('Scraper worker stopped');
  }
}
