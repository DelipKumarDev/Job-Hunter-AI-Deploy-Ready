// ============================================================
// Notification Dispatcher
// Central coordinator for all WhatsApp notifications.
//
// For each event:
//  1. Load user + application context from DB
//  2. Generate AI briefing (if interview event)
//  3. Format into WA message parts
//  4. Send via waClient (with multi-part support)
//  5. Record delivery in notifications table
//  6. Update application with last_notified_at
// ============================================================

import type { PrismaClient } from '@prisma/client';
import type { WhatsAppJobPayload, InterviewBriefing } from '../types/notificationTypes.js';
import * as waClient from '../whatsapp/waClient.js';
import * as fmt from '../formatters/messageFormatter.js';
import { generateInterviewBriefing } from './briefingGenerator.js';
import { logger } from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────
// MAIN DISPATCH
// ─────────────────────────────────────────────────────────────
export async function dispatch(
  prisma:  PrismaClient,
  payload: WhatsAppJobPayload,
): Promise<{ success: boolean; messageIds: string[]; error?: string }> {

  const { userId, event, applicationId } = payload;
  const messageIds: string[] = [];

  // ── Load user's WhatsApp number ───────────────────────────
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: {
      id: true, name: true, email: true,
      profile: { select: { whatsappNumber: true, phone: true } },
    },
  });

  if (!user) {
    logger.warn('Dispatch: user not found', { userId });
    return { success: false, messageIds: [], error: 'User not found' };
  }

  const phone = user.profile?.whatsappNumber ?? user.profile?.phone;
  if (!phone) {
    logger.info('Dispatch: no WhatsApp number configured', { userId });
    return { success: false, messageIds: [], error: 'No phone number configured' };
  }

  // ── Route by event type ───────────────────────────────────
  try {
    switch (event) {

      case 'interview_scheduled': {
        if (!payload.briefing) {
          return { success: false, messageIds: [], error: 'briefing required for interview_scheduled' };
        }
        const result = await sendInterviewBriefing(prisma, user, phone, payload.briefing);
        messageIds.push(...result);
        break;
      }

      case 'interview_request': {
        const data = payload.rawData as { companyName: string; jobTitle: string; recruiterName?: string; recruiterEmail: string };
        const { body, buttons } = fmt.formatInterviewRequest(
          data.companyName, data.jobTitle, data.recruiterName ?? null, data.recruiterEmail,
        );
        const r = await waClient.sendInteractive(phone, body, buttons);
        if (r.waMessageId) messageIds.push(r.waMessageId);
        break;
      }

      case 'availability_requested': {
        const data = payload.rawData as { companyName: string; jobTitle: string; recruiterName?: string; recruiterEmail: string };
        const { body, buttons } = fmt.formatInterviewRequest(
          data.companyName, data.jobTitle, data.recruiterName ?? null, data.recruiterEmail,
        );
        const r = await waClient.sendInteractive(phone, body, buttons);
        if (r.waMessageId) messageIds.push(r.waMessageId);
        break;
      }

      case 'offer_received': {
        const data = payload.rawData as {
          companyName: string; jobTitle: string; recruiterName?: string;
          salary?: string; startDate?: string;
        };
        const text = fmt.formatOfferReceived(
          data.companyName, data.jobTitle, data.recruiterName ?? null,
          data.salary ?? null, data.startDate ?? null,
        );
        const r = await waClient.sendText(phone, text);
        if (r.waMessageId) messageIds.push(r.waMessageId);
        break;
      }

      case 'rejection': {
        const data = payload.rawData as { companyName: string; jobTitle: string; isSoft?: boolean };
        const text = fmt.formatRejection(data.companyName, data.jobTitle, data.isSoft ?? false);
        const r = await waClient.sendText(phone, text);
        if (r.waMessageId) messageIds.push(r.waMessageId);
        break;
      }

      case 'soft_rejection': {
        const data = payload.rawData as { companyName: string; jobTitle: string };
        const text = fmt.formatRejection(data.companyName, data.jobTitle, true);
        const r = await waClient.sendText(phone, text);
        if (r.waMessageId) messageIds.push(r.waMessageId);
        break;
      }

      case 'application_submitted': {
        const data = payload.rawData as {
          companyName: string; jobTitle: string;
          appliedAt: string; followUpDays: number[];
        };
        const text = fmt.formatApplicationSubmitted(
          data.companyName, data.jobTitle,
          new Date(data.appliedAt), data.followUpDays ?? [3, 7, 14],
        );
        const r = await waClient.sendText(phone, text);
        if (r.waMessageId) messageIds.push(r.waMessageId);
        break;
      }

      case 'follow_up_sent': {
        const data = payload.rawData as {
          companyName: string; jobTitle: string;
          followUpNumber: 1 | 2 | 3; nextFollowUpAt?: string;
        };
        const text = fmt.formatFollowUpSent(
          data.companyName, data.jobTitle, data.followUpNumber,
          data.nextFollowUpAt ? new Date(data.nextFollowUpAt) : null,
        );
        const r = await waClient.sendText(phone, text);
        if (r.waMessageId) messageIds.push(r.waMessageId);
        break;
      }

      case 'assessment_received': {
        const data = payload.rawData as {
          companyName: string; jobTitle: string;
          platform?: string; deadline?: string; link?: string;
        };
        const text = fmt.formatAssessmentReceived(
          data.companyName, data.jobTitle,
          data.platform ?? null, data.deadline ?? null, data.link ?? null,
        );
        const r = await waClient.sendText(phone, text);
        if (r.waMessageId) messageIds.push(r.waMessageId);
        break;
      }

      case 'daily_digest': {
        await sendDailyDigest(prisma, userId, phone, user.name ?? 'there');
        break;
      }

      default:
        logger.warn('Unknown notification event', { event });
    }

    // ── Record in DB ────────────────────────────────────────
    await recordNotification(prisma, userId, applicationId ?? null, event, messageIds);

    logger.info('WhatsApp notification dispatched', {
      userId, event, phone: phone.slice(-4),
      messages: messageIds.length,
    });

    return { success: true, messageIds };

  } catch (err) {
    logger.error('Dispatch error', { userId, event, error: String(err) });
    return { success: false, messageIds, error: String(err) };
  }
}

