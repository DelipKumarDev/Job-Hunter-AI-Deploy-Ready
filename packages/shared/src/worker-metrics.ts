// ============================================================
// packages/shared/src/worker-metrics.ts
//
// Thin wrapper that initialises WorkerMetrics (or BotMetrics),
// starts the :9100 Prometheus scrape server, and exports a
// singleton + helpers used by every worker.
//
// Workers call initWorkerMetrics() once at startup.
// Processors call recordJobMetrics() after each job completes.
//
// The 9100 port is internal only — never exposed to the internet.
// Prometheus scrapes it from inside the Docker network.
// ============================================================

import { type Registry } from 'prom-client';
import { WorkerMetrics, BotMetrics, createRegistry, createMetricsServer } from './metrics.js';
import type { Server } from 'http';

// ── Singleton state ───────────────────────────────────────────
let _workerMetrics: WorkerMetrics | null = null;
let _metricsServer: Server | null = null;

/**
 * Initialise the metrics registry and start the HTTP scrape server.
 * Call once at worker startup, before processing any jobs.
 *
 * @param service   Service name ('worker-scraper', 'worker-bot', etc.)
 * @param isBot     If true, creates BotMetrics (superset of WorkerMetrics)
 * @param port      Prometheus scrape port (default 9100)
 */
export async function initWorkerMetrics(
  service: string,
  isBot    = false,
  port     = 9100,
): Promise<WorkerMetrics> {
  if (_workerMetrics) return _workerMetrics;

  const registry = createRegistry({ service });

  _workerMetrics = isBot
    ? new BotMetrics(registry)
    : new WorkerMetrics(service, registry);

  _metricsServer = await createMetricsServer(port, registry);

  console.log(`[metrics] Prometheus scrape server listening on :${port}/metrics`);
  return _workerMetrics;
}

/** Get the initialised metrics instance. Throws if not initialised. */
export function getWorkerMetrics(): WorkerMetrics {
  if (!_workerMetrics) {
    throw new Error('[metrics] getWorkerMetrics() called before initWorkerMetrics()');
  }
  return _workerMetrics;
}

/** Get BotMetrics specifically (only valid for worker-bot). */
export function getBotMetrics(): BotMetrics {
  const m = getWorkerMetrics();
  if (!(m instanceof BotMetrics)) {
    throw new Error('[metrics] getBotMetrics() called on non-bot worker');
  }
  return m;
}

/** Close the metrics HTTP server on worker shutdown. */
export async function closeMetricsServer(): Promise<void> {
  if (_metricsServer) {
    await new Promise<void>((resolve, reject) => {
      _metricsServer!.close((err) => err ? reject(err) : resolve());
    });
    _metricsServer = null;
  }
}

// ── Portal extraction helper ──────────────────────────────────
// Derives a short portal name from a job application URL.
// Used as the `portal` label on bot metrics.

const PORTAL_PATTERNS: [RegExp, string][] = [
  [/linkedin\.com/i,        'linkedin'],
  [/greenhouse\.io/i,       'greenhouse'],
  [/lever\.co/i,            'lever'],
  [/ashbyhq\.com/i,         'ashby'],
  [/workday\.com/i,         'workday'],
  [/smartrecruiters\.com/i, 'smartrecruiters'],
  [/taleo\.net/i,           'taleo'],
  [/bamboohr\.com/i,        'bamboohr'],
  [/wellfound\.com/i,       'wellfound'],
  [/naukri\.com/i,          'naukri'],
];

export function extractPortal(applyUrl: string): string {
  try {
    const url = new URL(applyUrl);
    for (const [pattern, name] of PORTAL_PATTERNS) {
      if (pattern.test(url.hostname)) return name;
    }
    return url.hostname.replace(/^www\./, '').split('.')[0] ?? 'other';
  } catch {
    return 'other';
  }
}

// Re-export types so workers only need to import from here
export { WorkerMetrics, BotMetrics };
export type { Registry };
