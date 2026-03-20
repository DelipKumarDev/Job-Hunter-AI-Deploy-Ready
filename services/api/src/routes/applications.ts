// ============================================================
// Application Bot API Routes
//
// POST /api/v1/applications/:id/apply    — Queue bot run
// GET  /api/v1/applications/:id/status  — Application status
// POST /api/v1/applications/:id/retry   — Retry failed app
// GET  /api/v1/applications             — List with filters
// ============================================================

import { Router } from 'express';
import { Queue }  from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { BotJobPayload } from '../../../services/worker-bot/src/types/botTypes.js';

export const applicationsRouter = Router();
const prisma = new PrismaClient();

const botQueue = new Queue<BotJobPayload>('job-apply-queue', {
  connection: {
    host: process.env['REDIS_HOST'] ?? 'localhost',
    port: parseInt(process.env['REDIS_PORT'] ?? '6379'),
  },
  prefix: process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
});

// ── POST /:id/apply — queue the bot ───────────────────────────
applicationsRouter.post('/:id/apply', async (req, res, next) => {
  try {
    const userId        = req.user!.id;
    const applicationId = req.params!['id']!;

    const application = await prisma.application.findFirst({
      where: { id: applicationId, userId },
      include: { jobListing: { select: { sourceUrl: true } } },
    });

    if (!application) {
      return res.status(404).json({ success: false, error: 'Application not found' });
    }

    if (application.status === 'APPLIED') {
      return res.status(400).json({ success: false, error: 'Already applied' });
    }

    // Get user's active resume
    const resume = await prisma.resume.findFirst({
      where: { userId, isActive: true },
      select: { id: true },
    });

    if (!resume) {
      return res.status(400).json({ success: false, error: 'No active resume. Please upload a resume first.' });
    }

    const payload: BotJobPayload = {
      userId,
      applicationId,
      jobListingId: application.jobListingId,
      applyUrl:     application.jobListing.sourceUrl,
      resumeId:     resume.id,
    };

    const job = await botQueue.add('apply', payload, {
      attempts:         2,
      removeOnComplete: { count: 200 },
      removeOnFail:     { count: 100 },
      priority:         1,
    });

    // Mark as queued in DB
    await prisma.application.update({
      where: { id: applicationId },
      data:  { status: 'QUEUED', botJobId: job.id! },
    });

    return res.json({
      success: true,
      data: {
        applicationId,
        queueJobId: job.id,
        message:    'Application bot queued successfully',
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /:id/status ───────────────────────────────────────────
applicationsRouter.get('/:id/status', async (req, res, next) => {
  try {
    const userId        = req.user!.id;
    const applicationId = req.params!['id']!;

    const application = await prisma.application.findFirst({
      where:  { id: applicationId, userId },
      select: {
        id: true, status: true, appliedAt: true,
        screenshotUrl: true, customAnswers: true, botJobId: true,
        jobListing: { select: { jobTitle: true, company: true } },
        followUpLogs: { select: { followUpNumber: true, status: true, sentAt: true } },
      },
    });

    if (!application) {
      return res.status(404).json({ success: false, error: 'Application not found' });
    }

    // Get queue job state if still in progress
    let queueState = null;
    if (application.botJobId) {
      const queueJob = await botQueue.getJob(application.botJobId);
      if (queueJob) {
        queueState = {
          state:    await queueJob.getState(),
          progress: queueJob.progress,
          attempts: queueJob.attemptsMade,
        };
      }
    }

    return res.json({
      success: true,
      data: { ...application, queueState },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/retry — retry failed application ────────────────
applicationsRouter.post('/:id/retry', async (req, res, next) => {
  try {
    const userId        = req.user!.id;
    const applicationId = req.params!['id']!;

    const application = await prisma.application.findFirst({
      where:  { id: applicationId, userId, status: 'FAILED' },
      include: { jobListing: { select: { sourceUrl: true } } },
    });

    if (!application) {
      return res.status(404).json({ success: false, error: 'Failed application not found' });
    }

    const resume = await prisma.resume.findFirst({
      where: { userId, isActive: true },
      select: { id: true },
    });
    if (!resume) return res.status(400).json({ success: false, error: 'No active resume' });

    const payload: BotJobPayload = {
      userId,
      applicationId,
      jobListingId: application.jobListingId,
      applyUrl:     application.jobListing.sourceUrl,
      resumeId:     resume.id,
    };

    const job = await botQueue.add('apply', payload, { priority: 2 });

    await prisma.application.update({
      where: { id: applicationId },
      data:  { status: 'QUEUED', botJobId: job.id! },
    });

    return res.json({ success: true, data: { queueJobId: job.id } });
  } catch (err) {
    next(err);
  }
});

// ── GET / — list applications with filters ────────────────────
const ListSchema = z.object({
  page:   z.coerce.number().min(1).default(1),
  limit:  z.coerce.number().min(1).max(100).default(20),
  status: z.string().optional(),
});

applicationsRouter.get('/', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const q      = ListSchema.parse(req.query);
    const skip   = (q.page - 1) * q.limit;

    const where: Record<string, unknown> = { userId };
    if (q.status) where['status'] = q.status.toUpperCase();

    const [total, apps] = await Promise.all([
      prisma.application.count({ where }),
      prisma.application.findMany({
        where,
        skip,
        take:    q.limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, status: true, appliedAt: true, createdAt: true,
          screenshotUrl: true, followUpCount: true,
          jobListing: {
            select: {
              jobTitle: true, company: true, sourcePlatform: true,
              location: true, remoteType: true, salaryRaw: true,
            },
          },
        },
      }),
    ]);

    return res.json({
      success: true,
      data: {
        applications: apps,
        pagination: {
          total, page: q.page, limit: q.limit,
          totalPages: Math.ceil(total / q.limit),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});
