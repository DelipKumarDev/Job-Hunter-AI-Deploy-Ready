// ============================================================
// Application State Machine
// Maps EmailAnalysisResult → validated DB writes.
//
// Transitions allowed:
//   APPLIED       → INTERVIEW_SCHEDULED, REJECTED, REVIEWING
//   REVIEWING     → INTERVIEW_SCHEDULED, REJECTED
//   INTERVIEWING  → OFFER_RECEIVED, REJECTED, INTERVIEWING
//   OFFER_RECEIVED → ACCEPTED, DECLINED
//
// Each transition:
//  1. Validates transition is legal
//  2. Updates applications.status
//  3. Appends application_status_history row
//  4. Cancels pending follow-ups if needed
//  5. Creates/updates interview_schedules if relevant
//  6. Enqueues notification to user
//  7. Returns list of ApplicationAction for audit
// ============================================================

import type { PrismaClient } from '@prisma/client';
import type {
  EmailAnalysisResult,
  ApplicationAction,
  ResponseIntent,
} from './analyzerTypes.js';
import { logger } from '../utils/logger.js';

// ── Legal status transitions ──────────────────────────────────
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  QUEUED:               ['APPLIED', 'FAILED'],
  APPLIED:              ['INTERVIEW_SCHEDULED', 'REJECTED', 'WITHDRAWN', 'OFFER_RECEIVED', 'REVIEWING'],
  REVIEWING:            ['INTERVIEW_SCHEDULED', 'REJECTED', 'WITHDRAWN', 'OFFER_RECEIVED'],
  INTERVIEW_SCHEDULED:  ['INTERVIEW_SCHEDULED', 'REJECTED', 'WITHDRAWN', 'OFFER_RECEIVED', 'REVIEWING'],
  OFFER_RECEIVED:       ['ACCEPTED', 'DECLINED', 'WITHDRAWN'],
  REJECTED:             [],   // Terminal
  ACCEPTED:             [],   // Terminal
  DECLINED:             [],   // Terminal
  WITHDRAWN:            [],   // Terminal
};

// ── Intent → status mapping ───────────────────────────────────
const INTENT_TO_STATUS: Partial<Record<ResponseIntent, string>> = {
  interview_scheduled:    'INTERVIEW_SCHEDULED',
  interview_request:      'REVIEWING',
  availability_request:   'REVIEWING',
  calendar_link_sent:     'REVIEWING',
  moved_to_next_stage:    'REVIEWING',
  offer_extended:         'OFFER_RECEIVED',
  rejection:              'REJECTED',
  rejection_soft:         'REJECTED',
};

const INTENTS_CANCEL_FOLLOWUPS: ResponseIntent[] = [
  'interview_scheduled', 'interview_request', 'availability_request',
  'calendar_link_sent', 'moved_to_next_stage', 'offer_extended',
  'rejection', 'rejection_soft', 'request_for_information',
];

