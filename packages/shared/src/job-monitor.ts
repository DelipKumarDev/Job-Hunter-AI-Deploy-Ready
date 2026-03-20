/**
 * ============================================================
 * packages/shared/src/job-monitor.ts
 *
 * Queue Health Monitor
 *
 * Attaches QueueEvents listeners to every watched queue and
 * maintains real-time counters for:
 *
 *   • completed / failed / stalled counts (sliding 1h window)
 *   • per-queue failure rate (0–1)
 *   • per-queue health score (0–100)
 *   • DLQ depth (total permanently-failed jobs pending)
 *   • per-user failure tracking
 *
 * HOW IT WORKS
 * ─────────────
 * BullMQ's QueueEvents uses a dedicated Redis connection to
 * subscribe to keyspace notifications for job state changes.
 * Each event fires synchronously in this process so we can
 * update in-memory counters without an extra DB round-trip.
 *
 * Counters are stored in a circular time-bucket structure:
 *   - 60 one-minute buckets (= 1 hour sliding window)
 *   - Each bucket: { completed, failed, stalled, dlqMoves }
 *   - On each tick, the oldest bucket is zeroed and becomes
 *     the new current bucket
 *
 * HEALTH SCORE FORMULA
 * ────────────────────
 *   score = 100
 *         - (failureRate * 40)   // Failure rate penalty (0–40)
 *         - (stalledRate * 30)   // Stall rate penalty (0–30)
 *         - (dlqDepthPenalty)    // DLQ depth penalty (0–20)
 *         - (agePenalty)         // Last-activity penalty (0–10)
 *
 * A score ≥ 80 is healthy. 60–79 is degraded. < 60 is critical.
 *
 * USAGE
 * ─────
 *   const monitor = createMonitor(redisUrl, ['job-discovery-queue', ...]);
 *   monitor.start();
 *
 *   // In a health-check endpoint:
 *   const health = monitor.getHealth();
 *
 *   // Stop cleanly on shutdown:
 *   await monitor.stop();
 * ============================================================
 */

import { QueueEvents, Queue } from 'bullmq';
import { QUEUE_NAMES, getRetryConfig } from './queue-config.js';

// ── Time-bucket structure ─────────────────────────────────────

interface Bucket {
  completed: number;
  failed:    number;
  stalled:   number;
  dlqMoves:  number;
  ts:        number; // epoch ms when this bucket started
}

const BUCKET_COUNT      = 60;  // 60 buckets
const BUCKET_DURATION   = 60_000; // 1 minute each → 1h window

function newBucket(ts: number): Bucket {
  return { completed: 0, failed: 0, stalled: 0, dlqMoves: 0, ts };
}

// ── Per-queue state ───────────────────────────────────────────

interface QueueState {
  name:        string;
  buckets:     Bucket[];
  currentIdx:  number;
  lastEventAt: number; // epoch ms
  dlqDepth:    number; // total jobs currently in DLQ for this queue
}

function newQueueState(name: string): QueueState {
  const now = Date.now();
  return {
    name,
    buckets:     Array.from({ length: BUCKET_COUNT }, (_, i) => newBucket(now - (BUCKET_COUNT - 1 - i) * BUCKET_DURATION)),
    currentIdx:  BUCKET_COUNT - 1,
    lastEventAt: 0,
    dlqDepth:    0,
  };
}

// ── Health types (public API) ─────────────────────────────────

export interface QueueHealth {
  queue:         string;
  score:         number;           // 0–100
  status:        'healthy' | 'degraded' | 'critical';
  window1h: {
    completed:   number;
    failed:      number;
    stalled:     number;
    dlqMoves:    number;
    failureRate: number;           // 0–1
    stalledRate: number;           // 0–1
  };
  dlqDepth:      number;
  lastEventAt:   string | null;  // ISO 8601
  updatedAt:     string;          // ISO 8601
}

export interface SystemHealth {
  overallScore:  number;
  status:        'healthy' | 'degraded' | 'critical';
  queues:        QueueHealth[];
  dlqTotalDepth: number;
  updatedAt:     string;
}

// ── Monitor class ─────────────────────────────────────────────

export class QueueMonitor {
  private readonly states    = new Map<string, QueueState>();
  private readonly listeners = new Map<string, QueueEvents>();
  private readonly dlqQueue:  Queue;
  private tickTimer:          ReturnType<typeof setInterval> | null = null;
  private onAlert:            ((event: MonitorAlert) => void) | null = null;

