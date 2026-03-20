// ============================================================
// AI Match Queue Worker
// Consumes jobs from 'ai-match-queue' and runs MatchScorer.
// ============================================================

import { Worker, type Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { MatchScorer } from './matchScorer.js';
import type { AiMatchPayload } from '../types.js';
import { logger } from '../utils/logger.js';
import { getRedisConnection } from '../utils/redis.js';

let matchWorker: Worker | null = null;

export function startMatchWorker(
  prisma: PrismaClient,
  redis: Redis,
): Worker {
  const concurrency = parseInt(process.env['AI_MATCH_CONCURRENCY'] ?? '10', 10);
  const scorer = new MatchScorer(prisma, redis);

  matchWorker = new Worker<AiMatchPayload>(
    'ai-match-queue',
    async (job: Job<AiMatchPayload>) => {
      const { userId, jobListingId, forceRescore } = job.data;

      logger.debug('Processing match job', { jobId: job.id, userId, jobListingId });

      await job.updateProgress(20);

      const analysis = await scorer.scoreOne({ userId, jobListingId, forceRescore });

      await job.updateProgress(100);

      // Return a lightweight summary (full analysis is in DB/cache)
      return {
        totalScore: analysis.totalScore,
        recommendation: analysis.recommendation,
        skillsRaw: analysis.skillsScore.raw,
        experienceRaw: analysis.experienceScore.raw,
        locationRaw: analysis.locationScore.raw,
        salaryRaw: analysis.salaryScore.raw,
        tokensUsed: analysis.tokensUsed,
      };
    },
    {
      connection: getRedisConnection(),
      prefix: process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
      concurrency,
      settings: {
        backoffStrategy: (attemptsMade) =>
          Math.min(10000 * Math.pow(2, attemptsMade - 1), 60000),
      },
    },
  );

  matchWorker.on('completed', (job, result) => {
    logger.debug('Match job completed', {
      jobId: job.id,
      score: result?.totalScore,
      recommendation: result?.recommendation,
    });
  });

  matchWorker.on('failed', (job, err) => {
    logger.error('Match job failed', {
      jobId: job?.id,
      userId: job?.data?.userId,
      error: err.message,
      attempts: job?.attemptsMade,
    });
  });

  matchWorker.on('error', (err) => {
    logger.error('Match worker error', { error: err.message });
  });

  logger.info(`AI match worker started (concurrency: ${concurrency})`);
  return matchWorker;
}

export async function stopMatchWorker(): Promise<void> {
  if (matchWorker) {
    await matchWorker.close();
    matchWorker = null;
    logger.info('Match worker stopped');
  }
}