// ─────────────────────────────────────────────────────────────
// MAIN — Apply all DB actions for an analysis result
// ─────────────────────────────────────────────────────────────
export async function applyAnalysisActions(
  prisma:        PrismaClient,
  analysis:      EmailAnalysisResult,
  applicationId: string,
  userId:        string,
): Promise<ApplicationAction[]> {
  const actions: ApplicationAction[] = [];

  try {
    const app = await prisma.application.findUniqueOrThrow({
      where: { id: applicationId },
      select: { id: true, status: true, jobListingId: true,
                jobListing: { select: { jobTitle: true, company: true } } },
    });

    const currentStatus = app.status;

    // ── 1. Status transition ─────────────────────────────────
    const newStatus = INTENT_TO_STATUS[analysis.intent];
    if (newStatus && newStatus !== currentStatus) {
      if (isTransitionAllowed(currentStatus, newStatus)) {
        await prisma.application.update({
          where: { id: applicationId },
          data:  { status: newStatus as 'INTERVIEW_SCHEDULED' | 'REVIEWING' | 'REJECTED' | 'OFFER_RECEIVED' },
        });

        await prisma.applicationStatusHistory.create({
          data: {
            applicationId,
            fromStatus:  currentStatus,
            toStatus:    newStatus,
            changedBy:   'email_analyzer',
            note:        `Intent: ${analysis.intent} (${Math.round(analysis.confidence * 100)}% confidence)`,
          },
        });

        actions.push({ type: 'status_updated', from: currentStatus, to: newStatus });
        logger.info('Application status updated by email analyzer', {
          applicationId, from: currentStatus, to: newStatus, intent: analysis.intent,
        });
      } else {
        logger.warn('Transition blocked by state machine', { currentStatus, newStatus, applicationId });
      }
    }

    // ── 2. Create / update interview schedule ────────────────
    if (
      (analysis.intent === 'interview_scheduled' || analysis.intent === 'interview_request') &&
      analysis.datetime
    ) {
      const interviewAction = await upsertInterview(prisma, applicationId, analysis);
      if (interviewAction) actions.push(interviewAction);
    }

    // ── 3. Cancel pending follow-ups ─────────────────────────
    if (INTENTS_CANCEL_FOLLOWUPS.includes(analysis.intent)) {
      const count = await cancelFollowUps(prisma, userId, applicationId, analysis.intent);
      if (count > 0) {
        actions.push({ type: 'followups_cancelled', count, reason: analysis.intent });
      }
    }

    // ── 4. Log requested documents ───────────────────────────
    if (
      analysis.intent === 'request_for_information' &&
      analysis.entities.requestedDocuments.length > 0
    ) {
      actions.push({
        type:      'document_requested',
        documents: analysis.entities.requestedDocuments,
      });
      logger.info('Documents requested by recruiter', {
        applicationId,
        docs: analysis.entities.requestedDocuments,
      });
    }

    // ── 5. Enqueue user notification ─────────────────────────
    const notifPayload = buildNotificationPayload(analysis, app, applicationId);
    if (notifPayload) {
      await prisma.notification.create({ data: notifPayload });
      actions.push({ type: 'notification_sent', channel: 'in_app' });
    }

  } catch (err) {
    logger.error('applyAnalysisActions failed', { applicationId, error: String(err) });
  }

  return actions;
}

