// ============================================================
// Notification Worker
// Consumes 'notification-queue' (concurrency 20).
// Also runs daily digest cron at 8am UTC.
// ============================================================

import { Worker, Queue, type Job } from 'bullmq';
import { CronJob } from 'cron';
import type { PrismaClient } from '@prisma/client';
import { dispatch } from './notificationDispatcher.js';
import type { WhatsAppJobPayload } from '../types/notificationTypes.js';
import { logger } from '../utils/logger.js';

const QUEUE_NAME = 'notification-queue';
let worker: Worker | null = null;
let digestCron: CronJob | null = null;
let notifQueue: Queue<WhatsAppJobPayload> | null = null;

// ── Get queue handle (singleton) ──────────────────────────────
export function getNotificationQueue(): Queue<WhatsAppJobPayload> {
  if (!notifQueue) {
    notifQueue = new Queue<WhatsAppJobPayload>(QUEUE_NAME, {
      connection: {
        host: process.env['REDIS_HOST'] ?? 'localhost',
        port: parseInt(process.env['REDIS_PORT'] ?? '6379'),
      },
      prefix: process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
    });
  }
  return notifQueue;
}

// ── Enqueue a notification ────────────────────────────────────
export async function enqueueNotification(
  payload:  WhatsAppJobPayload,
  priority: number = 5,
  delaySec: number = 0,
): Promise<void> {
  const q = getNotificationQueue();
  await q.add('notify', payload, {
    priority,
    delay:    delaySec * 1000,
    attempts: 3,
    backoff:  { type: 'exponential', delay: 10_000 },
    removeOnComplete: { count: 1000 },
    removeOnFail:     { count:  200 },
  });
}

// ── Start worker ──────────────────────────────────────────────
export function startNotificationWorker(prisma: PrismaClient): Worker {
  const concurrency = parseInt(process.env['NOTIF_CONCURRENCY'] ?? '20', 10);

  worker = new Worker<WhatsAppJobPayload>(
    QUEUE_NAME,
    async (job: Job<WhatsAppJobPayload>) => {
      logger.debug('Notification job', { jobId: job.id, event: job.data.event, userId: job.data.userId });
      await job.updateProgress(10);
      const result = await dispatch(prisma, job.data);
      await job.updateProgress(100);
      return result;
    },
    {
      connection: {
        host: process.env['REDIS_HOST'] ?? 'localhost',
        port: parseInt(process.env['REDIS_PORT'] ?? '6379'),
      },
      prefix:      process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
      concurrency,
    },
  );

  worker.on('completed', (job, result) => {
    logger.info('✅ Notification sent', {
      jobId:    job.id,
      event:    job.data.event,
      success:  result?.success,
      messages: result?.messageIds?.length,
    });
  });

  worker.on('failed', (job, err) => {
    logger.error('❌ Notification failed', {
      jobId:  job?.id,
      event:  job?.data?.event,
      error:  err.message,
    });
  });

  // ── Daily digest cron: 8:00am UTC every day ───────────────
  const digestCronExpr = process.env['DIGEST_CRON'] ?? '0 8 * * *';
  digestCron = new CronJob(
    digestCronExpr,
    () => scheduleDailyDigests(prisma).catch(e =>
      logger.error('Daily digest cron error', { error: String(e) })
    ),
    null, true, 'UTC',
  );

  logger.info('Notification worker started', {
    concurrency,
    queue:       QUEUE_NAME,
    digestCron:  digestCronExpr,
  });

  return worker;
}

// ── Schedule digest for every opted-in user ──────────────────
async function scheduleDailyDigests(prisma: PrismaClient): Promise<void> {
  const users = await prisma.user.findMany({
    where: {
      isActive:                true,
      profile: { whatsappNumber: { not: null } },
    },
    select: { id: true },
  });

  logger.info(`Scheduling daily digest for ${users.length} users`);

  for (let i = 0; i < users.length; i++) {
    await enqueueNotification(
      { userId: users[i]!.id, event: 'daily_digest' },
      10,           // Low priority
      i * 2,        // 2s stagger between users
    );
  }
}

// ── Stop ──────────────────────────────────────────────────────
export async function stopNotificationWorker(): Promise<void> {
  digestCron?.stop();
  await worker?.close();
  await notifQueue?.close();
  worker = null; notifQueue = null; digestCron = null;
  logger.info('Notification worker stopped');
}
