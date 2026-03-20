// ============================================================
// worker-notification — Entry Point
// Consumes: notification-queue (concurrency 20)
// ============================================================

import { bootstrapNotificationWorkerSecrets } from '@job-hunter/shared/secrets';
const secrets = bootstrapNotificationWorkerSecrets();

import { PrismaClient }           from '@prisma/client';
import { connectRedis }           from './utils/redis.js';
import { logger }                 from './utils/logger.js';
import {
  startNotificationWorker,
  stopNotificationWorker,
} from './processors/notificationWorker.js';

async function main(): Promise<void> {
  logger.info('Starting notification worker');

  const prisma = new PrismaClient();
  await connectRedis(secrets.REDIS_URL);

  const worker = startNotificationWorker(prisma);

  worker.on('failed', (job, err) => {
    logger.error('Notification job failed', {
      jobId: job?.id,
      event: job?.data?.event,
      error: err.message,
      attempts: job?.attemptsMade,
    });
  });

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down notification worker');
    await stopNotificationWorker();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT',  () => void shutdown());
}

main().catch((err) => {
  logger.error('Notification worker failed to start', { error: (err as Error).message });
  process.exit(1);
});