// ─────────────────────────────────────────────────────────────
// CREATE / UPDATE INTERVIEW SCHEDULE
// ─────────────────────────────────────────────────────────────
async function upsertInterview(
  prisma:        PrismaClient,
  applicationId: string,
  analysis:      EmailAnalysisResult,
): Promise<ApplicationAction | null> {
  try {
    const dt     = analysis.datetime!;
    const mtg    = analysis.meeting;
    const entity = analysis.entities;

    const scheduledAt = dt.isoDatetime
      ? new Date(dt.isoDatetime)
      : new Date(Date.now() + 7 * 86400 * 1000); // +7 days if no confirmed time

    // Count existing interviews to determine round
    const existingCount = await prisma.interviewSchedule.count({
      where: { applicationId },
    });
    const round = existingCount + 1;

    const mapFormat = (fmt: string | null | undefined) => {
      const m: Record<string, string> = {
        phone_screen: 'PHONE', video_call: 'VIDEO', technical_interview: 'TECHNICAL',
        onsite: 'ONSITE', panel: 'PANEL', informal_chat: 'INFORMAL', take_home_assessment: 'TAKE_HOME',
      };
      return m[fmt ?? ''] ?? 'PHONE';
    };

    const record = await prisma.interviewSchedule.upsert({
      where:  { applicationId_round: { applicationId, round } },
      create: {
        applicationId,
        scheduledAt,
        interviewType: mapFormat(mtg?.format) as 'PHONE' | 'VIDEO' | 'TECHNICAL' | 'ONSITE' | 'PANEL' | 'INFORMAL' | 'TAKE_HOME',
        status:        analysis.intent === 'interview_scheduled' ? 'CONFIRMED' : 'TENTATIVE',
        platform:      mtg?.platform       ?? null,
        meetingLink:   mtg?.meetingLink    ?? null,
        calendarLink:  mtg?.calendarLink   ?? null,
        dialInNumber:  mtg?.dialInNumber   ?? null,
        durationMins:  mtg?.duration       ?? null,
        interviewers:  mtg?.interviewers   ?? [],
        timezone:      dt.timezone         ?? null,
        hiringManager: entity.hiringManager ?? null,
        round,
        notes: [
          dt.rawText,
          mtg?.notes,
          entity.location ? `Location: ${entity.location}` : null,
        ].filter(Boolean).join('\n'),
      },
      update: {
        scheduledAt,
        status:      analysis.intent === 'interview_scheduled' ? 'CONFIRMED' : 'TENTATIVE',
        platform:    mtg?.platform    ?? undefined,
        meetingLink: mtg?.meetingLink ?? undefined,
        calendarLink: mtg?.calendarLink ?? undefined,
        timezone:    dt.timezone      ?? undefined,
      },
    });

    logger.info('Interview schedule upserted', {
      applicationId, round, scheduledAt: scheduledAt.toISOString(),
      format: mtg?.format, platform: mtg?.platform,
    });

    return { type: 'interview_created', interviewId: record.id, scheduledAt: scheduledAt.toISOString() };
  } catch (err) {
    logger.error('upsertInterview failed', { error: String(err) });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// CANCEL FOLLOW-UPS
// ─────────────────────────────────────────────────────────────
async function cancelFollowUps(
  prisma:        PrismaClient,
  userId:        string,
  applicationId: string,
  reason:        string,
): Promise<number> {
  const { count } = await prisma.followupLog.updateMany({
    where: { userId, applicationId, status: 'PENDING' },
    data:  { status: 'CANCELLED', cancelledReason: reason },
  });
  return count;
}

// ─────────────────────────────────────────────────────────────
// BUILD NOTIFICATION PAYLOAD
// ─────────────────────────────────────────────────────────────
function buildNotificationPayload(
  analysis:      EmailAnalysisResult,
  app:           { jobListing: { jobTitle: string; company: string } },
  applicationId: string,
): object | null {
  const { jobTitle, company } = app.jobListing;

  const templates: Partial<Record<ResponseIntent, { title: string; body: string; type: string }>> = {
    interview_scheduled: {
      type:  'INTERVIEW_SCHEDULED',
      title: `🎉 Interview confirmed — ${company}`,
      body:  `Your interview for ${jobTitle} at ${company} has been scheduled. Check your calendar for details.`,
    },
    interview_request: {
      type:  'INTERVIEW_REQUESTED',
      title: `📅 Interview request — ${company}`,
      body:  `${company} wants to schedule an interview for the ${jobTitle} role. Reply to confirm your availability.`,
    },
    availability_request: {
      type:  'AVAILABILITY_REQUESTED',
      title: `🗓️ Share your availability — ${company}`,
      body:  `${company} is asking for your available times for a ${jobTitle} interview.`,
    },
    calendar_link_sent: {
      type:  'CALENDAR_LINK_RECEIVED',
      title: `📅 Scheduling link received — ${company}`,
      body:  `Book your interview slot for ${jobTitle} at ${company} using the scheduling link.`,
    },
    offer_extended: {
      type:  'OFFER_RECEIVED',
      title: `🎊 Offer received — ${company}!`,
      body:  `You've received a job offer for ${jobTitle} at ${company}. Review the offer details now.`,
    },
    rejection: {
      type:  'APPLICATION_REJECTED',
      title: `Application update — ${company}`,
      body:  `${company} has decided not to move forward with your ${jobTitle} application at this time.`,
    },
    request_for_information: {
      type:  'INFO_REQUESTED',
      title: `📋 Action needed — ${company}`,
      body:  `${company} is requesting additional information for your ${jobTitle} application.`,
    },
    moved_to_next_stage: {
      type:  'STAGE_ADVANCED',
      title: `✅ Moving forward — ${company}`,
      body:  `Great news! You're advancing to the next stage for ${jobTitle} at ${company}.`,
    },
    assessment_sent: {
      type:  'ASSESSMENT_RECEIVED',
      title: `📝 Assessment received — ${company}`,
      body:  `${company} has sent you an assessment for the ${jobTitle} role. Complete it before the deadline.`,
    },
  };

  const tmpl = templates[analysis.intent];
  if (!tmpl) return null;

  return {
    userId:        '', // Caller must inject
    type:          tmpl.type,
    channel:       'IN_APP',
    title:         tmpl.title,
    body:          tmpl.body,
    data: {
      applicationId,
      intent:     analysis.intent,
      confidence: analysis.confidence,
      emailId:    analysis.emailId,
    },
    isRead: false,
    isSent: false,
  };
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function isTransitionAllowed(from: string, to: string): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