// ─────────────────────────────────────────────────────────────
// INTERVIEW BRIEFING FLOW
// ─────────────────────────────────────────────────────────────
async function sendInterviewBriefing(
  prisma:   PrismaClient,
  user:     { id: string; name: string | null },
  phone:    string,
  briefing: InterviewBriefing,
): Promise<string[]> {
  // Enrich briefing with resume text if available
  if (!briefing.resumeText) {
    const resume = await prisma.resume.findFirst({
      where:   { userId: user.id, isActive: true },
      select:  { parsedText: true },
      orderBy: { createdAt: 'desc' },
    });
    if (resume?.parsedText) {
      briefing = { ...briefing, resumeText: resume.parsedText.slice(0, 1000) };
    }
  }

  // Generate AI content
  const generated = await generateInterviewBriefing(briefing);

  // Format into 4 message parts
  const parts = fmt.formatInterviewBriefing(briefing, generated);

  // Send with 1s delay between parts
  const results = await waClient.sendMultiPart(phone, parts, 1000);

  return results
    .filter(r => r.success && r.waMessageId)
    .map(r => r.waMessageId!);
}

// ─────────────────────────────────────────────────────────────
// DAILY DIGEST
// ─────────────────────────────────────────────────────────────
async function sendDailyDigest(
  prisma:    PrismaClient,
  userId:    string,
  phone:     string,
  name:      string,
): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [applied, interviews, offers, followUpsSent, topMatches] = await Promise.all([
    prisma.application.count({ where: { userId, appliedAt: { gte: since } } }),
    prisma.interviewSchedule.count({
      where: { application: { userId }, createdAt: { gte: since } },
    }),
    prisma.application.count({ where: { userId, status: 'OFFER_RECEIVED' } }),
    prisma.followupLog.count({ where: { userId, status: 'SENT', sentAt: { gte: since } } }),
    prisma.jobMatch.findMany({
      where:   { userId, createdAt: { gte: since }, recommendation: { in: ['APPLY', 'STRONG_MATCH'] } },
      orderBy: { matchScore: 'desc' },
      take:    5,
      include: { jobListing: { select: { jobTitle: true, company: true } } },
    }),
  ]);

  const digestEntries: fmt.DigestEntry[] = topMatches.map(m => ({
    companyName: m.jobListing.company,
    jobTitle:    m.jobListing.jobTitle,
    status:      m.recommendation,
    matchScore:  m.matchScore,
  }));

  const text = fmt.formatDailyDigest(
    name, new Date(), applied, interviews, offers, digestEntries, followUpsSent,
  );

  await waClient.sendText(phone, text);
}

// ─────────────────────────────────────────────────────────────
// RECORD NOTIFICATION IN DB
// ─────────────────────────────────────────────────────────────
async function recordNotification(
  prisma:        PrismaClient,
  userId:        string,
  applicationId: string | null,
  event:         string,
  messageIds:    string[],
): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        userId,
        type:    event.toUpperCase(),
        channel: 'WHATSAPP',
        title:   event.replace(/_/g, ' '),
        body:    `WhatsApp notification sent`,
        data:    { messageIds, sentAt: new Date().toISOString() } as import('@prisma/client').Prisma.JsonObject,
        isSent:  messageIds.length > 0,
        isRead:  false,
      },
    });
  } catch (err) {
    // Non-fatal — notification table may not have all fields
    logger.debug('Notification record failed (non-fatal)', { error: String(err) });
  }
}
