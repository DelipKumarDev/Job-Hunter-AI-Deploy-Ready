// ============================================================
// worker-email — Entry Point
// Logging:  Pino → Promtail → Loki
// Metrics:  WorkerMetrics on :9100/metrics
// ============================================================

import { bootstrapEmailWorkerSecrets } from '@job-hunter/shared/secrets';
const secrets = bootstrapEmailWorkerSecrets();

import { PrismaClient }                         from '@prisma/client';
import { connectRedis, getRedis }               from './utils/redis.js';
import { createLogger }                         from '@job-hunter/shared';
import type { Job }                             from 'bullmq';
import {
  QUEUE_NAMES,
  RETRY,
  initDeadLetterQueue,
  maybeMoveToDeadLetter,
  handleJobFailure,
  createMonitor,
  LockContentionError,
  initWorkerMetrics,
  getWorkerMetrics,
  closeMetricsServer,
} from '@job-hunter/shared';
import type { DeadLetterEntry }                 from '@job-hunter/shared';
import { startEmailWorkers, stopEmailWorkers }  from './processors/emailWorkers.js';

const SERVICE     = 'worker-email';
const PREFIX      = process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq';
const syncRetry   = RETRY[QUEUE_NAMES.EMAIL_MONITOR]!;
const followRetry = RETRY[QUEUE_NAMES.FOLLOW_UP]!;

const logger = createLogger(SERVICE);

async function main(): Promise<void> {
  logger.info({
    syncQueue: QUEUE_NAMES.EMAIL_MONITOR,
    followQueue: QUEUE_NAMES.FOLLOW_UP,
    syncMaxAttempts: syncRetry.maxAttempts,
    followMaxAttempts: followRetry.maxAttempts,
  }, 'Starting worker-email');

  const prisma = new PrismaClient();
  await connectRedis(secrets.REDIS_URL);
  const redis  = getRedis();

  await initWorkerMetrics(SERVICE);
  logger.info({ port: 9100 }, 'Metrics server ready');

  initDeadLetterQueue(secrets.REDIS_URL, PREFIX);

  const monitor = createMonitor(
    secrets.REDIS_URL,
    [QUEUE_NAMES.EMAIL_MONITOR, QUEUE_NAMES.FOLLOW_UP],
    PREFIX,
  );
  monitor.setAlertHandler((alert) => logger.warn(alert, 'Email queue alert'));
  monitor.start();

  // ── Shared failure handler ───────────────────────────────────
  const alertCtx = { redis, redisUrl: secrets.REDIS_URL, workerService: SERVICE, prefix: PREFIX };

  async function onFailure(job: Job | undefined, err: Error): Promise<void> {
    if (err instanceof LockContentionError) return;

    const jobId = job?.id ?? 'unknown';
    const queue = job?.queueName ?? 'unknown';
    const m     = getWorkerMetrics();

    m.workerJobActive.labels({ queue, worker_service: SERVICE }).dec();
    m.recordJob(queue, SERVICE, 'failed', 0);

    logger.error({ jobId, queue, error: err.message, attempts: job?.attemptsMade }, 'Email job failed');

    const disposition = await maybeMoveToDeadLetter(redis, job, err, SERVICE);
    const dlqEntry: DeadLetterEntry | null = disposition === 'dlq'
      ? { sourceQueue: queue, sourceJobId: jobId, name: job?.name ?? 'task',
          workerService: SERVICE, userId: (job?.data as Record<string, unknown>)?.userId as string | null ?? null,
          payload: job?.data, failureChain: [], finalError: err.message, finalStack: err.stack,
          totalAttempts: job?.attemptsMade ?? 0, firstFailedAt: new Date().toISOString(),
          movedToDlqAt: new Date().toISOString(), remediationHint: '' }
      : null;

    await handleJobFailure(alertCtx, job, err, dlqEntry);
  }

  // ── Start workers ────────────────────────────────────────────
  const { syncWorker, followUpWorker } = startEmailWorkers({ prisma, prefix: PREFIX, onFailure });

  // ── Metrics hooks ────────────────────────────────────────────
  const hookWorker = (w: typeof syncWorker, queueName: string): void => {
    const m = getWorkerMetrics();

    w.on('active', () =>
      m.workerJobActive.labels({ queue: queueName, worker_service: SERVICE }).inc()
    );
    w.on('completed', (job, result) => {
      const skipped = (result as Record<string, unknown>)?.skipped ?? false;
      m.workerJobActive.labels({ queue: queueName, worker_service: SERVICE }).dec();
      if (!skipped) {
        m.recordJob(queueName, SERVICE, 'completed', 0);
      }
      logger.info({ jobId: job.id, queue: queueName }, 'Email job completed');
    });
    w.on('stalled', (id) => logger.warn({ jobId: id, queue: queueName }, 'Email job stalled'));
  };

  hookWorker(syncWorker, QUEUE_NAMES.EMAIL_MONITOR);
  hookWorker(followUpWorker, QUEUE_NAMES.FOLLOW_UP);

  // ── Health log ───────────────────────────────────────────────
  setInterval(() => {
    const h = monitor.getHealth();
    logger.info({
      overallScore: h.overallScore,
      status: h.status,
      dlqDepth: h.dlqTotalDepth,
      queues: h.queues.map(q => ({
        name: q.queue, score: q.score, failureRate: q.window1h.failureRate,
      })),
    }, 'Email worker health');
  }, 5 * 60_000);

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down worker-email');
    await stopEmailWorkers();
    await monitor.stop();
    await closeMetricsServer();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT',  () => void shutdown());

  logger.info({
    syncQueue: QUEUE_NAMES.EMAIL_MONITOR,
    followQueue: QUEUE_NAMES.FOLLOW_UP,
    syncMaxAttempts: syncRetry.maxAttempts,
    followMaxAttempts: followRetry.maxAttempts,
  }, 'worker-email ready');
}

main().catch((err) => {
  logger.error({ error: (err as Error).message }, 'worker-email startup failed');
  process.exit(1);
});
