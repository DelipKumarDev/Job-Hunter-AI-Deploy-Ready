/**
 * ============================================================
 * packages/shared/src/metrics.ts
 *
 * Prometheus metrics — shared definitions for all services.
 *
 * Uses prom-client, the de-facto Node.js Prometheus client.
 * Each service creates its own Registry (prevents cross-service
 * metric bleed when running multiple services in the same
 * process in tests), but imports the metric DEFINITIONS from
 * this module for consistency.
 *
 * METRIC CATALOGUE
 * ────────────────
 * API:
 *   http_request_duration_seconds   histogram  method, route, status_code
 *   http_requests_total             counter    method, route, status_code
 *   http_active_connections         gauge
 *
 * Workers (all queues):
 *   worker_job_duration_seconds     histogram  queue, worker_service, status
 *   worker_jobs_total               counter    queue, worker_service, status
 *   worker_job_active_count         gauge      queue, worker_service
 *   worker_dlq_depth                gauge      (total across all queues)
 *
 * Bot (worker-bot specific):
 *   bot_applications_total          counter    status, portal
 *   bot_session_duration_seconds    histogram  portal, status
 *   bot_captcha_encounters_total    counter    vendor, portal
 *   bot_fields_filled_total         histogram  portal
 *
 * Process (automatic from prom-client):
 *   process_cpu_seconds_total
 *   process_resident_memory_bytes
 *   nodejs_heap_size_bytes
 *   nodejs_event_loop_lag_seconds
 *   etc.
 *
 * USAGE
 * ─────
 *   // In worker-bot/src/metrics.ts:
 *   import { createMetricsServer, BotMetrics } from '@job-hunter/shared';
 *   const metrics = new BotMetrics();
 *   const server = await createMetricsServer(9100);
 *
 *   // Record a completed application:
 *   metrics.botApplicationsTotal.labels({ status: 'applied', portal: 'linkedin' }).inc();
 *   metrics.botSessionDuration.labels({ portal: 'linkedin', status: 'applied' }).observe(durationSec);
 *
 * METRICS SERVER
 * ──────────────
 * Workers expose metrics on :9100 (Prometheus scrapes this).
 * The API exposes metrics at /metrics on its main port 3001.
 * ============================================================
 */

import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
  type DefaultMetricsCollectorConfiguration,
} from 'prom-client';
import * as http from 'http';

// ── Shared Registry factory ───────────────────────────────────

/**
 * Create a Prometheus registry pre-loaded with Node.js default
 * metrics (heap, event loop, GC, etc.).
 *
 * @param labels  Labels applied to every metric in this registry
 */
export function createRegistry(labels: Record<string, string> = {}): Registry {
  const registry = new Registry();

  const defaultConfig: DefaultMetricsCollectorConfiguration<Registry> = {
    register: registry,
    labels,
    gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
  };

  collectDefaultMetrics(defaultConfig);
  return registry;
}

// ══════════════════════════════════════════════════════════════
// API Metrics
// ══════════════════════════════════════════════════════════════

export class ApiMetrics {
  readonly registry: Registry;

  /** Histogram: HTTP request latency in seconds */
  readonly httpRequestDuration: Histogram<string>;

  /** Counter: Total HTTP requests */
  readonly httpRequestsTotal: Counter<string>;

  /** Gauge: Currently active HTTP connections */
  readonly httpActiveConnections: Gauge<string>;

  constructor(registry?: Registry) {
    this.registry = registry ?? createRegistry({ service: 'api' });

    this.httpRequestDuration = new Histogram({
      name:       'http_request_duration_seconds',
      help:       'HTTP request latency in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets:    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers:  [this.registry],
    });

    this.httpRequestsTotal = new Counter({
      name:       'http_requests_total',
      help:       'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers:  [this.registry],
    });

    this.httpActiveConnections = new Gauge({
      name:      'http_active_connections',
      help:      'Number of active HTTP connections',
      registers: [this.registry],
    });
  }
}

// ══════════════════════════════════════════════════════════════
// Worker Metrics (shared by all workers)
// ══════════════════════════════════════════════════════════════

export class WorkerMetrics {
  readonly registry: Registry;

  /** Histogram: How long each job takes in seconds */
  readonly workerJobDuration: Histogram<string>;

  /** Counter: Total jobs processed, labeled by status */
  readonly workerJobsTotal: Counter<string>;

  /** Gauge: Currently active (in-flight) jobs */
  readonly workerJobActive: Gauge<string>;

  /** Gauge: Total jobs in the dead-letter queue */
  readonly workerDlqDepth: Gauge<string>;

  /** Gauge: BullMQ queue waiting depth */
  readonly workerQueueWaiting: Gauge<string>;

