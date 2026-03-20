// ============================================================
// Interview Prep — Orchestrator, Worker & API Routes
//
// Orchestrator runs the full pipeline:
//   Step 1: Analyze JD  (jdAnalyzer)
//   Step 2: Research company  (jdAnalyzer → Claude + web)
//   Step 3: Generate questions  (questionGenerator)
//   Step 4: Generate answers  (answerGenerator)
//   Step 5: Build prep topics  (topicGenerator)
//   Step 6: Tailor resume  (resumeTailor)
//   Step 7: Generate PDFs  (pdfGenerator × 2)
//   Step 8: Persist to DB
//   Step 9: Trigger WhatsApp notification
//
// API Routes:
//   POST /api/v1/prep/generate/:applicationId   Trigger generation
//   GET  /api/v1/prep/:applicationId            Get prep package
//   GET  /api/v1/prep/:applicationId/pdf        Download PDF
//   POST /api/v1/prep/:applicationId/regenerate Regenerate section
//   GET  /api/v1/prep/history                   User's prep history
// ============================================================

import { randomUUID }   from 'crypto';
import { Router }       from 'express';
import { Worker, Queue, type Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { z }            from 'zod';
import { analyzeJobDescription, analyzeCompany } from '../analyzer/jdAnalyzer.js';
import { generateQuestions }                     from '../questions/questionGenerator.js';
import { generateAnswers }                       from '../answers/answerGenerator.js';
import { generateTopics }                        from '../topics/topicGenerator.js';
import { tailorResume }                          from '../tailor/resumeTailor.js';
import { generatePrepPdf, generateTailoredResumePdf } from '../pdf/pdfGenerator.js';
import type { PrepInput, PrepPackage, PrepJobPayload, ResumeTailorPayload } from '../types/prepTypes.js';
import { getRedisConnection } from '../utils/redis.js';
import { logger } from '../utils/logger.js';

const QUEUE_NAME = 'interview-prep-queue';
const prisma     = new PrismaClient();

// ─────────────────────────────────────────────────────────────
// MAIN ORCHESTRATOR
// ─────────────────────────────────────────────────────────────
export async function runPrepPipeline(input: PrepInput): Promise<PrepPackage> {
  const startMs = Date.now();
  const id      = randomUUID();
  let tokensUsed = 0;

  logger.info('Starting prep pipeline', {
    company: input.companyName,
    role:    input.jobTitle,
    format:  input.interviewFormat,
  });

  // ── Step 1: Analyze JD ────────────────────────────────────
  logger.debug('Step 1: JD analysis');
  const jdAnalysis = await analyzeJobDescription(input);

  // ── Step 2: Company research ──────────────────────────────
  logger.debug('Step 2: Company research');
  const companyAnalysis = await analyzeCompany(input);

  // ── Step 3: Generate questions ────────────────────────────
  logger.debug('Step 3: Question generation');
  const questions = await generateQuestions(input, jdAnalysis, companyAnalysis);

  // ── Step 4: Generate answers ──────────────────────────────
  logger.debug('Step 4: Answer generation');
  const answers = await generateAnswers(input, questions);

  // ── Step 5: Prep topics ───────────────────────────────────
  logger.debug('Step 5: Topic generation');
  const topics = await generateTopics(input, jdAnalysis, companyAnalysis);

  // ── Step 6: Resume tailor ─────────────────────────────────
  let tailoredResume = null;
  if (input.includeResumeTailor) {
    logger.debug('Step 6: Resume tailoring');
    tailoredResume = await tailorResume(input, jdAnalysis);
  }

  // ── Build package ─────────────────────────────────────────
  const pkg: PrepPackage = {
    id,
    userId:        input.userId,
    applicationId: input.applicationId,
    generatedAt:   new Date(),
    companyAnalysis,
    questions,
    answers,
    topics,
    tailoredResume,
    totalQuestions: questions.length,
    tokensUsed,
    generationMs:  Date.now() - startMs,
    pdfUrl:        null,
  };

  // ── Step 7: Generate PDFs ─────────────────────────────────
  logger.debug('Step 7: PDF generation');
  try {
    const prepPdfBuffer    = await generatePrepPdf(pkg);
    const resumePdfBuffer  = tailoredResume ? await generateTailoredResumePdf(pkg) : null;

    // Store in /tmp for now — in production upload to S3
    const { writeFile } = await import('fs/promises');
    const prepPath   = `/tmp/prep-${id}.pdf`;
    const resumePath = `/tmp/tailored-resume-${id}.pdf`;

    await writeFile(prepPath, prepPdfBuffer);
    pkg.pdfUrl = prepPath;

    if (resumePdfBuffer) {
      await writeFile(resumePath, resumePdfBuffer);
    }

    logger.info('PDFs generated', {
      prepPdf:    prepPdfBuffer.length,
      resumePdf:  resumePdfBuffer?.length ?? 0,
    });
  } catch (err) {
    logger.warn('PDF generation failed — skipping', { error: String(err) });
  }

  // ── Step 8: Persist to DB ─────────────────────────────────
  logger.debug('Step 8: Persisting to DB');
  await persistPrepPackage(prisma, pkg, input);

  logger.info('✅ Prep pipeline complete', {
    company:   input.companyName,
    questions: pkg.totalQuestions,
    topics:    pkg.topics.length,
    answers:   pkg.answers.length,
    hasTailor: !!pkg.tailoredResume,
    totalMs:   pkg.generationMs,
  });

  return pkg;
}

// ─────────────────────────────────────────────────────────────
// PERSIST PACKAGE TO DB
// ─────────────────────────────────────────────────────────────
async function persistPrepPackage(
  prisma: PrismaClient,
  pkg:    PrepPackage,
  input:  PrepInput,
): Promise<void> {
  try {
    await prisma.$transaction(async tx => {
      // Store in interviewSchedule prep_doc_url if application exists
      if (input.applicationId) {
        await tx.application.update({
          where: { id: input.applicationId },
          data:  {
            prepPackage: pkg as unknown as import('@prisma/client').Prisma.JsonObject,
            prepGeneratedAt: new Date(),
          },
        }).catch(() => null); // prepPackage field may not exist yet
      }

      // Store as notification data for retrieval
      await tx.notification.create({
        data: {
          userId:  input.userId,
          type:    'PREP_PACKAGE_READY',
          channel: 'IN_APP',
          title:   `Interview prep ready — ${input.companyName}`,
          body:    `${pkg.totalQuestions} questions, ${pkg.topics.length} topics, tailored resume generated`,
          data:    {
            prepPackageId: pkg.id,
            applicationId: input.applicationId,
            companyName:   input.companyName,
            jobTitle:      input.jobTitle,
            questionCount: pkg.totalQuestions,
            topicCount:    pkg.topics.length,
            hasResumeTailor: !!pkg.tailoredResume,
            atsScore:      pkg.tailoredResume?.atsScore ?? null,
          } as import('@prisma/client').Prisma.JsonObject,
          isSent: false,
          isRead: false,
        },
      });
    });
  } catch (err) {
    logger.warn('DB persist failed (non-fatal)', { error: String(err) });
  }
}

// ─────────────────────────────────────────────────────────────
// BULLMQ WORKER
// ─────────────────────────────────────────────────────────────
let prepWorker: Worker | null = null;
let prepQueue:  Queue<PrepJobPayload> | null = null;

export function getPrepQueue(): Queue<PrepJobPayload> {
  if (!prepQueue) {
    prepQueue = new Queue<PrepJobPayload>(QUEUE_NAME, {
      connection: {
        host: process.env['REDIS_HOST'] ?? 'localhost',
        port: parseInt(process.env['REDIS_PORT'] ?? '6379'),
      },
      prefix: process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
    });
  }
  return prepQueue;
}

export async function enqueuePrepJob(payload: PrepJobPayload, priority = 2): Promise<void> {
  const q = getPrepQueue();
  await q.add('prep', payload, {
    priority,
    attempts:         2,
    jobId:            `prep-${payload.applicationId}`,
    removeOnComplete: { count: 200 },
    removeOnFail:     { count:  50 },
    backoff:          { type: 'exponential', delay: 15_000 },
  });
}

export function startPrepWorker(prismaClient: PrismaClient): Worker {
  const concurrency = parseInt(process.env['PREP_CONCURRENCY'] ?? '3', 10);

  prepWorker = new Worker<PrepJobPayload, PrepPackage>(
    QUEUE_NAME,
    async (job: Job<PrepJobPayload>) => {
      logger.info('Prep job started', { jobId: job.id, applicationId: job.data.applicationId });
      await job.updateProgress(5);

      // Load full input from DB
      const input = await loadPrepInput(prismaClient, job.data);
      await job.updateProgress(15);

      const pkg = await runPrepPipeline(input);
      await job.updateProgress(100);

      return pkg;
    },
    {
      connection: {
        host: process.env['REDIS_HOST'] ?? 'localhost',
        port: parseInt(process.env['REDIS_PORT'] ?? '6379'),
      },
      prefix:      process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
      concurrency,
      lockDuration: 10 * 60 * 1000, // 10 min — pipeline takes time
    },
  );

  prepWorker.on('completed', (job, pkg: PrepPackage) => {
    logger.info('✅ Prep package complete', {
      jobId:     job.id,
      questions: pkg.totalQuestions,
      topics:    pkg.topics.length,
      ms:        pkg.generationMs,
    });
  });

  prepWorker.on('failed', (job, err) => {
    logger.error('❌ Prep job failed', { jobId: job?.id, error: err.message });
  });

  logger.info('Interview prep worker started', { concurrency, queue: QUEUE_NAME });
  return prepWorker;
}

// ─────────────────────────────────────────────────────────────
// LOAD FULL PREP INPUT FROM DB
// ─────────────────────────────────────────────────────────────
async function loadPrepInput(
  prisma: PrismaClient,
  payload: PrepJobPayload,
): Promise<PrepInput> {
  const [app, user] = await Promise.all([
    prisma.application.findUniqueOrThrow({
      where:   { id: payload.applicationId },
      include: {
        jobListing: true,
        user: {
          include: {
            profile:  true,
            resumes:  { where: { isActive: true }, take: 1, orderBy: { createdAt: 'desc' } },
          },
        },
      },
    }),
    prisma.user.findUniqueOrThrow({
      where: { id: payload.userId },
      select: { name: true, email: true },
    }),
  ]);

  const resume   = app.user.resumes[0];
  const profile  = app.user.profile;
  const jl       = app.jobListing;

  return {
    userId:         payload.userId,
    applicationId:  payload.applicationId,
    jobDescription: jl.description ?? '',
    companyName:    jl.company,
    jobTitle:       jl.jobTitle,
    companyContext: jl.companyDescription ?? null,
    resumeText:     resume?.parsedText ?? '',
    resumeJson:     resume?.parsedJson ? JSON.parse(String(resume.parsedJson)) : null,
    interviewFormat: 'general',
    seniority:      (profile?.seniorityLevel?.toLowerCase() ?? 'mid') as PrepInput['seniority'],
    includeResumeTailor: true,
  };
}

// ─────────────────────────────────────────────────────────────
// REST API ROUTES
// ─────────────────────────────────────────────────────────────
export const prepRouter = Router();

// POST /prep/generate/:applicationId — trigger generation
const GenerateSchema = z.object({
  interviewFormat:     z.string().optional(),
  includeResumeTailor: z.boolean().default(true),
});

prepRouter.post('/prep/generate/:applicationId', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const appId  = req.params!['applicationId']!;
    const body   = GenerateSchema.parse(req.body);
    const sync   = req.query['sync'] === 'true';

    // Verify ownership
    const app = await prisma.application.findFirst({
      where: { id: appId, userId },
      include: {
        jobListing: true,
        user: {
          include: {
            profile: true,
            resumes: { where: { isActive: true }, take: 1, orderBy: { createdAt: 'desc' } },
          },
        },
      },
    });
    if (!app) return res.status(404).json({ success: false, error: 'Application not found' });

    const resume = app.user.resumes[0];
    const input: PrepInput = {
      userId,
      applicationId:   appId,
      jobDescription:  app.jobListing.description ?? '',
      companyName:     app.jobListing.company,
      jobTitle:        app.jobListing.jobTitle,
      companyContext:  null,
      resumeText:      resume?.parsedText ?? '',
      resumeJson:      null,
      interviewFormat: (body.interviewFormat ?? 'general') as PrepInput['interviewFormat'],
      seniority:       (app.user.profile?.seniorityLevel?.toLowerCase() ?? 'mid') as PrepInput['seniority'],
      includeResumeTailor: body.includeResumeTailor,
    };

    if (sync) {
      const pkg = await runPrepPipeline(input);
      return res.json({ success: true, data: pkg });
    }

    await enqueuePrepJob({ userId, applicationId: appId, prepInputId: appId });
    return res.json({
      success: true,
      data:    { queued: true, applicationId: appId, message: 'Prep package generation started' },
    });
  } catch (err) { next(err); }
});

