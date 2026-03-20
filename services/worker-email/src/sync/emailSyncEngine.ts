// ============================================================
// Email Sync Engine
// Pulls new emails from Gmail or IMAP, classifies them,
// groups into threads, and persists to DB.
//
// Sync strategy:
//   Gmail: incremental via historyId/modifiedAfter
//   IMAP:  SINCE last sync date, deduped by messageId
//
// After each email:
//  1. Classify with 3-layer classifier
//  2. Match to application (fuzzy company+job match)
//  3. Upsert email_threads record
//  4. If recruiter replied → cancel pending follow-ups
//  5. If interview/offer → create interview_schedules record
// ============================================================

import type { PrismaClient } from '@prisma/client';
import type { RawEmail, EmailSyncContext, EmailClassification, ThreadStatus } from '../types/emailTypes.js';
import * as gmailClient from '../gmail/gmailClient.js';
import { fetchEmailsViaImap } from '../imap/imapClient.js';
import { classifyEmail } from '../classifier/emailClassifier.js';
import { logger } from '../utils/logger.js';
import { tryWithLock, LockKeys, TTL } from '@job-hunter/shared';

export interface SyncResult {
  emailsFetched:   number;
  threadsUpdated:  number;
  followUpsCancelled: number;
  errors:          string[];
}

// ─────────────────────────────────────────────────────────────
// MAIN SYNC FUNCTION
// ─────────────────────────────────────────────────────────────
export async function syncUserEmails(
  prisma:  PrismaClient,
  ctx:     EmailSyncContext,
): Promise<SyncResult> {
  const result: SyncResult = {
    emailsFetched: 0, threadsUpdated: 0,
    followUpsCancelled: 0, errors: [],
  };

  logger.info('Starting email sync', {
    userId:   ctx.userId,
    provider: ctx.provider,
    email:    ctx.accountEmail,
    since:    ctx.lastSyncAt?.toISOString() ?? 'full sync',
  });

  const since = ctx.lastSyncAt
    ? new Date(ctx.lastSyncAt.getTime() - 60 * 60 * 1000) // 1h overlap for safety
    : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);    // 90 days back on first sync

  // ── Fetch emails from provider ────────────────────────────
  let rawEmails: RawEmail[] = [];

  try {
    if (ctx.provider === 'gmail' && ctx.accessToken && ctx.refreshToken) {
      rawEmails = await fetchGmailEmails(ctx, since);
    } else if (ctx.imapHost && ctx.imapPassword) {
      rawEmails = await fetchImapEmails(ctx, since);
    } else {
      throw new Error('No valid credentials for email sync');
    }
    result.emailsFetched = rawEmails.length;
  } catch (err) {
    result.errors.push(`Email fetch failed: ${String(err)}`);
    logger.error('Email fetch error', { userId: ctx.userId, error: String(err) });
    return result;
  }

  logger.info(`Fetched ${rawEmails.length} emails`, { userId: ctx.userId });

  // ── Group emails into threads ─────────────────────────────
  const threadMap = groupByThread(rawEmails);

  // ── Process each thread ───────────────────────────────────
  for (const [externalThreadId, threadEmails] of threadMap.entries()) {
    try {
      // ── Per-thread lock ──────────────────────────────────
      // Lock key: jh-lock:thread:{externalThreadId}
      //
      // Scenario this prevents:
      //   User has two email accounts (work + personal).
      //   Both accounts sync in parallel (concurrency:5).
      //   Both accounts have been CC'd on the same recruiter
      //   thread, so both sync jobs try to upsert the same
      //   emailThread row at the same time.
      //
      // tryWithLock: if another sync already holds this thread,
      // skip it — the holder will write the correct state.
      const threadResult = await tryWithLock(
        LockKeys.emailThread(externalThreadId),
        TTL.EMAIL_SYNC,
        async (_lock) => {
          await processThread(prisma, ctx, externalThreadId, threadEmails, result);
        },
        { retryCount: 1, retryDelayMs: 300 },
      );

      if (threadResult === null) {
        logger.debug('Thread skipped — lock contended (parallel sync in flight)', {
          externalThreadId, userId: ctx.userId,
        });
      }
    } catch (err) {
      result.errors.push(`Thread ${externalThreadId}: ${String(err)}`);
      logger.warn('Thread processing error', { threadId: externalThreadId, error: String(err) });
    }
  }

  // ── Update last sync time ─────────────────────────────────
  await prisma.userEmailAccount.update({
    where: { userId_email: { userId: ctx.userId, email: ctx.accountEmail } },
    data:  { lastSyncAt: new Date() },
  }).catch(err => logger.warn('lastSyncAt update failed', { error: String(err) }));

  logger.info('Email sync complete', {
    userId:   ctx.userId,
    fetched:  result.emailsFetched,
    threads:  result.threadsUpdated,
    cancelled: result.followUpsCancelled,
    errors:   result.errors.length,
  });

  return result;
}

