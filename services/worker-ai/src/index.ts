// ============================================================
// worker-ai — Entry Point
// Consumes: ai-match-queue (concurrency 10)
// ============================================================

import { bootstrapAIWorkerSecrets } from '@job-hunter/shared/secrets';
const secrets = bootstrapAIWorkerSecrets();

import { PrismaClient }     from '@prisma/client';
import { connectRedis, getRedis } from './utils/redis.js';
import { connectClaude }    from './utils/claudeClient.js';
import { logger }           from './utils/logger.js';
import {
  startMatchWorker,
  stopMatchWorker,
} from './processors/matchWorker.js';

const CONCURRENCY = parseInt(process.env['AI_CONCURRENCY'] ?? process.env['AI_MATCH_CONCURRENCY'] ?? '10', 10);

async function main(): Promise<void> {
  logger.info('Starting AI match worker', { concurrency: CONCURRENCY });

  const prisma = new PrismaClient();
  await connectRedis(secrets.REDIS_URL);
  connectClaude(secrets.ANTHROPIC_API_KEY);

  const redis  = getRedis();
  const worker = startMatchWorker(prisma, redis);

  worker.on('failed', (job, err) => {
    logger.error('AI match job failed', {
      jobId:       job?.id,
      userId:      job?.data?.userId,
      jobListingId: job?.data?.jobListingId,
      error:       err.message,
      attempts:    job?.attemptsMade,
    });
  });

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down AI match worker');
    await stopMatchWorker();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT',  () => void shutdown());

  logger.info('AI match worker ready', { queue: 'ai-match-queue', concurrency: CONCURRENCY });
}

main().catch((err) => {
  logger.error('AI match worker failed to start', { error: (err as Error).message });
  process.exit(1);
});