// GET /prep/:applicationId — get prep package
prepRouter.get('/prep/:applicationId', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const appId  = req.params!['applicationId']!;

    const app = await prisma.application.findFirst({
      where:  { id: appId, userId },
      select: {
        id: true, status: true,
        prepPackage: true, prepGeneratedAt: true,
        jobListing: { select: { jobTitle: true, company: true } },
      },
    });

    if (!app) return res.status(404).json({ success: false, error: 'Application not found' });

    // Check queue status if not yet generated
    let queueStatus: string | null = null;
    if (!app.prepGeneratedAt) {
      const q   = getPrepQueue();
      const job = await q.getJob(`prep-${appId}`);
      queueStatus = job ? await job.getState() : null;
    }

    return res.json({
      success: true,
      data: {
        application:      app,
        prepPackage:      app.prepPackage ?? null,
        prepGeneratedAt:  app.prepGeneratedAt ?? null,
        queueStatus,
        isReady:          !!app.prepGeneratedAt,
      },
    });
  } catch (err) { next(err); }
});

// GET /prep/:applicationId/pdf — download prep PDF
prepRouter.get('/prep/:applicationId/pdf', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const appId  = req.params!['applicationId']!;
    const type   = (req.query['type'] as string) ?? 'guide'; // 'guide' | 'resume'

    const app = await prisma.application.findFirst({
      where:  { id: appId, userId },
      select: { prepPackage: true, jobListing: { select: { company: true, jobTitle: true } } },
    });

    if (!app?.prepPackage) {
      return res.status(404).json({ success: false, error: 'No prep package found. Generate one first.' });
    }

    const pkg = app.prepPackage as unknown as PrepPackage;

    const { readFile } = await import('fs/promises');
    const pdfPath = type === 'resume'
      ? `/tmp/tailored-resume-${pkg.id}.pdf`
      : `/tmp/prep-${pkg.id}.pdf`;

    try {
      const buf = await readFile(pdfPath);
      const filename = type === 'resume'
        ? `tailored-resume-${app.jobListing.company}.pdf`
        : `interview-prep-${app.jobListing.company}.pdf`;

      res.setHeader('Content-Type',        'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buf);
    } catch {
      // PDF expired from /tmp — regenerate
      const freshPkg = pkg;
      const buf = type === 'resume'
        ? await generateTailoredResumePdf(freshPkg)
        : await generatePrepPdf(freshPkg);

      if (!buf) return res.status(404).json({ success: false, error: 'PDF generation failed' });

      res.setHeader('Content-Type',        'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="prep-${type}.pdf"`);
      return res.send(buf);
    }
  } catch (err) { next(err); }
});