// ─────────────────────────────────────────────────────────────
// PROCESS ONE THREAD
// ─────────────────────────────────────────────────────────────
async function processThread(
  prisma:           PrismaClient,
  ctx:              EmailSyncContext,
  externalThreadId: string,
  emails:           RawEmail[],
  result:           SyncResult,
): Promise<void> {
  // Sort oldest first
  emails.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());

  const latest   = emails[emails.length - 1]!;
  const inbound  = emails.filter(e => !e.isFromUser);

  if (inbound.length === 0) {
    // Only outbound messages — track as sent thread
    return;
  }

  // Classify the most recent inbound email
  const classification = await classifyEmail(latest.isFromUser ? emails.reverse().find(e => !e.isFromUser)! : latest);

  // Skip completely unrelated emails
  if (classification.classification === 'unrelated' && classification.confidence > 0.8) {
    return;
  }

  // Find matching application
  const applicationId = await findMatchingApplication(
    prisma, ctx.userId,
    classification.companyName ?? extractDomain(latest.fromEmail),
    classification.jobTitle,
  );

  // Upsert email thread record
  const threadStatus = mapToThreadStatus(classification.classification);

  await prisma.emailThread.upsert({
    where: { externalThreadId },
    create: {
      userId:           ctx.userId,
      applicationId,
      externalThreadId,
      subject:          latest.subject,
      recruiterEmail:   inbound[0]!.fromEmail,
      recruiterName:    classification.recruiterName,
      companyName:      classification.companyName,
      jobTitle:         classification.jobTitle,
      classification:   classification.classification,
      classificationScore: classification.confidence,
      status:           threadStatus,
      lastMessageAt:    latest.receivedAt,
      messageCount:     emails.length,
      rawContent:       latest.bodyText.slice(0, 5000),
    },
    update: {
      classification:      classification.classification,
      classificationScore: classification.confidence,
      status:              threadStatus,
      lastMessageAt:       latest.receivedAt,
      messageCount:        emails.length,
      rawContent:          latest.bodyText.slice(0, 5000),
      recruiterName:       classification.recruiterName ?? undefined,
      companyName:         classification.companyName  ?? undefined,
      jobTitle:            classification.jobTitle     ?? undefined,
    },
  });

  result.threadsUpdated++;

  // ── Handle follow-up cancellation ─────────────────────────
  if (classification.shouldStopFollowUps && applicationId) {
    const cancelled = await cancelFollowUps(
      prisma,
      ctx.userId,
      applicationId,
      classification.classification,
    );
    result.followUpsCancelled += cancelled;
  }

  // ── Handle interview invite ────────────────────────────────
  if (classification.classification === 'interview_invite' && applicationId) {
    await handleInterviewInvite(prisma, applicationId, classification.extractedDate, latest);
  }

  // ── Update application status from email ──────────────────
  if (applicationId) {
    await updateApplicationFromEmail(prisma, applicationId, classification.classification);
  }
}

// ─────────────────────────────────────────────────────────────
// CANCEL PENDING FOLLOW-UPS
// ─────────────────────────────────────────────────────────────
async function cancelFollowUps(
  prisma:         PrismaClient,
  userId:         string,
  applicationId:  string,
  reason:         EmailClassification,
): Promise<number> {
  const { count } = await prisma.followupLog.updateMany({
    where: {
      userId,
      applicationId,
      status: 'PENDING',
    },
    data: {
      status:          'CANCELLED',
      cancelledReason: reason,
    },
  });

  if (count > 0) {
    logger.info('Follow-ups cancelled', { applicationId, count, reason });
  }
  return count;
}

// ─────────────────────────────────────────────────────────────
// HANDLE INTERVIEW INVITE
// ─────────────────────────────────────────────────────────────
async function handleInterviewInvite(
  prisma:         PrismaClient,
  applicationId:  string,
  interviewDate:  Date | null,
  email:          RawEmail,
): Promise<void> {
  try {
    await prisma.interviewSchedule.upsert({
      where: { applicationId_round: { applicationId, round: 1 } },
      create: {
        applicationId,
        scheduledAt:   interviewDate ?? new Date(Date.now() + 7 * 86400 * 1000),
        interviewType: 'PHONE',
        status:        'SCHEDULED',
        notes:         email.bodyText.slice(0, 500),
        round:         1,
      },
      update: {
        scheduledAt:   interviewDate ?? undefined,
        status:        'SCHEDULED',
      },
    });
    logger.info('Interview schedule created', { applicationId });
  } catch (err) {
    logger.warn('Interview schedule creation failed', { error: String(err) });
  }
}

