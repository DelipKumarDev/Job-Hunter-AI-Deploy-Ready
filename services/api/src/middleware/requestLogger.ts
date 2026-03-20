// ============================================================
// Request Logger Middleware
//
// Dual-purpose middleware:
//  1. Structured request/response logging via Pino child logger
//  2. Prometheus metrics: latency histogram + request counter
//
// Each request gets a unique requestId (UUID v4) injected as
//   - X-Request-ID response header
//   - req.headers['x-request-id'] (for downstream logging)
//   - child logger binding (every log in the request scope
//     automatically includes requestId)
//
// The 'route' label on metrics uses req.route.path if available
// (e.g. /api/v1/jobs/:id) to avoid per-user-id cardinality
// explosion. Falls back to req.path for non-router requests.
// ============================================================

import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import { apiMetrics } from '../lib/apiMetrics.js';

// Extend Express Request with typed properties
declare global {
  namespace Express {
    interface Request {
      id:  string;
      log: import('pino').Logger;
    }
    interface User {
      id: string;
    }
  }
}

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  // ── Request ID ──────────────────────────────────────────────
  const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
  req.id = requestId;
  req.headers['x-request-id'] = requestId;
  res.setHeader('X-Request-ID', requestId);

  // ── Bind child logger to request ────────────────────────────
  // req.log is available anywhere in the request lifecycle.
  // userId is not yet known at request start; bind after auth.
  req.log = logger.child({ requestId });

  // ── Metrics: track active connections ──────────────────────
  apiMetrics.httpActiveConnections.inc();

  // ── Start timer ─────────────────────────────────────────────
  const startHrTime = process.hrtime.bigint();

  // ── Record on response finish ───────────────────────────────
  res.on('finish', () => {
    const durationNs  = process.hrtime.bigint() - startHrTime;
    const durationSec = Number(durationNs) / 1e9;

    // Use Express route pattern for metric labels to avoid high cardinality.
    // req.route is populated only after the router matches — must read after finish.
    const route      = req.route?.path ?? req.path ?? 'unknown';
    const method     = req.method;
    const statusCode = String(res.statusCode);
    const userId     = req.user?.id ?? null;

    // ── Prometheus metrics ───────────────────────────────────
    const metricLabels = { method, route, status_code: statusCode };
    apiMetrics.httpRequestDuration.labels(metricLabels).observe(durationSec);
    apiMetrics.httpRequestsTotal.labels(metricLabels).inc();
    apiMetrics.httpActiveConnections.dec();

    // ── Structured log ────────────────────────────────────────
    const logLevel = res.statusCode >= 500 ? 'error'
                   : res.statusCode >= 400 ? 'warn'
                   : 'info';

    req.log[logLevel]({
      method,
      route,
      statusCode:  res.statusCode,
      durationMs:  Math.round(durationSec * 1000),
      userId,
      ip:          req.ip,
      userAgent:   req.headers['user-agent'],
      contentLength: res.getHeader('content-length'),
    }, 'Request completed');
  });

  next();
}

// Backwards-compatible named export (existing imports use requestLogger)
export { requestLoggerMiddleware as requestLogger };
