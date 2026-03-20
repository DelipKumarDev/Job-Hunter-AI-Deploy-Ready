// ============================================================
// BullMQ — Queue Definitions & Initialization
// ============================================================

import { Queue, type ConnectionOptions } from 'bullmq';
import { logger } from './logger.js';

// Queue names (single source of truth)
export const QUEUES = {
  JOB_DISCOVERY: 'job-discovery-queue',  // FIXED: was JOB_SEARCH
  JOB_APPLY: 'job-apply-queue',
  AI_MATCH: 'ai-match-queue',
  RESUME_TAILOR: 'resume-tailor-queue',
  EMAIL_MONITOR: 'email-monitor-queue',
  FOLLOW_UP: 'followup-queue',
  NOTIFICATION: 'notification-queue',
  INTERVIEW_PREP: 'interview-prep-queue',
} as const;

export type QueueName = typeof QUEUES[keyof typeof QUEUES];

// Redis connection for BullMQ
function getRedisConnection(): ConnectionOptions {
  const url = redisUrl ?? process.env['REDIS_URL'];
  if (!url) throw new Error('REDIS_URL is required for BullMQ');

  // BullMQ needs host/port format, not URL string
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
    maxRetriesPerRequest: null, // Required for BullMQ
  };
}

// Default job options per queue
const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { count: 100 },  // Keep last 100 completed
  removeOnFail: { count: 500 },      // Keep last 500 failed for inspection
};

// Queue singletons
const queues = new Map<string, Queue>();

export function getQueue(name: QueueName): Queue {
  if (!queues.has(name)) {
    throw new Error(`Queue "${name}" not initialized. Call initQueues() first.`);
  }
  return queues.get(name)!;
}

export async function initQueues(redisUrl?: string): Promise<void> {
  const connection = getRedisConnection();

  for (const queueName of Object.values(QUEUES)) {
    const queue = new Queue(queueName, {
      connection,
      prefix: process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });

    queues.set(queueName, queue);
    logger.debug(`Queue initialized: ${queueName}`);
  }

  logger.info(`✅ ${queues.size} BullMQ queues initialized`);
}

// ── Queue helpers ──────────────────────────────────────────

export interface JobSearchPayload {
  userId: string;
  preferenceId: string;
  platforms: string[];
  triggeredBy: 'cron' | 'manual';
}

export interface JobApplyPayload {
  applicationId: string;
  userId: string;
  jobListingId: string;
  tailoredResumeId: string;
  platform: string;
  jobUrl: string;
}

export interface AiMatchPayload {
  userId: string;
  jobListingId: string;
  forceRescore?: boolean;
}

export interface ResumeTailorPayload {
  userId: string;
  resumeId: string;
  jobListingId: string;
  applicationId: string;
}

export interface EmailMonitorPayload {
  userId: string;
  emailAccountId: string;
}

export interface FollowUpPayload {
  applicationId: string;
  userId: string;
  followUpNumber: 1 | 2;
  scheduledAt: string; // ISO string
}

export interface NotificationPayload {
  userId: string;
  type: string;
  channel: 'WHATSAPP' | 'EMAIL' | 'PUSH' | 'IN_APP';
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface InterviewPrepPayload {
  userId: string;
  applicationId: string;
  interviewScheduleId: string;
  companyName: string;
  jobTitle: string;
  jobDescription: string;
}

// Enqueue helpers
export const Queues = {
  async enqueueJobSearch(payload: JobSearchPayload, delay?: number) {
    return getQueue(QUEUES.JOB_DISCOVERY).add('discover', payload, {
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30000 },
    });
  },

  async enqueueJobApply(payload: JobApplyPayload) {
    return getQueue(QUEUES.JOB_APPLY).add('apply', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60000 },
      priority: 1, // Highest priority
    });
  },

  async enqueueAiMatch(payload: AiMatchPayload) {
    return getQueue(QUEUES.AI_MATCH).add('match', payload, {
      attempts: 2,
      backoff: { type: 'fixed', delay: 10000 },
    });
  },

  async enqueueResumeTailor(payload: ResumeTailorPayload) {
    return getQueue(QUEUES.RESUME_TAILOR).add('tailor', payload, {
      attempts: 2,
      backoff: { type: 'fixed', delay: 15000 },
    });
  },

  async enqueueEmailMonitor(payload: EmailMonitorPayload) {
    return getQueue(QUEUES.EMAIL_MONITOR).add('monitor', payload, {
      attempts: 3,
      backoff: { type: 'fixed', delay: 20000 },
    });
  },

  async enqueueFollowUp(payload: FollowUpPayload) {
    const delay = new Date(payload.scheduledAt).getTime() - Date.now();
    return getQueue(QUEUES.FOLLOW_UP).add('followup', payload, {
      delay: Math.max(0, delay),
      attempts: 2,
      backoff: { type: 'fixed', delay: 30000 },
    });
  },

  async enqueueNotification(payload: NotificationPayload) {
    return getQueue(QUEUES.NOTIFICATION).add('notify', payload, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      priority: 1, // High priority
    });
  },

  async enqueueInterviewPrep(payload: InterviewPrepPayload) {
    return getQueue(QUEUES.INTERVIEW_PREP).add('prep', payload, {
      attempts: 2,
      backoff: { type: 'fixed', delay: 30000 },
    });
  },
};

/**
 * Get a named queue from the initialized pool, or create a direct
 * connection queue if called before initQueues() (e.g. in tests).
 * Prefer using getQueue() after initQueues() for production.
 */
export function getQueueOrDirect(name: string): Queue {
  if (queues.has(name)) return queues.get(name)!;

  // Fallback: create a direct connection queue
  const connection = getRedisConnection();
  const q = new Queue(name, {
    connection,
    prefix: process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  queues.set(name, q);
  return q;
}