// ─────────────────────────────────────────────────────────────
// UPDATE APPLICATION STATUS FROM EMAIL
// ─────────────────────────────────────────────────────────────
async function updateApplicationFromEmail(
  prisma:        PrismaClient,
  applicationId: string,
  cls:           EmailClassification,
): Promise<void> {
  const statusMap: Partial<Record<EmailClassification, string>> = {
    interview_invite: 'INTERVIEW_SCHEDULED',
    offer:            'OFFER_RECEIVED',
    rejection:        'REJECTED',
  };

  const newStatus = statusMap[cls];
  if (!newStatus) return;

  await prisma.application.update({
    where: { id: applicationId },
    data:  { status: newStatus as 'INTERVIEW_SCHEDULED' | 'OFFER_RECEIVED' | 'REJECTED' },
  }).catch(e => logger.warn('Application status update failed', { error: String(e) }));
}

// ─────────────────────────────────────────────────────────────
// MATCH EMAIL → APPLICATION
// Fuzzy match on company domain + job title
// ─────────────────────────────────────────────────────────────
async function findMatchingApplication(
  prisma:      PrismaClient,
  userId:      string,
  companyName: string | null,
  jobTitle:    string | null,
): Promise<string | null> {
  if (!companyName && !jobTitle) return null;

  // First try exact company match
  const apps = await prisma.application.findMany({
    where:   { userId, status: { notIn: ['REJECTED', 'WITHDRAWN'] } },
    include: { jobListing: { select: { company: true, jobTitle: true } } },
    take:    20,
  });

  if (apps.length === 0) return null;

  // Score each application
  type ScoredApp = { id: string; score: number };
  const scored: ScoredApp[] = apps.map(app => {
    let score = 0;
    const company = app.jobListing.company.toLowerCase();
    const title   = app.jobListing.jobTitle.toLowerCase();

    if (companyName && company.includes(companyName.toLowerCase())) score += 4;
    if (companyName && companyName.toLowerCase().includes(company))  score += 3;
    if (jobTitle    && title.includes(jobTitle.toLowerCase()))       score += 3;
    if (jobTitle    && jobTitle.toLowerCase().includes(title))       score += 2;

    return { id: app.id, score };
  });

  const best = scored.sort((a, b) => b.score - a.score)[0];
  return best && best.score >= 3 ? best.id : null;
}

// ─────────────────────────────────────────────────────────────
// GMAIL FETCH WRAPPER
// ─────────────────────────────────────────────────────────────
async function fetchGmailEmails(ctx: EmailSyncContext, since: Date): Promise<RawEmail[]> {
  const tokens: gmailClient.GmailTokens = {
    accessToken:  ctx.accessToken!,
    refreshToken: ctx.refreshToken!,
    expiresAt:    0, // Force refresh check
  };

  const emails: RawEmail[] = [];
  let pageToken: string | undefined;

  do {
    const list = await gmailClient.listThreads(tokens, 'me', {
      maxResults: 100,
      pageToken,
      after: since,
    });

    for (const { id } of list.threads) {
      const thread = await gmailClient.getThread(tokens, id, ctx.accountEmail);
      emails.push(...thread);
      await new Promise(r => setTimeout(r, 50)); // Rate limit
    }

    pageToken = list.nextPageToken ?? undefined;
  } while (pageToken);

  return dedupeByMessageId(emails);
}

// ─────────────────────────────────────────────────────────────
// IMAP FETCH WRAPPER
// ─────────────────────────────────────────────────────────────
async function fetchImapEmails(ctx: EmailSyncContext, since: Date): Promise<RawEmail[]> {
  const { fetchEmailsViaImap: fetchImap } = await import('../imap/imapClient.js');
  const emails = await fetchImap(
    {
      host:     ctx.imapHost!,
      port:     ctx.imapPort ?? 993,
      secure:   (ctx.imapPort ?? 993) === 993,
      username: ctx.accountEmail,
      password: ctx.imapPassword!,
    },
    since,
    ctx.accountEmail,
  );
  return dedupeByMessageId(emails);
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function groupByThread(emails: RawEmail[]): Map<string, RawEmail[]> {
  const map = new Map<string, RawEmail[]>();
  for (const email of emails) {
    const key = email.threadId || email.messageId;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(email);
  }
  return map;
}

function dedupeByMessageId(emails: RawEmail[]): RawEmail[] {
  const seen = new Set<string>();
  return emails.filter(e => {
    if (seen.has(e.messageId)) return false;
    seen.add(e.messageId);
    return true;
  });
}

function extractDomain(email: string): string {
  const domain = email.split('@')[1] ?? '';
  const parts  = domain.split('.');
  return parts.length >= 2 ? (parts[parts.length - 2] ?? '') : domain;
}

function mapToThreadStatus(cls: EmailClassification): ThreadStatus {
  const map: Partial<Record<EmailClassification, ThreadStatus>> = {
    rejection:       'rejected',
    interview_invite: 'interview',
    offer:           'offered',
    recruiter_reply: 'replied',
  };
  return map[cls] ?? 'active';
}

type ThreadStatus = 'active' | 'replied' | 'interview' | 'rejected' | 'offered' | 'closed';
