// ============================================================
// worker-prep — Entry Point
// Consumes: interview-prep-queue (concurrency 3)
//           resume-tailor-queue  (concurrency 3)
// ============================================================

import { bootstrapPrepWorkerSecrets } from '@job-hunter/shared/secrets';
const secrets = bootstrapPrepWorkerSecrets();

import { PrismaClient }    from '@prisma/client';
import { connectRedis }    from './utils/redis.js';
import { logger }          from './utils/logger.js';
import {
  startPrepWorker,
  startResumeTailorWorker,
  stopResumeTailorWorker,
} from './processors/prepOrchestrator.js';

async function main(): Promise<void> {
  logger.info('Starting prep worker (interview-prep + resume-tailor)');

  const prisma = new PrismaClient();
  await connectRedis(secrets.REDIS_URL);

  // Start both workers in this process
  const prepWorker   = startPrepWorker(prisma);
  const tailorWorker = startResumeTailorWorker(prisma);

  prepWorker.on('failed', (job, err) => {
    logger.error('Prep job failed', {
      jobId: job?.id, applicationId: job?.data?.applicationId,
      error: err.message, attempts: job?.attemptsMade,
    });
  });

  tailorWorker.on('failed', (job, err) => {
    logger.error('Resume tailor job failed', {
      jobId: job?.id, error: err.message, attempts: job?.attemptsMade,
    });
  });

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down prep worker');
    await Promise.all([prepWorker.close(), stopResumeTailorWorker()]);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT',  () => void shutdown());

  logger.info('Prep worker ready');
}

main().catch((err) => {
  logger.error('Prep worker failed to start', { error: (err as Error).message });
  process.exit(1);
});
