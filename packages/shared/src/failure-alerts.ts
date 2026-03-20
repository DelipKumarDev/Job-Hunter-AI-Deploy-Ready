/**
 * ============================================================
 * packages/shared/src/failure-alerts.ts
 *
 * Failure Alert System
 *
 * Decides WHEN to send alerts and WHERE to send them.
 *
 * ALERT TIERS
 * ───────────
 * Two separate alert triggers per job:
 *
 *   Tier 1 — Warning (mid-retry):
 *     Fired when a job reaches attempt >= warnAttempt (default: 3)
 *     but has not yet exhausted retries. Tells operators "this job
 *     is struggling — watch it."
 *     → Sent to: operator Slack webhook (if configured)
 *               + structured log (always)
 *
 *   Tier 2 — Critical (DLQ move):
 *     Fired when a job exhausts all retries and is moved to the
 *     dead-letter queue. Tells operators "this job permanently
 *     failed — action required."
 *     → Sent to: operator Slack webhook
 *               + WhatsApp notification to affected user (if user-facing job)
 *               + structured log
 *
 * USER-FACING vs SYSTEM JOBS
 * ──────────────────────────
 * User-facing queues (JOB_APPLY, FOLLOW_UP, EMAIL_MONITOR):
 *   → Also send a WhatsApp notification to the user so they
 *     know their application / email is having trouble and
 *     can take manual action.
 *
 * System queues (JOB_DISCOVERY, AI_MATCH):
 *   → Operator-only alert. No user notification (users don't
 *     know about or care about the discovery pipeline internals).
 *
 * DEDUPLICATION
 * ─────────────
 * Alerts are deduplicated with a per-job cooldown stored in
 * Redis. Key: jh-alert:sent:{tier}:{queueName}:{jobId}
 * TTL: 6 hours. Prevents alert storms when a job retries
 * rapidly or when the DLQ accumulates duplicates.
 *
 * SLACK INTEGRATION
 * ─────────────────
 * Set ALERT_SLACK_WEBHOOK_URL in environment to receive
 * structured Slack Block Kit messages for every alert.
 * If not set, alerts are still logged but not sent externally.
 *
 * WHATSAPP INTEGRATION
 * ────────────────────
 * Uses the existing notification queue (worker-notification).
 * Adds a job to the `notification-queue` with event type
 * 'job_failed_alert'. The notification worker dispatches it
 * via the standard WhatsApp dispatch pipeline.
 * ============================================================
 */

import type { Redis } from 'ioredis';
import type { Job }   from 'bullmq';
import { Queue }      from 'bullmq';
import type { DeadLetterEntry } from './dead-letter.js';
import { QUEUE_NAMES, getRetryConfig } from './queue-config.js';

// ── Alert deduplication ───────────────────────────────────────

const ALERT_COOLDOWN_TTL_SECS = 6 * 60 * 60; // 6 hours

async function hasAlertBeenSent(
  redis:     Redis,
  tier:      'warn' | 'critical',
  queueName: string,
  jobId:     string,
): Promise<boolean> {
  const key = `jh-alert:sent:${tier}:${queueName}:${jobId}`;
  const val = await redis.get(key);
  return val !== null;
}

async function markAlertSent(
  redis:     Redis,
  tier:      'warn' | 'critical',
  queueName: string,
  jobId:     string,
): Promise<void> {
  const key = `jh-alert:sent:${tier}:${queueName}:${jobId}`;
  await redis.set(key, '1', 'EX', ALERT_COOLDOWN_TTL_SECS);
}

// ── Queue classification ──────────────────────────────────────

const USER_FACING_QUEUES = new Set([
  QUEUE_NAMES.JOB_APPLY,
  QUEUE_NAMES.FOLLOW_UP,
  QUEUE_NAMES.EMAIL_MONITOR,
]);

function isUserFacingQueue(queueName: string): boolean {
  return USER_FACING_QUEUES.has(queueName);
}

// ── Notification queue handle ─────────────────────────────────

let _notifQueue: Queue | null = null;

