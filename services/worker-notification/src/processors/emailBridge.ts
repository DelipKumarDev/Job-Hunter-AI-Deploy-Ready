// ============================================================
// Email → WhatsApp Bridge
// Called after email analysis completes.
// Maps EmailAnalysisResult intents → WhatsApp notification
// events and enqueues them with full context.
//
// Also called directly by:
//   • Application bot (on APPLIED → submit notification)
//   • Follow-up scheduler (on SENT → follow-up notification)
// ============================================================

import type { PrismaClient } from '@prisma/client';
import type { EmailAnalysisResult } from '../../worker-email/src/analyzer/analyzerTypes.js';
import type { InterviewBriefing, WhatsAppJobPayload } from '../types/notificationTypes.js';
import { enqueueNotification } from './notificationWorker.js';
import { logger } from '../utils/logger.js';

// ── Map email intent → notification event ─────────────────────
const INTENT_TO_EVENT: Record<string, string> = {
  interview_scheduled:    'interview_scheduled',
  interview_request:      'interview_request',
  availability_request:   'availability_requested',
  calendar_link_sent:     'interview_request',
  offer_extended:         'offer_received',
  rejection:              'rejection',
  rejection_soft:         'soft_rejection',
  assessment_sent:        'assessment_received',
  moved_to_next_stage:    'stage_advanced',
};

// ─────────────────────────────────────────────────────────────
// TRIGGER FROM EMAIL ANALYZER
// ─────────────────────────────────────────────────────────────
export async function notifyFromEmailAnalysis(
  prisma:        PrismaClient,
  analysis:      EmailAnalysisResult,
  userId:        string,
  applicationId: string | null,
): Promise<void> {
  const event = INTENT_TO_EVENT[analysis.intent];
  if (!event) {
    logger.debug('No notification for intent', { intent: analysis.intent });
    return;
  }

  // Don't notify for auto-replies or unclassified
  if (['auto_reply', 'unclassified'].includes(analysis.intent)) return;

  const payload = await buildPayload(prisma, userId, event, analysis, applicationId);
  if (!payload) return;

  // High priority for interviews and offers
  const priority = ['interview_scheduled', 'offer_received'].includes(event) ? 1 : 3;

  await enqueueNotification(payload, priority);

  logger.info('WhatsApp notification queued from email', {
    userId, event, intent: analysis.intent,
    applicationId: applicationId ?? 'none',
  });
}

// ─────────────────────────────────────────────────────────────
// TRIGGER ON APPLICATION SUBMITTED
// ─────────────────────────────────────────────────────────────
export async function notifyApplicationSubmitted(
  userId:        string,
  applicationId: string,
  companyName:   string,
  jobTitle:      string,
  appliedAt:     Date,
): Promise<void> {
  await enqueueNotification({
    userId,
    event:         'application_submitted',
    applicationId,
    rawData: {
      companyName,
      jobTitle,
      appliedAt:     appliedAt.toISOString(),
      followUpDays:  [3, 7, 14],
    },
  }, 5);
}

// ─────────────────────────────────────────────────────────────
// TRIGGER ON FOLLOW-UP SENT
// ─────────────────────────────────────────────────────────────
export async function notifyFollowUpSent(
  userId:         string,
  applicationId:  string,
  companyName:    string,
  jobTitle:       string,
  followUpNumber: 1 | 2 | 3,
  nextFollowUpAt: Date | null,
): Promise<void> {
  await enqueueNotification({
    userId,
    event:         'follow_up_sent',
    applicationId,
    rawData: {
      companyName,
      jobTitle,
      followUpNumber,
      nextFollowUpAt: nextFollowUpAt?.toISOString() ?? null,
    },
  }, 7);
}

