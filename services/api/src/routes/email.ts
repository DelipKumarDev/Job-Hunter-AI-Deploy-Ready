// ============================================================
// Email System API Routes
//
// Auth & Connection
//   GET  /api/v1/email/oauth/gmail/url     — Get OAuth URL
//   GET  /api/v1/email/oauth/gmail/callback — OAuth callback
//   POST /api/v1/email/connect/imap        — Connect IMAP account
//   DELETE /api/v1/email/accounts/:id      — Disconnect account
//   GET  /api/v1/email/accounts            — List connected accounts
//
// Threads & Classification
//   GET  /api/v1/email/threads             — List email threads
//   GET  /api/v1/email/threads/:id         — Thread detail
//   POST /api/v1/email/sync                — Trigger manual sync
//
// Follow-ups
//   GET  /api/v1/email/followups           — List follow-ups
//   POST /api/v1/email/followups/:id/cancel — Cancel follow-up
//   POST /api/v1/email/followups/:id/send-now — Send immediately
//   POST /api/v1/email/followups/schedule/:appId — Schedule for app
// ============================================================

import { Router }    from 'express';
import { PrismaClient } from '@prisma/client';
import { z }         from 'zod';
import { encryptToken } from '../../services/worker-email/src/utils/crypto.js';
import { EmailSyncScheduler } from '../../services/worker-email/src/processors/emailScheduler.js';
import { FollowUpScheduler }  from '../../services/worker-email/src/followup/followUpScheduler.js';
import { logger }    from '../../services/worker-email/src/utils/logger.js';

export const emailRouter = Router();
const prisma = new PrismaClient();

const syncScheduler   = new EmailSyncScheduler(prisma);
const followUpScheduler = new FollowUpScheduler(prisma, {
  host:   process.env['REDIS_HOST'] ?? 'localhost',
  port:   parseInt(process.env['REDIS_PORT'] ?? '6379'),
  prefix: process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
});