function getNotificationQueue(redisUrl: string, prefix: string): Queue {
  if (!_notifQueue) {
    const parsed = new URL(redisUrl);
    _notifQueue = new Queue(QUEUE_NAMES.NOTIFICATION, {
      connection: {
        host:     parsed.hostname,
        port:     parseInt(parsed.port || '6379', 10),
        password: parsed.password || undefined,
        maxRetriesPerRequest: null,
      },
      prefix,
    });
  }
  return _notifQueue;
}

// ── Slack alert sender ────────────────────────────────────────

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  fields?: Array<{ type: string; text: string }>;
  elements?: Array<{ type: string; text: { type: string; text: string } }>;
}

async function sendSlackAlert(webhookUrl: string, blocks: SlackBlock[]): Promise<void> {
  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ blocks }),
    });
    if (!res.ok) {
      console.error('[failure-alerts] Slack webhook returned non-OK', { status: res.status });
    }
  } catch (err) {
    console.error('[failure-alerts] Slack webhook failed', { error: String(err) });
  }
}

function buildWarnSlackBlocks(
  queueName:     string,
  jobId:         string,
  attempt:       number,
  maxAttempts:   number,
  errorMessage:  string,
  workerService: string,
  userId:        string | null,
): SlackBlock[] {
  const emoji = '⚠️';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *Job Failing — Retries Remaining*`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Queue*\n\`${queueName}\`` },
        { type: 'mrkdwn', text: `*Attempt*\n${attempt} of ${maxAttempts}` },
        { type: 'mrkdwn', text: `*Service*\n${workerService}` },
        { type: 'mrkdwn', text: `*Job ID*\n\`${jobId}\`` },
        ...(userId ? [{ type: 'mrkdwn', text: `*User*\n${userId}` }] : []),
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Error*\n\`\`\`${errorMessage.slice(0, 300)}\`\`\`` },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `🕐 ${new Date().toISOString()} · Will retry automatically` },
      ],
    },
  ];
}

function buildCriticalSlackBlocks(entry: DeadLetterEntry): SlackBlock[] {
  const emoji = '🚨';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *Job Permanently Failed — Moved to DLQ*`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Queue*\n\`${entry.sourceQueue}\`` },
        { type: 'mrkdwn', text: `*Total Attempts*\n${entry.totalAttempts}` },
        { type: 'mrkdwn', text: `*Service*\n${entry.workerService}` },
        { type: 'mrkdwn', text: `*DLQ Job*\n\`dlq-${entry.sourceQueue}-${entry.sourceJobId}\`` },
        ...(entry.userId ? [{ type: 'mrkdwn', text: `*User*\n${entry.userId}` }] : []),
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Final Error*\n\`\`\`${entry.finalError.slice(0, 300)}\`\`\`` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*💡 Remediation Hint*\n${entry.remediationHint}` },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `First failed: ${entry.firstFailedAt} · Moved to DLQ: ${entry.movedToDlqAt}` },
      ],
    },
  ];
}

// ── WhatsApp user notification ────────────────────────────────

function buildUserFacingMessage(entry: DeadLetterEntry): string {
  const queueLabel: Record<string, string> = {
    [QUEUE_NAMES.JOB_APPLY]:     'job application',
    [QUEUE_NAMES.FOLLOW_UP]:     'follow-up email',
    [QUEUE_NAMES.EMAIL_MONITOR]: 'inbox sync',
  };

  const what = queueLabel[entry.sourceQueue] ?? 'background task';

  return [
    `⚠️ *Issue with your ${what}*`,
    '',
    `We ran into a persistent problem and weren't able to complete your ${what} automatically.`,
    '',
    `*What to do:* You can try again manually from the Job Hunter app. Our team has been notified.`,
    '',
    `_Reference: ${entry.sourceJobId}_`,
  ].join('\n');
}

// ── Public API ────────────────────────────────────────────────

export interface AlertContext {
  redis:         Redis;
  redisUrl:      string;
  workerService: string;
  prefix?:       string;
}

/**
 * Tier 1 Alert: job is struggling but still has retries.
 *
 * Call from worker.on('failed') when attempts == warnAttempt.
 * Sends to Slack only (not the user — it may still succeed).
 */
