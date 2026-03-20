// ============================================================
// Email Analyzer API Routes
//
//   POST /api/v1/email/analyze/:threadId     — Trigger analysis
//   GET  /api/v1/email/analyze/:threadId     — Get result
//   GET  /api/v1/email/analyze/application/:appId — All for app
//   POST /api/v1/email/analyze/bulk          — Batch re-analyze
//   GET  /api/v1/email/analyze/stats         — Aggregate stats
//   POST /api/v1/email/webhook/gmail         — Gmail push webhook
// ============================================================

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { enqueueEmailAnalysis, getAnalyzeQueue } from '../analyzer/analyzerWorker.js';
import { analyzeEmail } from '../analyzer/emailAnalyzer.js';
import type { AnalyzeEmailPayload } from '../analyzer/analyzerTypes.js';
import { logger } from '../utils/logger.js';

export const analyzerRouter = Router();
const prisma = new PrismaClient();

// ── POST /analyze/:threadId — Trigger analysis ────────────────
analyzerRouter.post('/analyze/:threadId', async (req, res, next) => {
  try {
    const userId   = req.user!.id;
    const threadId = req.params!['threadId']!;
    const { sync = false } = req.body as { sync?: boolean };

    const thread = await prisma.emailThread.findFirst({
      where:  { id: threadId, userId },
      select: {
        id: true, externalThreadId: true, subject: true,
        recruiterEmail: true, recruiterName: true,
        rawContent: true, lastMessageAt: true, applicationId: true,
      },
    });

    if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });
    if (!thread.rawContent) return res.status(400).json({ success: false, error: 'Thread has no content to analyze' });

    const payload: AnalyzeEmailPayload = {
      userId,
      emailId:       thread.id,
      threadId:      thread.externalThreadId,
      rawBody:       thread.rawContent,
      subject:       thread.subject,
      fromEmail:     thread.recruiterEmail,
      fromName:      thread.recruiterName,
      receivedAt:    thread.lastMessageAt.toISOString(),
      applicationId: thread.applicationId,
    };

    if (sync) {
      // Synchronous — run inline, return full result
      const result = await analyzeEmail(prisma, payload);
      return res.json({ success: true, data: result });
    }

    // Async — enqueue with high priority
    await enqueueEmailAnalysis(payload, 1);
    return res.json({
      success: true,
      data:    { queued: true, emailId: thread.id, message: 'Analysis queued' },
    });
  } catch (err) { next(err); }
});

// ── GET /analyze/:threadId — Get analysis result ──────────────
analyzerRouter.get('/analyze/:threadId', async (req, res, next) => {
  try {
    const userId   = req.user!.id;
    const threadId = req.params!['threadId']!;

    const thread = await prisma.emailThread.findFirst({
      where:  { id: threadId, userId },
      select: {
        id: true, subject: true, recruiterEmail: true, recruiterName: true,
        companyName: true, jobTitle: true, classification: true,
        classificationScore: true, status: true, lastMessageAt: true,
        analysisData: true, analysedAt: true,
        application: {
          select: {
            id: true, status: true,
            jobListing: { select: { jobTitle: true, company: true } },
          },
        },
      },
    });

    if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });

    // Check queue status if not yet analysed
    let queueStatus: string | null = null;
    if (!thread.analysedAt) {
      const q    = getAnalyzeQueue();
      const job  = await q.getJob(`analyze-${threadId}`);
      queueStatus = job ? await job.getState() : null;
    }

    return res.json({
      success: true,
      data: {
        thread,
        analysis:    thread.analysisData ?? null,
        queueStatus,
        isAnalyzed:  !!thread.analysedAt,
      },
    });
  } catch (err) { next(err); }
});

// ── GET /analyze/application/:appId — All threads for app ─────
analyzerRouter.get('/analyze/application/:appId', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const appId  = req.params!['appId']!;

    // Verify ownership
    const app = await prisma.application.findFirst({ where: { id: appId, userId } });
    if (!app) return res.status(404).json({ success: false, error: 'Application not found' });

    const threads = await prisma.emailThread.findMany({
      where:   { applicationId: appId, userId },
      orderBy: { lastMessageAt: 'desc' },
      select: {
        id: true, subject: true, recruiterEmail: true, classification: true,
        classificationScore: true, status: true, lastMessageAt: true,
        analysisData: true, analysedAt: true,
      },
    });

    // Aggregate: pull interview schedules created by analyzer
    const interviews = await prisma.interviewSchedule.findMany({
      where:   { applicationId: appId },
      orderBy: { scheduledAt: 'asc' },
    });

    // Pull follow-up cancellation history
    const followUps = await prisma.followupLog.findMany({
      where:   { applicationId: appId },
      orderBy: { followUpNumber: 'asc' },
      select: { followUpNumber: true, status: true, cancelledReason: true, scheduledAt: true, sentAt: true },
    });

    return res.json({
      success: true,
      data:    { threads, interviews, followUps, application: app },
    });
  } catch (err) { next(err); }
});

