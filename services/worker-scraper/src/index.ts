// ============================================================
// worker-scraper — Entry Point
// Logging:  Pino (structured JSON → Promtail → Loki)
// Metrics:  prom-client on :9100/metrics (Prometheus scrapes)
// ============================================================

import { bootstrapScraperSecrets } from '@job-hunter/shared/secrets';
const secrets = bootstrapScraperSecrets();

import { PrismaClient }                          from '@prisma/client';
import { connectRedis, getRedis }                from './utils/redis.js';
import { createLogger }                          from '@job-hunter/shared';
import type { Job }                              from 'bullmq';
import { Worker }                                from 'bullmq';
import {
  QUEUE_NAMES,
  RETRY,
  initDeadLetterQueue,
  maybeMoveToDeadLetter,
  handleJobFailure,
  createMonitor,
  LockContentionError,
  initWorkerMetrics,
  closeMetricsServer,
} from '@job-hunter/shared';
import type { DeadLetterEntry } from '@job-hunter/shared';
import { startScraperWorker, stopScraperWorker } from './processors/scraperWorker.js';

const SERVICE     = 'worker-scraper';
const PREFIX      = process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq';
const retryConfig = RETRY[QUEUE_NAMES.JOB_DISCOVERY]!;

const logger = createLogger(SERVICE);

async function main(): Promise<void> {
  logger.info({ queue: QUEUE_NAMES.JOB_DISCOVERY, maxAttempts: retryConfig.maxAttempts },
    'Starting worker-scraper');

  // ── Init in order: DB → Redis → Metrics → DLQ → Monitor → Worker ──
  const prisma = new PrismaClient();
  await connectRedis(secrets.REDIS_URL);
  const redis  = getRedis();

  // Prometheus metrics server on :9100
  const metrics = await initWorkerMetrics(SERVICE);
  logger.info({ port: 9100 }, 'Metrics server ready');

  initDeadLetterQueue(secrets.REDIS_URL, PREFIX);

  const monitor = createMonitor(secrets.REDIS_URL, [QUEUE_NAMES.JOB_DISCOVERY], PREFIX);
  monitor.setAlertHandler((alert) => logger.warn(alert, 'Queue monitor alert'));
  monitor.start();

  // ── Worker ──────────────────────────────────────────────────
  const worker = startScraperWorker(prisma);
  const alertCtx = { redis, redisUrl: secrets.REDIS_URL, workerService: SERVICE, prefix: PREFIX };

  // Track in-flight count
  worker.on('active', (job) => {
    metrics.workerJobActive.labels({
      queue:          QUEUE_NAMES.JOB_DISCOVERY,
      worker_service: SERVICE,
    }).inc();
    logger.debug({ jobId: job.id, platform: job.data.platform }, 'Job active');
  });

  worker.on('completed', (job, result) => {
    const durationMs = (result as Record<string, unknown>)?.durationMs as number ?? 0;
    const skipped    = (result as Record<string, unknown>)?.skipped as boolean ?? false;
    const status     = skipped ? 'skipped' : 'completed';

    metrics.workerJobActive.labels({
      queue: QUEUE_NAMES.JOB_DISCOVERY, worker_service: SERVICE,
    }).dec();
    metrics.recordJob(QUEUE_NAMES.JOB_DISCOVERY, SERVICE, status, durationMs);

    logger.info({
      jobId:    job.id,
      platform: job.data.platform,
      durationMs,
      status,
      jobsNew: (result as Record<string, unknown>)?.jobsNew,
    }, 'Scraper job completed');
  });

  worker.on('failed', async (job: Job | undefined, err: Error) => {
    if (err instanceof LockContentionError) return;

    const jobId = job?.id ?? 'unknown';
    metrics.workerJobActive.labels({
      queue: QUEUE_NAMES.JOB_DISCOVERY, worker_service: SERVICE,
    }).dec();
    metrics.recordJob(QUEUE_NAMES.JOB_DISCOVERY, SERVICE, 'failed', 0);

    logger.error({ jobId, error: err.message, attempts: job?.attemptsMade }, 'Scraper job failed');

    const disposition = await maybeMoveToDeadLetter(redis, job, err, SERVICE);
    const dlqEntry: DeadLetterEntry | null = disposition === 'dlq'
      ? { sourceQueue: QUEUE_NAMES.JOB_DISCOVERY, sourceJobId: jobId, name: job?.name ?? 'discover',
          workerService: SERVICE, userId: (job?.data as Record<string, unknown>)?.userId as string | null ?? null,
          payload: job?.data, failureChain: [], finalError: err.message, finalStack: err.stack,
          totalAttempts: job?.attemptsMade ?? 0, firstFailedAt: new Date().toISOString(),
          movedToDlqAt: new Date().toISOString(), remediationHint: '' }
      : null;

    await handleJobFailure(alertCtx, job, err, dlqEntry);
  });

  worker.on('stalled', (jobId: string) => {
    logger.warn({ jobId }, 'Scraper job stalled');
  });

  // ── Health log every 5 min ───────────────────────────────────
  setInterval(() => {
    const h = monitor.getHealth();
    logger.info({ score: h.overallScore, status: h.status, dlqDepth: h.dlqTotalDepth },
      'Queue health');
  }, 5 * 60_000);

  // ── Graceful shutdown ────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down worker-scraper');
    await stopScraperWorker();
    await monitor.stop();
    await closeMetricsServer();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT',  () => void shutdown());

  logger.info({ queue: QUEUE_NAMES.JOB_DISCOVERY, maxAttempts: retryConfig.maxAttempts,
    backoff: '10s exponential, max 5 min' }, 'worker-scraper ready');
}

main().catch((err) => {
  logger.error({ error: (err as Error).message }, 'worker-scraper startup failed');
  process.exit(1);
});