// GET /prep/history — all prep packages for user
prepRouter.get('/prep/history', async (req, res, next) => {
  try {
    const userId = req.user!.id;

    const apps = await prisma.application.findMany({
      where:   { userId, prepGeneratedAt: { not: null } },
      orderBy: { prepGeneratedAt: 'desc' },
      take:    20,
      select: {
        id: true, status: true, prepGeneratedAt: true,
        jobListing: { select: { jobTitle: true, company: true } },
      },
    });

    return res.json({ success: true, data: { prepHistory: apps } });
  } catch (err) { next(err); }
});

// ── Resume tailor worker (separate queue) ─────────────────────
// The API can enqueue standalone resume tailoring jobs via
// 'resume-tailor-queue' for quick re-tailors without full prep.

import type { ResumeTailorPayload } from '../types/prepTypes.js';

let tailorWorker: Worker | null = null;

export function startResumeTailorWorker(prismaClient: PrismaClient): Worker {
  const concurrency = parseInt(process.env['PREP_CONCURRENCY'] ?? '3', 10);

  tailorWorker = new Worker<ResumeTailorPayload>(
    'resume-tailor-queue',
    async (job) => {
      logger.info('Resume tailor job started', { jobId: job.id, ...job.data });
      await job.updateProgress(10);

      const input = await loadPrepInput(prismaClient, {
        userId:        job.data.userId,
        applicationId: job.data.applicationId ?? '',
        jobListingId:  job.data.jobListingId,
        resumeId:      job.data.resumeId,
      });
      await job.updateProgress(40);

      const tailored = await tailorResume(input, await analyzeJobDescription(input));
      await job.updateProgress(90);

      // Persist tailored resume URL if generated
      if (tailored && job.data.applicationId) {
        await prismaClient.application.update({
          where: { id: job.data.applicationId },
          data:  {
            // Store tailored resume reference - in full flow this would link to TailoredResume record
            notes: `Tailored resume generated for ${job.data.jobListingId}`,
          },
        }).catch(() => null);
      }

      await job.updateProgress(100);
      return { tailored: !!tailored };
    },
    {
      connection: getRedisConnection(),
      prefix:     process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
      concurrency,
      settings: {
        backoffStrategy: (attempts: number) =>
          Math.min(15_000 * Math.pow(2, attempts - 1), 300_000),
      },
    },
  );

  tailorWorker.on('completed', (job) =>
    logger.info('Resume tailor complete', { jobId: job.id })
  );
  tailorWorker.on('failed', (job, err) =>
    logger.error('Resume tailor failed', { jobId: job?.id, error: err.message })
  );

  logger.info('Resume tailor worker started', { queue: 'resume-tailor-queue', concurrency });
  return tailorWorker;
}

export async function stopResumeTailorWorker(): Promise<void> {
  if (tailorWorker) {
    await tailorWorker.close();
    tailorWorker = null;
  }
}