  constructor(service: string, registry?: Registry) {
    this.registry = registry ?? createRegistry({ service });

    this.workerJobDuration = new Histogram({
      name:       'worker_job_duration_seconds',
      help:       'Time spent processing each job in seconds',
      labelNames: ['queue', 'worker_service', 'status'],
      // Buckets cover: 1s increments up to 10s, then 30s, 1min, 5min, 10min
      buckets:    [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600],
      registers:  [this.registry],
    });

    this.workerJobsTotal = new Counter({
      name:       'worker_jobs_total',
      help:       'Total number of jobs processed',
      labelNames: ['queue', 'worker_service', 'status'],
      registers:  [this.registry],
    });

    this.workerJobActive = new Gauge({
      name:       'worker_job_active_count',
      help:       'Number of jobs currently being processed',
      labelNames: ['queue', 'worker_service'],
      registers:  [this.registry],
    });

    this.workerDlqDepth = new Gauge({
      name:      'worker_dlq_depth',
      help:      'Number of permanently-failed jobs in the dead-letter queue',
      registers: [this.registry],
    });

    this.workerQueueWaiting = new Gauge({
      name:       'worker_queue_waiting',
      help:       'Number of jobs waiting in each queue',
      labelNames: ['queue'],
      registers:  [this.registry],
    });
  }

  /**
   * Convenience: record a completed job with its duration.
   * Call at the end of every job processor.
   */
  recordJob(queue: string, service: string, status: string, durationMs: number): void {
    const labels = { queue, worker_service: service, status };
    this.workerJobDuration.labels(labels).observe(durationMs / 1000);
    this.workerJobsTotal.labels(labels).inc();
  }
}

// ══════════════════════════════════════════════════════════════
// Bot-specific Metrics
// ══════════════════════════════════════════════════════════════

export class BotMetrics extends WorkerMetrics {

  /** Counter: Application outcomes by status and portal */
  readonly botApplicationsTotal: Counter<string>;

  /** Histogram: Full bot session duration in seconds */
  readonly botSessionDuration: Histogram<string>;

  /** Counter: CAPTCHA encounters by type and portal */
  readonly botCaptchaEncounters: Counter<string>;

  /** Histogram: Number of form fields filled per session */
  readonly botFieldsFilled: Histogram<string>;

  constructor(registry?: Registry) {
    super('worker-bot', registry);

    this.botApplicationsTotal = new Counter({
      name:       'bot_applications_total',
      help:       'Total bot application attempts by outcome',
      labelNames: ['status', 'portal'],  // status: applied|failed|skipped|captcha
      registers:  [this.registry],
    });

    this.botSessionDuration = new Histogram({
      name:       'bot_session_duration_seconds',
      help:       'End-to-end bot session duration in seconds',
      labelNames: ['portal', 'status'],
      buckets:    [10, 30, 60, 90, 120, 180, 240, 300, 360, 420, 480],
      registers:  [this.registry],
    });

    this.botCaptchaEncounters = new Counter({
      name:       'bot_captcha_encounters_total',
      help:       'Number of CAPTCHAs encountered during bot sessions',
      labelNames: ['vendor', 'portal'],  // vendor: recaptcha|hcaptcha|cloudflare|turnstile|arkose
      registers:  [this.registry],
    });

    this.botFieldsFilled = new Histogram({
      name:       'bot_fields_filled_per_session',
      help:       'Number of form fields filled in each bot session',
      labelNames: ['portal'],
      buckets:    [1, 3, 5, 10, 15, 20, 30, 50],
      registers:  [this.registry],
    });
  }

  /**
   * Record a complete bot application attempt.
   */
  recordApplication(opts: {
    status:     string;   // applied | failed | skipped | captcha
    portal:     string;   // linkedin | greenhouse | lever | ...
    durationMs: number;
    fieldsFilled: number;
  }): void {
    const { status, portal, durationMs, fieldsFilled } = opts;
    this.botApplicationsTotal.labels({ status, portal }).inc();
    this.botSessionDuration.labels({ portal, status }).observe(durationMs / 1000);
    this.botFieldsFilled.labels({ portal }).observe(fieldsFilled);
    // Also record in the generic worker metric
    this.recordJob('job-apply-queue', 'worker-bot', status, durationMs);
  }
}

// ══════════════════════════════════════════════════════════════
// Metrics HTTP server
// ══════════════════════════════════════════════════════════════

/**
 * Start a lightweight HTTP server that exposes /metrics
 * for Prometheus scraping.
 *
 * Workers call this at startup to expose their metrics on port 9100.
 * The API uses its main Express router instead.
 *
 * @param port      Port to listen on (default: 9100)
 * @param registry  The prom-client Registry to serialize
 */
export function createMetricsServer(
  port:     number = 9100,
  registry: Registry,
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.url === '/metrics' && req.method === 'GET') {
        try {
          const metrics = await registry.metrics();
          res.writeHead(200, { 'Content-Type': registry.contentType });
          res.end(metrics);
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
      } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(port, '0.0.0.0', () => resolve(server));
    server.on('error', reject);
  });
}