// ── POST /analyze/bulk — Batch re-analyze unanalyzed threads ──
const BulkSchema = z.object({
  limit:           z.number().min(1).max(200).default(50),
  onlyUnanalyzed:  z.boolean().default(true),
  applicationId:   z.string().uuid().optional(),
});

analyzerRouter.post('/analyze/bulk', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body   = BulkSchema.parse(req.body);

    const where: Record<string, unknown> = {
      userId,
      rawContent: { not: null },
    };
    if (body.onlyUnanalyzed) where['analysedAt'] = null;
    if (body.applicationId)  where['applicationId'] = body.applicationId;

    const threads = await prisma.emailThread.findMany({
      where, take: body.limit,
      orderBy: { lastMessageAt: 'desc' },
      select: {
        id: true, externalThreadId: true, subject: true,
        recruiterEmail: true, recruiterName: true,
        rawContent: true, lastMessageAt: true, applicationId: true,
      },
    });

    let queued = 0;
    for (const thread of threads) {
      if (!thread.rawContent) continue;
      await enqueueEmailAnalysis({
        userId,
        emailId:       thread.id,
        threadId:      thread.externalThreadId,
        rawBody:       thread.rawContent,
        subject:       thread.subject,
        fromEmail:     thread.recruiterEmail,
        fromName:      thread.recruiterName,
        receivedAt:    thread.lastMessageAt.toISOString(),
        applicationId: thread.applicationId,
      }, 5); // Lower priority for bulk
      queued++;
    }

    return res.json({
      success: true,
      data:    { queued, total: threads.length, message: `${queued} emails queued for analysis` },
    });
  } catch (err) { next(err); }
});

// ── GET /analyze/stats — Aggregate analysis statistics ────────
analyzerRouter.get('/analyze/stats', async (req, res, next) => {
  try {
    const userId = req.user!.id;

    const [byIntent, byStatus, responseRate, avgResponseDays] = await Promise.all([
      // Count by classification (intent)
      prisma.emailThread.groupBy({
        by:    ['classification'],
        where: { userId },
        _count: { id: true },
      }),

      // Count by thread status
      prisma.emailThread.groupBy({
        by:    ['status'],
        where: { userId },
        _count: { id: true },
      }),

      // Response rate: threads with recruiter reply / total
      Promise.all([
        prisma.emailThread.count({ where: { userId } }),
        prisma.emailThread.count({ where: { userId, status: { in: ['replied', 'interview', 'offered'] } } }),
      ]),

      // Average days to response (lastMessageAt - application.appliedAt)
      prisma.$queryRaw<Array<{ avg_days: number }>>`
        SELECT AVG(EXTRACT(EPOCH FROM (et.last_message_at - a.applied_at)) / 86400)::float AS avg_days
        FROM email_threads et
        JOIN applications a ON a.id = et.application_id
        WHERE et.user_id = ${userId}::uuid
          AND et.status IN ('replied', 'interview', 'offered')
          AND a.applied_at IS NOT NULL
      `.catch(() => [{ avg_days: 0 }]),
    ]);

    const [total, replied] = responseRate;
    const responseRatePct  = total > 0 ? Math.round((replied / total) * 100) : 0;

    return res.json({
      success: true,
      data: {
        byIntent:       byIntent.map(r => ({ intent: r.classification, count: r._count.id })),
        byStatus:       byStatus.map(r => ({ status: r.status, count: r._count.id })),
        responseRate:   { total, replied, percentage: responseRatePct },
        avgResponseDays: Math.round((avgResponseDays[0]?.avg_days ?? 0) * 10) / 10,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /webhook/gmail — Gmail push notification handler ─────
analyzerRouter.post('/webhook/gmail', async (req, res) => {
  try {
    // Gmail sends base64-encoded PubSub message
    const message = req.body?.message;
    if (!message?.data) return res.sendStatus(204);

    const decoded = JSON.parse(Buffer.from(message.data, 'base64').toString());
    const { emailAddress, historyId } = decoded as { emailAddress: string; historyId: string };

    logger.info('Gmail push notification', { emailAddress, historyId });

    // Find the email account
    const account = await prisma.userEmailAccount.findFirst({
      where:  { email: emailAddress, isActive: true, provider: 'GMAIL' },
      select: { id: true, userId: true },
    });

    if (account) {
      // Trigger incremental sync for this account
      const { Queue } = await import('bullmq');
      const syncQ = new Queue('email-monitor-queue', {
        connection: { host: process.env['REDIS_HOST'] ?? 'localhost', port: parseInt(process.env['REDIS_PORT'] ?? '6379') },
        prefix: process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
      });
      await syncQ.add('sync', {
        userId: account.userId, emailAccountId: account.id, fullSync: false,
      }, { priority: 1 });
      await syncQ.close();
    }

    return res.sendStatus(204); // ACK immediately — Gmail retries on non-2xx
  } catch (err) {
    logger.warn('Gmail webhook error', { error: String(err) });
    return res.sendStatus(204); // Always ACK to avoid retry flood
  }
});
