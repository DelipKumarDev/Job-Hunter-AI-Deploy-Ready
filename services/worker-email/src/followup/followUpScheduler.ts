// ============================================================
// Follow-Up Scheduler
// Creates follow-up schedules when an application is marked
// APPLIED. Manages the 3 → 7 → 14 business day cadence.
//
// Pre-send checks:
//  ✓ Application still in APPLIED state (not rejected/etc.)
//  ✓ Recruiter hasn't replied (no reply in email_threads)
//  ✓ Follow-up is still PENDING (not cancelled)
//  ✓ User email account still active
//  ✓ Not already sent (idempotency guard)
//
// On cancellation:
//  - Rejection email received
//  - Recruiter replied
//  - Interview scheduled
//  - Offer received
//  - Manual cancel via API
// ============================================================

import type { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import type { FollowUpPayload, FollowUpContext } from '../types/emailTypes.js';
import { computeFollowUpDates, composeFollowUp, fallbackBodyText } from '../composer/followUpComposer.js';
import { logger } from '../utils/logger.js';
import { jobAddOptions, QUEUE_NAMES } from '@job-hunter/shared';

export class FollowUpScheduler {
  private readonly followUpQueue: Queue<FollowUpPayload>;

  constructor(
    private readonly prisma:   PrismaClient,
    private readonly redisOpts: { host: string; port: number; prefix?: string },
  ) {
    this.followUpQueue = new Queue<FollowUpPayload>('followup-queue', {
      connection: { host: redisOpts.host, port: redisOpts.port },
      prefix:     redisOpts.prefix ?? 'jhq',
    });
  }

  // ── Schedule all 3 follow-ups when application is APPLIED ──
  async scheduleForApplication(applicationId: string, userId: string): Promise<void> {
    const application = await this.prisma.application.findUniqueOrThrow({
      where: { id: applicationId },
      select: {
        id: true, appliedAt: true, userId: true,
        jobListing: { select: { jobTitle: true, company: true } },
      },
    });

    const appliedAt = application.appliedAt ?? new Date();
    const dates = computeFollowUpDates(appliedAt);

    const followUps: Array<{ number: 1 | 2 | 3; scheduledAt: Date }> = [
      { number: 1, scheduledAt: dates.followUp1 },
      { number: 2, scheduledAt: dates.followUp2 },
      { number: 3, scheduledAt: dates.followUp3 },
    ];

    for (const fu of followUps) {
      // Skip if already exists
      const existing = await this.prisma.followupLog.findFirst({
        where: { applicationId, followUpNumber: fu.number },
      });
      if (existing) continue;

      const record = await this.prisma.followupLog.create({
        data: {
          userId,
          applicationId,
          followUpNumber: fu.number,
          scheduledAt:    fu.scheduledAt,
          status:         'PENDING',
        },
      });

      // Schedule delayed BullMQ job
      const delayMs = Math.max(0, fu.scheduledAt.getTime() - Date.now());
      await this.followUpQueue.add(
        'send-followup',
        {
          userId,
          applicationId,
          followUpId:     record.id,
          followUpNumber: fu.number,
        } satisfies FollowUpPayload,
        jobAddOptions(QUEUE_NAMES.FOLLOW_UP, {
          delay: delayMs,
          jobId: `followup-${applicationId}-${fu.number}`,  // Idempotency
        }),
      );

      logger.info('Follow-up scheduled', {
        applicationId,
        number:      fu.number,
        scheduledAt: fu.scheduledAt.toISOString(),
        delayHours:  Math.round(delayMs / 3600000),
      });
    }
  }

  // ── Execute a follow-up (called by BullMQ worker) ──────────
  async executeFollowUp(payload: FollowUpPayload): Promise<void> {
    const { userId, applicationId, followUpId, followUpNumber } = payload;

    // ── Pre-send safety checks ────────────────────────────
    const [followUp, application] = await Promise.all([
      this.prisma.followupLog.findUniqueOrThrow({ where: { id: followUpId } }),
      this.prisma.application.findUniqueOrThrow({
        where: { id: applicationId },
        select: {
          id: true, status: true, appliedAt: true,
          jobListing: { select: { jobTitle: true, company: true, sourceUrl: true } },
        },
      }),
    ]);

    if (followUp.status === 'SENT') {
      logger.info('Follow-up already sent — skip', { followUpId });
      return;
    }
    if (followUp.status === 'CANCELLED') {
      logger.info('Follow-up cancelled — skip', { followUpId });
      return;
    }

    // Don't follow up if application moved to terminal state
    const terminalStatuses = ['REJECTED', 'OFFER_RECEIVED', 'WITHDRAWN', 'INTERVIEW_SCHEDULED'];
    if (terminalStatuses.includes(application.status)) {
      await this.cancelFollowUp(followUpId, `Application status: ${application.status}`);
      logger.info('Follow-up cancelled: terminal status', { applicationId, status: application.status });
      return;
    }

    // Check if recruiter replied recently (within last 3 days)
    const recentReply = await this.prisma.emailThread.findFirst({
      where: {
        userId,
        applicationId,
        status:       { in: ['replied', 'interview', 'offered', 'rejected'] },
        lastMessageAt: { gte: new Date(Date.now() - 3 * 86400 * 1000) },
      },
    });

    if (recentReply) {
      await this.cancelFollowUp(followUpId, `Recruiter replied: ${recentReply.status}`);
      logger.info('Follow-up cancelled: recruiter replied', { applicationId });
      return;
    }

    // ── Get user details ──────────────────────────────────
    const [user, emailAccount, thread] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where:  { id: userId },
        select: { id: true, email: true, name: true },
      }),
      this.prisma.userEmailAccount.findFirst({
        where:  { userId, isActive: true },
        select: {
          id: true, email: true, provider: true,
          accessToken: true, refreshToken: true,
          imapPassword: true, smtpHost: true, smtpPort: true,
        },
      }),
      this.prisma.emailThread.findFirst({
        where:  { userId, applicationId },
        select: {
          externalThreadId: true, recruiterEmail: true, recruiterName: true,
          subject: true, rawContent: true,
        },
      }),
    ]);

    if (!emailAccount) {
      await this.cancelFollowUp(followUpId, 'No active email account');
      return;
    }

    // ── Build follow-up context ───────────────────────────
    const profile = await this.prisma.profile.findUnique({
      where:  { userId },
      select: { linkedinUrl: true, phone: true },
    });

    const previousEmails = thread
      ? [{ role: 'sent' as const, content: thread.rawContent ?? '', date: application.appliedAt ?? new Date() }]
      : [];

    const ctx: FollowUpContext = {
      candidateName:   user.name ?? user.email.split('@')[0]!,
      candidateEmail:  emailAccount.email,
      jobTitle:        application.jobListing.jobTitle,
      companyName:     application.jobListing.company,
      recruiterName:   thread?.recruiterName ?? null,
      recruiterEmail:  thread?.recruiterEmail ?? extractRecruiterEmail(application.jobListing.sourceUrl),
      applicationDate: application.appliedAt ?? new Date(),
      followUpNumber,
      previousEmails,
      linkedinUrl:     profile?.linkedinUrl ?? null,
      phoneNumber:     profile?.phone       ?? null,
    };

    // ── Generate email content ────────────────────────────
    let generated;
    try {
      generated = await composeFollowUp(ctx);
    } catch (err) {
      logger.warn('AI compose failed, using fallback template', { error: String(err) });
      generated = {
        subject:    `Following up: ${ctx.jobTitle} at ${ctx.companyName}`,
        bodyText:   fallbackBodyText(ctx),
        bodyHtml:   '',
        tone:       'professional' as const,
        wordCount:  0,
        tokensUsed: 0,
      };
    }

    // ── Send via Gmail or SMTP ────────────────────────────
    await this.sendFollowUpEmail(
      emailAccount,
      ctx,
      generated,
      thread,
    );

    // ── Mark follow-up as SENT ────────────────────────────
    await this.prisma.followupLog.update({
      where: { id: followUpId },
      data: {
        status:       'SENT',
        sentAt:       new Date(),
        emailSubject: generated.subject,
        emailBody:    generated.bodyText,
      },
    });

    // ── Update application follow-up counter ──────────────
    await this.prisma.application.update({
      where: { id: applicationId },
      data:  { followUpCount: { increment: 1 } },
    });

    logger.info('Follow-up sent', {
      followUpNumber,
      applicationId,
      to:        ctx.recruiterEmail,
      subject:   generated.subject,
      words:     generated.wordCount,
    });
  }

  // ── Send the actual email ─────────────────────────────────
  private async sendFollowUpEmail(
    account:   { email: string; provider: string; accessToken: string | null; refreshToken: string | null; imapPassword: string | null; smtpHost: string | null; smtpPort: number | null },
    ctx:       FollowUpContext,
    generated: { subject: string; bodyText: string; bodyHtml: string },
    thread:    { externalThreadId: string; recruiterEmail: string; subject: string } | null,
  ): Promise<void> {

    const toEmail = thread?.recruiterEmail ?? ctx.recruiterEmail;

    if (account.provider === 'gmail' && account.accessToken && account.refreshToken) {
      const tokens: import('../gmail/gmailClient.js').GmailTokens = {
        accessToken:  account.accessToken,
        refreshToken: account.refreshToken,
        expiresAt:    0,
      };
      const { sendMessage } = await import('../gmail/gmailClient.js');
      await sendMessage(tokens, {
        to:       toEmail,
        from:     account.email,
        fromName: ctx.candidateName,
        subject:  generated.subject,
        bodyText: generated.bodyText,
        bodyHtml: generated.bodyHtml,
        threadId: thread?.externalThreadId,
      });

    } else if (account.smtpHost && account.imapPassword) {
      const { sendEmailViaSmtp } = await import('../imap/imapClient.js');
      await sendEmailViaSmtp({
        host:     account.smtpHost,
        port:     account.smtpPort ?? 587,
        secure:   false,
        username: account.email,
        password: account.imapPassword,
      }, {
        from:     account.email,
        fromName: ctx.candidateName,
        to:       toEmail,
        subject:  generated.subject,
        bodyText: generated.bodyText,
        bodyHtml: generated.bodyHtml,
      });
    }
  }

  // ── Cancel a single follow-up ─────────────────────────────
  async cancelFollowUp(followUpId: string, reason: string): Promise<void> {
    await this.prisma.followupLog.update({
      where: { id: followUpId },
      data:  { status: 'CANCELLED', cancelledReason: reason },
    });

    // Also remove from BullMQ if still delayed
    const queueJob = await this.followUpQueue.getJob(`followup-${followUpId}`);
    await queueJob?.remove().catch(() => null);
  }

  // ── Cancel ALL pending follow-ups for an application ─────
  async cancelAllForApplication(applicationId: string, reason: string): Promise<number> {
    const { count } = await this.prisma.followupLog.updateMany({
      where: { applicationId, status: 'PENDING' },
      data:  { status: 'CANCELLED', cancelledReason: reason },
    });
    logger.info('Follow-ups bulk cancelled', { applicationId, count, reason });
    return count;
  }

  async close(): Promise<void> {
    await this.followUpQueue.close();
  }
}

function extractRecruiterEmail(sourceUrl: string): string {
  // Can't extract recruiter email from URL — return empty
  return '';
}
