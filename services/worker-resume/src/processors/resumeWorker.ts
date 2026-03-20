// ============================================================
// Resume Parse Queue Worker
// Processes jobs from 'resume-parse-queue'
// ============================================================

import { Worker, type Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { runResumePipeline } from './resumePipeline.js';
import type { ResumeParsePayload } from '../types/resumeTypes.js';
import { logger } from '../utils/logger.js';
import { getRedisConnection } from '../utils/redis.js';

let worker: Worker | null = null;

export function startResumeWorker(prisma: PrismaClient): Worker {
  const concurrency = parseInt(process.env['RESUME_WORKER_CONCURRENCY'] ?? '5', 10);

  worker = new Worker<ResumeParsePayload>(
    'resume-parse-queue',
    async (job: Job<ResumeParsePayload>) => {
      const { resumeId, userId, fileType } = job.data;

      logger.info('Processing resume', { jobId: job.id, resumeId, userId, fileType });
      await job.updateProgress(10);

      const result = await runResumePipeline(prisma, job.data);

      await job.updateProgress(100);

      return {
        resumeId:        result.resumeId,
        skillsExtracted: result.skillsExtracted,
        techExtracted:   result.techExtracted,
        rolesExtracted:  result.rolesExtracted,
        experienceYears: result.experienceYears,
        educationCount:  result.educationCount,
        hasEmbedding:    !!result.embedding,
        processingMs:    result.processingMs,
        tokensUsed:      result.tokensUsed,
      };
    },
    {
      connection: getRedisConnection(),
      prefix: process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
      concurrency,
      settings: {
        backoffStrategy: (attempts) => Math.min(10000 * Math.pow(2, attempts - 1), 120000),
      },
    },
  );

  worker.on('completed', (job, result) => {
    logger.info('Resume parsed', {
      jobId:  job.id,
      skills: result?.skillsExtracted,
      tech:   result?.techExtracted,
      years:  result?.experienceYears,
      ms:     result?.processingMs,
    });
  });

  worker.on('failed', (job, err) => {
    logger.error('Resume parse failed', {
      jobId:    job?.id,
      resumeId: job?.data?.resumeId,
      error:    err.message,
      attempts: job?.attemptsMade,
    });
  });

  logger.info(`Resume worker started (concurrency: ${concurrency})`);
  return worker;
}

export async function stopResumeWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('Resume worker stopped');
  }
}
