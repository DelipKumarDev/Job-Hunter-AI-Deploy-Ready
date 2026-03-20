// ============================================================
// Email Workers
// Two BullMQ workers:
//
//  1. syncWorker     — consumes 'email-monitor-queue'
//     Syncs user's Gmail/IMAP inbox for new recruiter emails.
//     Concurrency: 5 (I/O-bound, safe to parallelize)
//
//  2. followUpWorker — consumes 'followup-queue'
//     Sends scheduled follow-up emails.
//     Concurrency: 3
//
// DISTRIBUTED LOCKS (from previous implementation)
// ─────────────────────────────────────────────────
// syncWorker     → jh-lock:email-sync:{emailAccountId}
// followUpWorker → jh-lock:followup:{followUpId}
//
// RETRY & DLQ (this implementation)
// ──────────────────────────────────
// Retry config injected from index.ts via RETRY[queueName].
// Failure handler callback injected by the caller (index.ts),
// which wires it into the DLQ + alert pipeline.
// This keeps the processor free of startup concerns (Redis URL,
// secrets) while allowing the index to own the full pipeline.
// ============================================================

import { Worker, type Job } from 'bullmq';
import type { PrismaClient }  from '@prisma/client';
import { syncUserEmails }     from '../sync/emailSyncEngine.js';
import { FollowUpScheduler }  from '../followup/followUpScheduler.js';
import type { EmailSyncPayload, FollowUpPayload } from '../types/emailTypes.js';
import { getRedisConnection, getRedis } from '../utils/redis.js';
import { decryptToken }       from '../utils/crypto.js';
import { logger }             from '../utils/logger.js';
import {
  QUEUE_NAMES,
  RETRY,
  initLockClient,
  tryWithLock,
  withLock,
  LockKeys,
  TTL,
  LockContentionError,
} from '@job-hunter/shared';

export type FailureHandler = (job: Job | undefined, err: Error) => Promise<void>;

// ── Lock client init ──────────────────────────────────────────
let _lockInitialised = false;
function ensureLockClient(): void {
  if (_lockInitialised) return;
  initLockClient(getRedis(), { retryCount: 2, retryDelayMs: 500, retryJitterMs: 150 });
  _lockInitialised = true;
}

// ── Workers ───────────────────────────────────────────────────
let syncWorker:     Worker | null = null;
let followUpWorker: Worker | null = null;

export interface StartEmailWorkersOptions {
  prisma:         PrismaClient;
  prefix?:        string;
  onFailure?:     FailureHandler;
}

