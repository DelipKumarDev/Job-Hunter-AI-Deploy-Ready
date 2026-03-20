// ============================================================
// worker-resume — Entry Point
// Consumes: resume-tailor-queue (concurrency 5)
// ============================================================

import { bootstrapResumeWorkerSecrets } from '@job-hunter/shared/secrets';
const secrets = bootstrapResumeWorkerSecrets();

import { PrismaClient }      from '@prisma/client';
import { connectRedis }      from './utils/redis.js';
import { logger }            from './utils/logger.js';
import {
  startResumeWorker,
  stopResumeWorker,
} from './processors/resumeWorker.js';

async function main(): Promise<void> {
  logger.info('Starting resume worker');

  const prisma = new PrismaClient();
  await connectRedis(secrets.REDIS_URL);

  const worker = startResumeWorker(prisma);

  worker.on('failed', (job, err) => {
    logger.error('Resume job failed', {
      jobId:    job?.id,
      resumeId: job?.data?.resumeId,
      error:    err.message,
      attempts: job?.attemptsMade,
    });
  });

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down resume worker');
    await stopResumeWorker();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT',  () => void shutdown());
}

main().catch((err) => {
  logger.error('Resume worker failed to start', { error: (err as Error).message });
  process.exit(1);
});