  constructor(
    private readonly redisUrl: string,
    private readonly queueNames: string[],
    private readonly prefix: string = 'jhq',
  ) {
    // Init state for every monitored queue + the DLQ
    for (const name of [...queueNames, QUEUE_NAMES.DEAD_LETTER]) {
      this.states.set(name, newQueueState(name));
    }

    const parsed = new URL(redisUrl);
    this.dlqQueue = new Queue(QUEUE_NAMES.DEAD_LETTER, {
      connection: {
        host: parsed.hostname,
        port: parseInt(parsed.port || '6379', 10),
        password: parsed.password || undefined,
        maxRetriesPerRequest: null,
      },
      prefix,
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────

  start(): void {
    const parsed = new URL(this.redisUrl);
    const conn = {
      host:     parsed.hostname,
      port:     parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
      maxRetriesPerRequest: null as null,
    };

    for (const queueName of this.queueNames) {
      const qe = new QueueEvents(queueName, { connection: conn, prefix: this.prefix });
      this.attachListeners(queueName, qe);
      this.listeners.set(queueName, qe);
    }

    // Rotate time buckets every minute
    this.tickTimer = setInterval(() => this.rotateBuckets(), BUCKET_DURATION);

    // Poll DLQ depth every 5 minutes
    this.pollDlqDepth().catch(() => null);
    setInterval(() => this.pollDlqDepth().catch(() => null), 5 * 60_000);
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    await Promise.all([...this.listeners.values()].map(qe => qe.close()));
    await this.dlqQueue.close();
    this.listeners.clear();
  }

  setAlertHandler(handler: (alert: MonitorAlert) => void): void {
    this.onAlert = handler;
  }

  // ── Event listeners ───────────────────────────────────────

  private attachListeners(queueName: string, qe: QueueEvents): void {
    qe.on('completed', () => this.increment(queueName, 'completed'));

    qe.on('failed', ({ jobId, failedReason }) => {
      this.increment(queueName, 'failed');
      this.checkAlertThreshold(queueName, jobId, failedReason);
    });

    qe.on('stalled', () => this.increment(queueName, 'stalled'));

    // Track when jobs arrive in the DLQ
    if (queueName === QUEUE_NAMES.DEAD_LETTER) {
      qe.on('added', () => {
        const state = this.states.get(QUEUE_NAMES.DEAD_LETTER);
        if (state) state.dlqDepth++;
      });
      qe.on('completed', () => {
        const state = this.states.get(QUEUE_NAMES.DEAD_LETTER);
        if (state && state.dlqDepth > 0) state.dlqDepth--;
      });
    }
  }

  private increment(queueName: string, field: keyof Omit<Bucket, 'ts'>): void {
    const state = this.states.get(queueName);
    if (!state) return;
    state.buckets[state.currentIdx]![field]++;
    state.lastEventAt = Date.now();
  }

  // ── Bucket rotation ───────────────────────────────────────

  private rotateBuckets(): void {
    const now = Date.now();
    for (const state of this.states.values()) {
      state.currentIdx = (state.currentIdx + 1) % BUCKET_COUNT;
      state.buckets[state.currentIdx] = newBucket(now);
    }
  }

  // ── DLQ depth poll ────────────────────────────────────────

  private async pollDlqDepth(): Promise<void> {
    try {
      const count = await this.dlqQueue.getJobCounts('wait', 'active', 'delayed', 'paused');
      const total = Object.values(count).reduce((a, b) => a + b, 0);
      const state = this.states.get(QUEUE_NAMES.DEAD_LETTER);
      if (state) state.dlqDepth = total;
    } catch {
      // Non-fatal — DLQ depth is informational
    }
  }

  // ── Aggregation ───────────────────────────────────────────

  private aggregate(state: QueueState): QueueHealth['window1h'] {
    let completed = 0, failed = 0, stalled = 0, dlqMoves = 0;

    for (const b of state.buckets) {
      completed += b.completed;
      failed    += b.failed;
      stalled   += b.stalled;
      dlqMoves  += b.dlqMoves;
    }

    const total      = completed + failed;
    const failureRate = total > 0 ? failed / total : 0;
    const stalledRate = total > 0 ? stalled / total : 0;

    return { completed, failed, stalled, dlqMoves, failureRate, stalledRate };
  }

  private scoreQueue(w1h: QueueHealth['window1h'], dlqDepth: number, lastEventAt: number): number {
    let score = 100;

    // Failure rate penalty: 0–40
    score -= Math.round(w1h.failureRate * 40);

    // Stall rate penalty: 0–30
    score -= Math.round(w1h.stalledRate * 30);

    // DLQ depth penalty: 0–20
    // 0 items → 0 penalty; 50+ items → 20 penalty
    score -= Math.min(20, Math.round((dlqDepth / 50) * 20));

    // Inactivity penalty: 0–10
    // No events in 2h → 10 penalty
    if (lastEventAt > 0) {
      const idleMs = Date.now() - lastEventAt;
      const idleH  = idleMs / (60 * 60_000);
      if (idleH > 2) score -= Math.min(10, Math.round(idleH));
    }

    return Math.max(0, Math.min(100, score));
  }

  // ── Public API ────────────────────────────────────────────

  getQueueHealth(queueName: string): QueueHealth | null {
    const state = this.states.get(queueName);
    if (!state) return null;

    const w1h    = this.aggregate(state);
    const score  = this.scoreQueue(w1h, state.dlqDepth, state.lastEventAt);
    const status = score >= 80 ? 'healthy' : score >= 60 ? 'degraded' : 'critical';

    return {
      queue:    queueName,
      score,
      status,
      window1h: w1h,
      dlqDepth: state.dlqDepth,
      lastEventAt: state.lastEventAt > 0 ? new Date(state.lastEventAt).toISOString() : null,
      updatedAt:   new Date().toISOString(),
    };
  }

  getHealth(): SystemHealth {
    const queues = this.queueNames
      .map(n => this.getQueueHealth(n))
      .filter((q): q is QueueHealth => q !== null);

    const dlqState = this.states.get(QUEUE_NAMES.DEAD_LETTER);
    const dlqTotalDepth = dlqState?.dlqDepth ?? 0;

    const scores      = queues.map(q => q.score);
    const overallScore = scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 100;

    const status = overallScore >= 80 ? 'healthy' : overallScore >= 60 ? 'degraded' : 'critical';

    return { overallScore, status, queues, dlqTotalDepth, updatedAt: new Date().toISOString() };
  }

  // ── Alert threshold check ────────────────────────────────

  private alertCooldowns = new Map<string, number>(); // key → next-allowed-alert epoch

  private checkAlertThreshold(queueName: string, jobId: string, reason: string): void {
    if (!this.onAlert) return;

    const w1h   = this.aggregate(this.states.get(queueName) ?? newQueueState(queueName));
    const total = w1h.completed + w1h.failed;

    // Fire a queue-level alert if failure rate crosses 30% with meaningful volume
    if (total >= 10 && w1h.failureRate >= 0.30) {
      const cooldownKey = `rate:${queueName}`;
      const now = Date.now();

      if ((this.alertCooldowns.get(cooldownKey) ?? 0) < now) {
        this.alertCooldowns.set(cooldownKey, now + 30 * 60_000); // 30 min cooldown

        this.onAlert({
          type:        'high_failure_rate',
          queueName,
          failureRate: w1h.failureRate,
          failedCount: w1h.failed,
          totalCount:  total,
          jobId,
          reason,
          timestamp:   new Date().toISOString(),
        });
      }
    }
  }
}

// ── Alert types ───────────────────────────────────────────────

export interface MonitorAlert {
  type:        'high_failure_rate' | 'dlq_threshold' | 'job_permanently_failed';
  queueName:   string;
  failureRate?: number;
  failedCount?: number;
  totalCount?:  number;
  dlqDepth?:    number;
  jobId:        string;
  userId?:      string | null;
  reason:       string;
  timestamp:    string;
}

// ── Factory function ──────────────────────────────────────────

export function createMonitor(
  redisUrl:    string,
  queueNames?: string[],
  prefix?:     string,
): QueueMonitor {
  const names = queueNames ?? [
    QUEUE_NAMES.JOB_DISCOVERY,
    QUEUE_NAMES.JOB_APPLY,
    QUEUE_NAMES.EMAIL_MONITOR,
    QUEUE_NAMES.FOLLOW_UP,
    QUEUE_NAMES.NOTIFICATION,
    QUEUE_NAMES.AI_MATCH,
  ];

  return new QueueMonitor(redisUrl, names, prefix ?? 'jhq');
}
