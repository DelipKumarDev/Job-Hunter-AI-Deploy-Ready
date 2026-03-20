// ============================================================
// worker-bot — Entry Point
// Logging:  Pino → Promtail → Loki
// Metrics:  BotMetrics on :9100/metrics
//   - bot_applications_total{status, portal}
//   - bot_session_duration_seconds{portal, status}
//   - bot_captcha_encounters_total{vendor, portal}
//   - worker_job_duration_seconds{queue, status}
// ============================================================

import { bootstrapBotWorkerSecrets } from '@job-hunter/shared/secrets';
const secrets = bootstrapBotWorkerSecrets();

import { PrismaClient }                    from '@prisma/client';
import { connectRedis, getRedis }          from './utils/redis.js';
import { createLogger }                    from '@job-hunter/shared';
import type { Job }                        from 'bullmq';
import {
  QUEUE_NAMES,
  RETRY,
  initDeadLetterQueue,
  maybeMoveToDeadLetter,
  handleJobFailure,
  createMonitor,
  LockContentionError,
  initWorkerMetrics,
  getBotMetrics,
  extractPortal,
  closeMetricsServer,
} from '@job-hunter/shared';
import type { DeadLetterEntry } from '@job-hunter/shared';
import { startBotWorker, stopBotWorker } from './processors/botWorker.js';
import type { BotRunResult, BotJobPayload } from './types/botTypes.js';

const SERVICE     = 'worker-bot';
const PREFIX      = process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq';
const retryConfig = RETRY[QUEUE_NAMES.JOB_APPLY]!;

const logger = createLogger(SERVICE);

async function main(): Promise<void> {
  logger.info({ queue: QUEUE_NAMES.JOB_APPLY, maxAttempts: retryConfig.maxAttempts },
    'Starting worker-bot');

  const prisma = new PrismaClient();
  await connectRedis(secrets.REDIS_URL);
  const redis  = getRedis();

  // BotMetrics is a superset of WorkerMetrics (isBot=true)
  await initWorkerMetrics(SERVICE, true);
  logger.info({ port: 9100 }, 'Metrics server ready');

  initDeadLetterQueue(secrets.REDIS_URL, PREFIX);

  const monitor = createMonitor(secrets.REDIS_URL, [QUEUE_NAMES.JOB_APPLY], PREFIX);
  monitor.setAlertHandler((alert) => logger.warn(alert, 'Bot queue alert'));
  monitor.start();

  // ── Worker ──────────────────────────────────────────────────
  const worker = startBotWorker(prisma);
  const alertCtx = { redis, redisUrl: secrets.REDIS_URL, workerService: SERVICE, prefix: PREFIX };

  worker.on('active', (job) => {
    getBotMetrics().workerJobActive.labels({
      queue: QUEUE_NAMES.JOB_APPLY, worker_service: SERVICE,
    }).inc();
    logger.debug({ jobId: job.id, applicationId: job.data.applicationId }, 'Bot job active');
  });

  worker.on('completed', (job, result) => {
    const r      = result as BotRunResult;
    const data   = job.data as BotJobPayload;
    const portal = extractPortal(data.applyUrl ?? '');
    const bm     = getBotMetrics();

    bm.workerJobActive.labels({ queue: QUEUE_NAMES.JOB_APPLY, worker_service: SERVICE }).dec();

    if (r?.status === 'skipped') {
      // Lock contention skip — not a real failure, don't record as such
      logger.info({ jobId: job.id, appId: data.applicationId }, 'Bot job skipped (duplicate)');
      return;
    }

    // Record full bot application metrics
    bm.recordApplication({
      status:       r?.status ?? 'unknown',
      portal,
      durationMs:   r?.durationMs ?? 0,
      fieldsFilled: r?.fieldsFilled ?? 0,
    });

    // Extract captcha vendor from warnings if present
    const captchaWarning = r?.warnings?.find(w => w.startsWith('captcha:'));
    if (captchaWarning) {
      const vendor = captchaWarning.split(':')[1] ?? 'unknown';
      bm.botCaptchaEncounters.labels({ vendor, portal }).inc();
    }

    logger.info({
      jobId:          job.id,
      applicationId:  data.applicationId,
      status:         r?.status,
      portal,
      durationMs:     r?.durationMs,
      fieldsFilled:   r?.fieldsFilled,
      stepsCompleted: r?.stepsCompleted,
    }, 'Bot job completed');
  });

  worker.on('failed', async (job: Job | undefined, err: Error) => {
    if (err instanceof LockContentionError) return;

    const jobId  = job?.id ?? 'unknown';
    const data   = job?.data as BotJobPayload | undefined;
    const portal = extractPortal(data?.applyUrl ?? '');
    const bm     = getBotMetrics();

    bm.workerJobActive.labels({ queue: QUEUE_NAMES.JOB_APPLY, worker_service: SERVICE }).dec();
    bm.recordApplication({ status: 'failed', portal, durationMs: 0, fieldsFilled: 0 });

    logger.error({
      jobId, error: err.message,
      applicationId: data?.applicationId,
      attempts: job?.attemptsMade,
      portal,
    }, 'Bot job failed');

    const disposition = await maybeMoveToDeadLetter(redis, job, err, SERVICE);
    const dlqEntry: DeadLetterEntry | null = disposition === 'dlq'
      ? { sourceQueue: QUEUE_NAMES.JOB_APPLY, sourceJobId: jobId, name: job?.name ?? 'apply',
          workerService: SERVICE, userId: data?.userId ?? null, payload: job?.data,
          failureChain: [], finalError: err.message, finalStack: err.stack,
          totalAttempts: job?.attemptsMade ?? 0, firstFailedAt: new Date().toISOString(),
          movedToDlqAt: new Date().toISOString(), remediationHint: '' }
      : null;

    await handleJobFailure(alertCtx, job, err, dlqEntry);
  });

  worker.on('stalled', (jobId: string) => {
    logger.warn({ jobId }, 'Bot job stalled — browser may have crashed');
  });

  // ── Health log ───────────────────────────────────────────────
  setInterval(() => {
    const h = monitor.getHealth();
    logger.info({ score: h.overallScore, status: h.status, dlqDepth: h.dlqTotalDepth },
      'Bot queue health');
  }, 5 * 60_000);

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down worker-bot');
    await stopBotWorker();
    await monitor.stop();
    await closeMetricsServer();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT',  () => void shutdown());

  logger.info({ queue: QUEUE_NAMES.JOB_APPLY, maxAttempts: retryConfig.maxAttempts,
    backoff: '10s exponential, max 10 min' }, 'worker-bot ready');
}

main().catch((err) => {
  logger.error({ error: (err as Error).message }, 'worker-bot startup failed');
  process.exit(1);
});