export async function sendWarnAlert(
  ctx:   AlertContext,
  job:   Job,
  error: Error,
): Promise<void> {
  const queueName = job.queueName;
  const jobId     = job.id ?? 'unknown';
  const config    = getRetryConfig(queueName);
  const userId    = (job.data as Record<string, unknown>)?.userId as string | null ?? null;

  // Deduplicate — only one warn alert per job across all retries
  if (await hasAlertBeenSent(ctx.redis, 'warn', queueName, jobId)) return;
  await markAlertSent(ctx.redis, 'warn', queueName, jobId);

  const slackUrl = process.env['ALERT_SLACK_WEBHOOK_URL'];

  // Structured log always
  console.warn('[failure-alerts] JOB_WARN', {
    queueName,
    jobId,
    attempt:       job.attemptsMade,
    maxAttempts:   config.maxAttempts,
    error:         error.message,
    workerService: ctx.workerService,
    userId,
  });

  // Slack alert
  if (slackUrl) {
    await sendSlackAlert(
      slackUrl,
      buildWarnSlackBlocks(
        queueName,
        jobId,
        job.attemptsMade,
        config.maxAttempts,
        error.message,
        ctx.workerService,
        userId,
      ),
    );
  }
}

/**
 * Tier 2 Alert: job permanently failed and was moved to DLQ.
 *
 * Call from maybeMoveToDeadLetter after it returns 'dlq'.
 * Sends to Slack + WhatsApp user notification for user-facing queues.
 */
export async function sendCriticalAlert(
  ctx:   AlertContext,
  entry: DeadLetterEntry,
): Promise<void> {
  const { sourceQueue, sourceJobId, userId } = entry;

  // Deduplicate — only one critical alert per job
  if (await hasAlertBeenSent(ctx.redis, 'critical', sourceQueue, sourceJobId)) return;
  await markAlertSent(ctx.redis, 'critical', sourceQueue, sourceJobId);

  const slackUrl = process.env['ALERT_SLACK_WEBHOOK_URL'];

  // Structured log always
  console.error('[failure-alerts] JOB_CRITICAL_FAILURE', {
    sourceQueue,
    sourceJobId,
    userId,
    totalAttempts:   entry.totalAttempts,
    finalError:      entry.finalError,
    remediationHint: entry.remediationHint,
    workerService:   entry.workerService,
    movedToDlqAt:    entry.movedToDlqAt,
  });

  // Slack critical alert
  if (slackUrl) {
    await sendSlackAlert(slackUrl, buildCriticalSlackBlocks(entry));
  }

  // User WhatsApp notification for user-facing queues with a known userId
  if (userId && isUserFacingQueue(sourceQueue)) {
    try {
      const notifQueue = getNotificationQueue(ctx.redisUrl, ctx.prefix ?? 'jhq');
      await notifQueue.add(
        'job-failure-alert',
        {
          userId,
          event:   'job_failed_alert',
          rawData: {
            queue:   sourceQueue,
            jobId:   sourceJobId,
            message: buildUserFacingMessage(entry),
          },
        },
        {
          attempts:         2,
          backoff:          { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 500 },
          removeOnFail:     { count: 100 },
          // Low priority — don't compete with real interview alerts
          priority: 8,
        },
      );
    } catch (err) {
      console.error('[failure-alerts] Failed to enqueue WhatsApp alert', {
        userId,
        error: String(err),
      });
    }
  }
}

/**
 * Combined handler: call from every worker's `worker.on('failed')` event.
 *
 * Determines the right alert tier and fires it if needed.
 * Returns the tier that was processed ('warn', 'critical', or 'none').
 */
export async function handleJobFailure(
  ctx:           AlertContext,
  job:           Job | undefined,
  error:         Error,
  dlqEntry?:     DeadLetterEntry | null,
): Promise<'warn' | 'critical' | 'none'> {
  if (!job?.id) return 'none';

  const config  = getRetryConfig(job.queueName);

  // Tier 2 — final failure with DLQ entry
  if (dlqEntry) {
    await sendCriticalAlert(ctx, dlqEntry);
    return 'critical';
  }

  // Tier 1 — mid-retry warning at the configured warn threshold
  if (job.attemptsMade === config.warnAttempt) {
    await sendWarnAlert(ctx, job, error);
    return 'warn';
  }

  return 'none';
}

export async function closeAlertQueues(): Promise<void> {
  if (_notifQueue) {
    await _notifQueue.close();
    _notifQueue = null;
  }
}
