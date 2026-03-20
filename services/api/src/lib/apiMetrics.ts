// ============================================================
// services/api/src/lib/apiMetrics.ts
//
// Singleton ApiMetrics instance for the API service.
// Exposes the prom-client registry via Express route at /metrics.
//
// Usage in app.ts:
//   import { metricsHandler } from './lib/apiMetrics.js';
//   app.get('/metrics', metricsHandler);
//
// Usage in request middleware:
//   import { apiMetrics } from './lib/apiMetrics.js';
//   apiMetrics.httpRequestsTotal.labels({ method, route, status_code }).inc();
// ============================================================

import type { Request, Response } from 'express';
import { ApiMetrics, createRegistry } from '@job-hunter/shared';

// One registry per process — safe singleton for the API
const registry = createRegistry({ service: 'api' });
export const apiMetrics = new ApiMetrics(registry);

/**
 * Express route handler for GET /metrics
 * Returns Prometheus exposition format text.
 */
export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const metrics = await registry.metrics();
    res.set('Content-Type', registry.contentType);
    res.status(200).send(metrics);
  } catch (err) {
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
}