export function startEmailWorkers({ prisma, prefix = 'jhq', onFailure }: StartEmailWorkersOptions): {
  syncWorker: Worker;
  followUpWorker: Worker;
} {
  const redisConn       = getRedisConnection();
  const syncRetry       = RETRY[QUEUE_NAMES.EMAIL_MONITOR]!;
  const followUpRetry   = RETRY[QUEUE_NAMES.FOLLOW_UP]!;
  const queueOpts       = { connection: redisConn, prefix };

  // ── WORKER 1: Email sync ────────────────────────────────────
  syncWorker = new Worker<EmailSyncPayload>(
    QUEUE_NAMES.EMAIL_MONITOR,
    async (job: Job<EmailSyncPayload>) => {
      const { userId, emailAccountId } = job.data;
      ensureLockClient();

      logger.info('Email sync: starting', { jobId: job.id, userId, emailAccountId });
      await job.updateProgress(5);

      const account = await prisma.userEmailAccount.findUniqueOrThrow({
        where: { id: emailAccountId, userId },
      });

      if (!account.isActive) {
        logger.info('Email account deactivated — skip', { emailAccountId });
        return { skipped: true, reason: 'account_inactive' };
      }

      // Account-level lock: prevents two of the 5 concurrent workers
      // processing the same inbox simultaneously.
      const lockKey = LockKeys.emailSync(emailAccountId);
      const result = await tryWithLock(
        lockKey,
        TTL.EMAIL_SYNC,
        async (_lock) => {
          logger.debug('Email sync lock acquired', { lockKey, emailAccountId });
          await job.updateProgress(15);

          const accessToken  = account.accessToken  ? decryptToken(account.accessToken)  : null;
          const refreshToken = account.refreshToken ? decryptToken(account.refreshToken) : null;
          const imapPassword = account.imapPassword ? decryptToken(account.imapPassword) : null;

          return await syncUserEmails(prisma, {
            userId,
            accountEmail: account.email,
            provider:     account.provider.toLowerCase() as 'gmail' | 'outlook' | 'imap',
            lastSyncAt:   account.lastSyncAt ?? null,
            accessToken,
            refreshToken,
            imapPassword,
            imapHost: account.imapHost ?? null,
            imapPort: account.imapPort ?? null,
          });
        },
        { retryCount: 1, retryDelayMs: 800 },
      );

      if (result === null) {
        logger.warn('Email sync: skipped — account sync already in progress', {
          jobId: job.id, userId, emailAccountId, lockKey,
        });
        return { skipped: true, reason: 'lock_contended', emailAccountId };
      }

      await job.updateProgress(100);
      return result;
    },
    {
      ...queueOpts,
      concurrency: parseInt(process.env['EMAIL_CONCURRENCY'] ?? '5', 10),
      settings: { backoffStrategy: syncRetry.backoffStrategy },
    },
  );

  syncWorker.on('completed', (job, result) => {
    if ((result as Record<string, unknown>)?.skipped) {
      logger.info('Email sync skipped', {
        jobId: job.id, userId: job.data.userId,
        reason: (result as Record<string, unknown>)?.reason,
      });
    } else {
      logger.info('Email sync complete', {
        jobId:     job.id,
        userId:    job.data.userId,
        fetched:   (result as Record<string, unknown>)?.emailsFetched,
        threads:   (result as Record<string, unknown>)?.threadsUpdated,
        cancelled: (result as Record<string, unknown>)?.followUpsCancelled,
      });
    }
  });

  syncWorker.on('failed', (job, err) => {
    logger.error('Email sync failed', {
      jobId:  job?.id,
      userId: job?.data?.userId,
      error:  err.message,
      isLockContention: err instanceof LockContentionError,
    });
    // Delegate to index-level failure handler (DLQ + alerts)
    if (onFailure && !(err instanceof LockContentionError)) {
      void onFailure(job, err);
    }
  });

  // ── WORKER 2: Follow-up sender ──────────────────────────────
  const scheduler = new FollowUpScheduler(prisma, {
    host:   process.env['REDIS_HOST'] ?? 'localhost',
    port:   parseInt(process.env['REDIS_PORT'] ?? '6379'),
    prefix,
  });

  followUpWorker = new Worker<FollowUpPayload>(
    QUEUE_NAMES.FOLLOW_UP,
    async (job: Job<FollowUpPayload>) => {
      const { userId, applicationId, followUpId, followUpNumber } = job.data;
      ensureLockClient();

      logger.info('Follow-up: starting', { jobId: job.id, userId, applicationId, followUpNumber });
      await job.updateProgress(10);

      // Follow-up idempotency lock: prevents double-send on stall+retry
      const lockKey = LockKeys.followUp(followUpId);
      await withLock(
        lockKey,
        TTL.FOLLOW_UP,
        async (_lock) => {
          logger.debug('Follow-up lock acquired', { lockKey, followUpId });
          await job.updateProgress(30);
          await scheduler.executeFollowUp(job.data);
        },
        { retryCount: 1, retryDelayMs: 1_000 },
      );

      await job.updateProgress(100);
    },
    {
      ...queueOpts,
      concurrency: 3,
      settings: { backoffStrategy: followUpRetry.backoffStrategy },
    },
  );

  followUpWorker.on('completed', (job) => {
    logger.info('Follow-up sent', {
      jobId:         job.id,
      applicationId: job.data.applicationId,
      number:        job.data.followUpNumber,
    });
  });

  followUpWorker.on('failed', (job, err) => {
    logger.error('Follow-up failed', {
      jobId:         job?.id,
      applicationId: job?.data?.applicationId,
      number:        job?.data?.followUpNumber,
      error:         err.message,
      isLockContention: err instanceof LockContentionError,
    });
    if (onFailure && !(err instanceof LockContentionError)) {
      void onFailure(job, err);
    }
  });

  logger.info('Email workers started', {
    syncQueue:           QUEUE_NAMES.EMAIL_MONITOR,
    followUpQueue:       QUEUE_NAMES.FOLLOW_UP,
    syncConcurrency:     5,
    followUpConcurrency: 3,
    syncMaxAttempts:     syncRetry.maxAttempts,
    followMaxAttempts:   followUpRetry.maxAttempts,
  });

  return { syncWorker, followUpWorker };
}

export async function stopEmailWorkers(): Promise<void> {
  await Promise.all([
    syncWorker?.close().then(() => { syncWorker = null; }),
    followUpWorker?.close().then(() => { followUpWorker = null; }),
  ]);
  logger.info('Email workers stopped');
}