// ─────────────────────────────────────────────────────────────
// BUILD PAYLOAD — loads app context from DB
// ─────────────────────────────────────────────────────────────
async function buildPayload(
  prisma:        PrismaClient,
  userId:        string,
  event:         string,
  analysis:      EmailAnalysisResult,
  applicationId: string | null,
): Promise<WhatsAppJobPayload | null> {
  const entities = analysis.entities;
  const companyName = entities.companyName ?? 'the company';
  const jobTitle    = entities.jobTitle    ?? 'the role';

  // ── Interview scheduled: build full InterviewBriefing ─────
  if (event === 'interview_scheduled') {
    const briefing = await buildInterviewBriefing(prisma, userId, analysis, applicationId);
    if (!briefing) {
      logger.warn('Could not build interview briefing', { userId, applicationId });
      // Fall through to simpler notification
    } else {
      return { userId, event: 'interview_scheduled', applicationId: applicationId ?? undefined, briefing };
    }
  }

  // ── All other events: rawData payload ─────────────────────
  const rawData: Record<string, unknown> = {
    companyName,
    jobTitle,
    recruiterName:  entities.recruiterName,
    recruiterEmail: analysis.emailId,
    intent:         analysis.intent,
  };

  if (event === 'offer_received') {
    rawData['salary']    = entities.salaryMentioned;
    rawData['startDate'] = entities.startDateMentioned;
  }

  if (event === 'assessment_received') {
    rawData['platform'] = analysis.meeting?.platform;
    rawData['deadline'] = entities.assessmentDeadline ?? entities.deadlineText;
    rawData['link']     = entities.assessmentLink ?? analysis.meeting?.meetingLink;
  }

  return {
    userId,
    event:         event as WhatsAppJobPayload['event'],
    applicationId: applicationId ?? undefined,
    rawData,
  };
}

// ─────────────────────────────────────────────────────────────
// BUILD INTERVIEW BRIEFING from DB + analysis
// ─────────────────────────────────────────────────────────────
async function buildInterviewBriefing(
  prisma:        PrismaClient,
  userId:        string,
  analysis:      EmailAnalysisResult,
  applicationId: string | null,
): Promise<InterviewBriefing | null> {
  try {
    // Load user profile
    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: {
        name:    true,
        email:   true,
        profile: { select: { phone: true, whatsappNumber: true, linkedinUrl: true } },
      },
    });
    if (!user) return null;

    const phone = user.profile?.whatsappNumber ?? user.profile?.phone ?? '';
    if (!phone) return null;

    // Load application + job listing
    let jobDescription: string | null = null;
    let appliedAt       = new Date();

    if (applicationId) {
      const app = await prisma.application.findUnique({
        where:   { id: applicationId },
        select:  {
          appliedAt:  true,
          jobListing: { select: { description: true } },
        },
      });
      if (app) {
        jobDescription = app.jobListing.description;
        appliedAt      = app.appliedAt ?? new Date();
      }
    }

    // Build meeting format label
    const formatLabel = buildFormatLabel(analysis.meeting?.format, analysis.meeting?.platform);

    // Parse time string from ISO datetime
    let interviewTime: string | null = null;
    if (analysis.datetime?.isoDatetime) {
      const dt = new Date(analysis.datetime.isoDatetime);
      interviewTime = dt.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit',
        timeZoneName: 'short',
      });
    }

    return {
      companyName:     analysis.entities.companyName ?? 'the company',
      jobTitle:        analysis.entities.jobTitle    ?? 'the role',
      recruiterName:   analysis.entities.recruiterName,
      recruiterEmail:  '',
      interviewDate:   analysis.datetime?.isoDatetime ? new Date(analysis.datetime.isoDatetime) : null,
      interviewTime,
      timezone:        analysis.datetime?.timezone,
      format:          formatLabel,
      platform:        analysis.meeting?.platform,
      meetingLink:     analysis.meeting?.meetingLink,
      duration:        analysis.meeting?.duration,
      interviewers:    analysis.meeting?.interviewers ?? [],
      jobDescription,
      applicationDate: appliedAt,
      candidateName:   user.name ?? user.email.split('@')[0]!,
      candidatePhone:  phone,
      resumeText:      null, // Loaded later in dispatcher
    };
  } catch (err) {
    logger.error('buildInterviewBriefing error', { error: String(err) });
    return null;
  }
}

function buildFormatLabel(format?: string | null, platform?: string | null): string {
  const labels: Record<string, string> = {
    phone_screen:         'Phone Screen',
    video_call:           'Video Call',
    technical_interview:  'Technical Interview',
    take_home_assessment: 'Take-Home Assessment',
    onsite:               'Onsite Interview',
    panel:                'Panel Interview',
    informal_chat:        'Informal Chat',
  };
  return platform ?? labels[format ?? ''] ?? 'Interview';
}
