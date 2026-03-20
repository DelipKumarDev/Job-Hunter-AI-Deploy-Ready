// ============================================================
// Email Analyzer Worker
// Consumes 'analyze-email-queue' — concurrency 8.
// Each job receives a full email payload and runs the
// complete analysis pipeline, writing results to DB.
// ============================================================

import { Worker, Queue, type Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import { analyzeEmail }      from './emailAnalyzer.js';
import type { AnalyzeEmailPayload, EmailAnalysisResult } from './analyzerTypes.js';
import { logger } from '../utils/logger.js';

export const ANALYZE_QUEUE = 'analyze-email-queue';

let worker: Worker | null = null;
let analyzeQueue: Queue<AnalyzeEmailPayload> | null = null;

// ── Enqueue a single email for analysis ──────────────────────
export function getAnalyzeQueue(
  redisHost = process.env['REDIS_HOST'] ?? 'localhost',
  redisPort = parseInt(process.env['REDIS_PORT'] ?? '6379'),
): Queue<AnalyzeEmailPayload> {
  if (!analyzeQueue) {
    analyzeQueue = new Queue<AnalyzeEmailPayload>(ANALYZE_QUEUE, {
      connection: { host: redisHost, port: redisPort },
      prefix:     process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
    });
  }
  return analyzeQueue;
}

export async function enqueueEmailAnalysis(
  payload:  AnalyzeEmailPayload,
  priority: number = 3,
): Promise<void> {
  const q = getAnalyzeQueue();
  await q.add('analyze', payload, {
    priority,
    attempts:         3,
    jobId:            `analyze-${payload.emailId}`,   // Idempotent
    removeOnComplete: { count: 500 },
    removeOnFail:     { count: 100 },
    backoff:          { type: 'exponential', delay: 5000 },
  });
}

// ── Start the worker ──────────────────────────────────────────
export function startAnalyzerWorker(prisma: PrismaClient): Worker {
  const concurrency = parseInt(process.env['ANALYZER_CONCURRENCY'] ?? '8', 10);

  worker = new Worker<AnalyzeEmailPayload, EmailAnalysisResult>(
    ANALYZE_QUEUE,
    async (job: Job<AnalyzeEmailPayload>) => {
      logger.debug('Analyzer job start', {
        jobId:   job.id,
        emailId: job.data.emailId,
        from:    job.data.fromEmail,
      });
      await job.updateProgress(10);

      const result = await analyzeEmail(prisma, job.data);
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

  worker.on('completed', (job, result: EmailAnalysisResult) => {
    logger.info('✅ Email analyzed', {
      jobId:      job.id,
      emailId:    job.data.emailId,
      intent:     result.intent,
      confidence: Math.round(result.confidence * 100),
      actions:    result.actionsApplied.map(a => a.type),
    });
  });

  worker.on('failed', (job, err) => {
    logger.error('❌ Email analysis failed', {
      jobId:   job?.id,
      emailId: job?.data?.emailId,
      error:   err.message,
    });
  });

  logger.info('Email analyzer worker started', { concurrency, queue: ANALYZE_QUEUE });
  return worker;
}

export async function stopAnalyzerWorker(): Promise<void> {
  await worker?.close();
  await analyzeQueue?.close();
  worker = null;
  analyzeQueue = null;
  logger.info('Email analyzer worker stopped');
}