// ── GET /oauth/gmail/url ──────────────────────────────────────
emailRouter.get('/oauth/gmail/url', (req, res) => {
  const clientId    = process.env['GOOGLE_CLIENT_ID'];
  const redirectUri = process.env['GOOGLE_REDIRECT_URI']!;
  const state       = Buffer.from(JSON.stringify({ userId: req.user!.id })).toString('base64');

  const params = new URLSearchParams({
    client_id:     clientId!,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
    access_type:   'offline',
    prompt:        'consent',
    state,
  });

  res.json({ success: true, data: { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` } });
});

// ── GET /oauth/gmail/callback ─────────────────────────────────
emailRouter.get('/oauth/gmail/callback', async (req, res, next) => {
  try {
    const { code, state, error } = req.query as Record<string, string>;

    if (error) return res.redirect(`/dashboard?email_error=${error}`);

    const { userId } = JSON.parse(Buffer.from(state!, 'base64').toString());

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env['GOOGLE_CLIENT_ID']!,
        client_secret: process.env['GOOGLE_CLIENT_SECRET']!,
        redirect_uri:  process.env['GOOGLE_REDIRECT_URI']!,
        code:          code!,
        grant_type:    'authorization_code',
      }),
    });

    const tokens = await tokenRes.json() as { access_token: string; refresh_token: string };

    // Get user email from Gmail profile
    const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    });
    const profile = await profileRes.json() as { emailAddress: string };

    // Save encrypted tokens
    const account = await prisma.userEmailAccount.upsert({
      where:  { userId_email: { userId, email: profile.emailAddress } },
      create: {
        userId,
        email:        profile.emailAddress,
        provider:     'GMAIL',
        accessToken:  encryptToken(tokens.access_token),
        refreshToken: encryptToken(tokens.refresh_token),
        isActive:     true,
      },
      update: {
        accessToken:  encryptToken(tokens.access_token),
        refreshToken: encryptToken(tokens.refresh_token),
        isActive:     true,
      },
    });

    // Trigger immediate full sync
    await syncScheduler.enqueueSyncForUser(userId, account.id, true);

    logger.info('Gmail account connected', { userId, email: profile.emailAddress });
    return res.redirect('/dashboard?email_connected=true');
  } catch (err) {
    next(err);
  }
});

// ── POST /connect/imap ────────────────────────────────────────
const ImapSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
  host:     z.string().optional(),
  port:     z.number().optional(),
});

emailRouter.post('/connect/imap', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body   = ImapSchema.parse(req.body);

    // Auto-detect host if not provided
    let host = body.host;
    let port = body.port ?? 993;
    if (!host) {
      const { getImapPreset } = await import('../../services/worker-email/src/imap/imapClient.js');
      const preset = getImapPreset(body.email);
      host = preset?.host ?? null;
      port = preset?.port ?? 993;
    }

    if (!host) {
      return res.status(400).json({ success: false, error: 'Could not auto-detect IMAP host. Please provide it manually.' });
    }

    const account = await prisma.userEmailAccount.upsert({
      where:  { userId_email: { userId, email: body.email } },
      create: {
        userId,
        email:        body.email,
        provider:     'IMAP',
        imapPassword: encryptToken(body.password),
        imapHost:     host,
        imapPort:     port,
        isActive:     true,
      },
      update: {
        imapPassword: encryptToken(body.password),
        imapHost:     host,
        imapPort:     port,
        isActive:     true,
      },
    });

    await syncScheduler.enqueueSyncForUser(userId, account.id, true);

    return res.json({ success: true, data: { accountId: account.id, email: body.email, provider: 'IMAP' } });
  } catch (err) {
    next(err);
  }
});

// ── GET /accounts ─────────────────────────────────────────────
emailRouter.get('/accounts', async (req, res, next) => {
  try {
    const accounts = await prisma.userEmailAccount.findMany({
      where:  { userId: req.user!.id },
      select: { id: true, email: true, provider: true, isActive: true, lastSyncAt: true, createdAt: true },
    });
    res.json({ success: true, data: { accounts } });
  } catch (err) { next(err); }
});

// ── DELETE /accounts/:id ──────────────────────────────────────
emailRouter.delete('/accounts/:id', async (req, res, next) => {
  try {
    await prisma.userEmailAccount.update({
      where: { id: req.params!['id']!, userId: req.user!.id },
      data:  { isActive: false },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── GET /threads ──────────────────────────────────────────────
const ThreadsQuerySchema = z.object({
  page:   z.coerce.number().min(1).default(1),
  limit:  z.coerce.number().min(1).max(100).default(20),
  status: z.string().optional(),
  classification: z.string().optional(),
});

emailRouter.get('/threads', async (req, res, next) => {
  try {
    const q    = ThreadsQuerySchema.parse(req.query);
    const skip = (q.page - 1) * q.limit;
    const userId = req.user!.id;

    const where: Record<string, unknown> = { userId };
    if (q.status)         where['status'] = q.status;
    if (q.classification) where['classification'] = q.classification;

    const [total, threads] = await Promise.all([
      prisma.emailThread.count({ where }),
      prisma.emailThread.findMany({
        where, skip, take: q.limit,
        orderBy: { lastMessageAt: 'desc' },
        select: {
          id: true, subject: true, recruiterEmail: true, recruiterName: true,
          companyName: true, jobTitle: true, classification: true,
          classificationScore: true, status: true, lastMessageAt: true,
          messageCount: true, applicationId: true,
          application: {
            select: { status: true, jobListing: { select: { jobTitle: true, company: true } } },
          },
        },
      }),
    ]);

    res.json({ success: true, data: { threads, pagination: { total, page: q.page, limit: q.limit, totalPages: Math.ceil(total / q.limit) } } });
  } catch (err) { next(err); }
});

// ── POST /sync ────────────────────────────────────────────────
emailRouter.post('/sync', async (req, res, next) => {
  try {
    const userId   = req.user!.id;
    const accounts = await prisma.userEmailAccount.findMany({ where: { userId, isActive: true }, select: { id: true } });

    for (const acc of accounts) {
      await syncScheduler.enqueueSyncForUser(userId, acc.id, false);
    }

    res.json({ success: true, data: { message: `Sync triggered for ${accounts.length} accounts` } });
  } catch (err) { next(err); }
});

// ── GET /followups ────────────────────────────────────────────
emailRouter.get('/followups', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const followups = await prisma.followupLog.findMany({
      where:   { userId },
      orderBy: { scheduledAt: 'asc' },
      include: {
        application: {
          select: {
            status: true,
            jobListing: { select: { jobTitle: true, company: true } },
          },
        },
      },
      take: 100,
    });

    res.json({ success: true, data: { followups } });
  } catch (err) { next(err); }
});

// ── POST /followups/:id/cancel ────────────────────────────────
emailRouter.post('/followups/:id/cancel', async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const fu = await prisma.followupLog.findFirst({ where: { id, userId: req.user!.id } });
    if (!fu) return res.status(404).json({ success: false, error: 'Follow-up not found' });

    await followUpScheduler.cancelFollowUp(id, 'Manual cancel by user');
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /followups/schedule/:applicationId ───────────────────
emailRouter.post('/followups/schedule/:applicationId', async (req, res, next) => {
  try {
    const userId        = req.user!.id;
    const applicationId = req.params!['applicationId']!;

    const app = await prisma.application.findFirst({ where: { id: applicationId, userId } });
    if (!app) return res.status(404).json({ success: false, error: 'Application not found' });

    await followUpScheduler.scheduleForApplication(applicationId, userId);
    res.json({ success: true, data: { message: 'Follow-up schedule created for days 3, 7, and 14' } });
  } catch (err) { next(err); }
});
