/**
 * ============================================================
 * packages/shared/src/logger.ts
 *
 * Pino logger factory — single source of truth for log format
 * across all services: API, workers, scrapers, bot.
 *
 * WHY PINO OVER WINSTON?
 * ─────────────────────
 * • 5–8× faster (writes to stdout as NDJSON with no overhead)
 * • Native JSON output — Promtail/Loki can parse without a
 *   pipeline regex stage
 * • Built-in child logger support (.child({ requestId })) with
 *   zero performance cost
 * • pino-http replaces express-morgan with a single middleware
 *
 * LOG SCHEMA (every log line)
 * ──────────────────────────
 * {
 *   "time":      "2024-06-15T09:23:41.123Z",   ← RFC3339Nano
 *   "level":     30,                            ← pino numeric (info=30)
 *   "service":   "api",                         ← from createLogger(service)
 *   "requestId": "abc-123",                     ← from child logger
 *   "userId":    "usr_xyz",                     ← from child logger
 *   "msg":       "Request completed",
 *   ...additional fields
 * }
 *
 * USAGE
 * ─────
 *   // Service logger (singleton per service)
 *   export const logger = createLogger('worker-bot');
 *   logger.info({ applicationId, portal }, 'Bot session started');
 *
 *   // Request-scoped child (binds requestId + userId)
 *   const reqLog = requestLogger(logger, requestId, userId);
 *   reqLog.warn({ statusCode: 429 }, 'Rate limited by portal');
 *
 * DEVELOPMENT
 * ───────────
 * Set LOG_PRETTY=true to get colorized human-readable output.
 * In production, always use raw JSON (parsed by Promtail).
 * ============================================================
 */

import pino, { type Logger, type LoggerOptions } from 'pino';

// ── Log level ─────────────────────────────────────────────────
// Maps string env value to pino level.
// Valid: trace, debug, info, warn, error, fatal

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

function resolveLevel(): LogLevel {
  const raw = process.env['LOG_LEVEL']?.toLowerCase();
  const valid: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  return valid.includes(raw as LogLevel) ? (raw as LogLevel) : 'info';
}

// ── Base logger options ───────────────────────────────────────

function buildOptions(service: string): LoggerOptions {
  const isPretty = process.env['LOG_PRETTY'] === 'true' ||
                   process.env['NODE_ENV']  === 'development';

  const base: LoggerOptions = {
    level: resolveLevel(),

    // ── Fields that appear on every log line ─────────────
    base: {
      service,
      pid:     process.pid,
      version: process.env['npm_package_version'] ?? '1.0.0',
    },

    // ── Timestamp: RFC3339Nano (parseable by Promtail) ───
    timestamp: pino.stdTimeFunctions.isoTime,

    // ── Error serialization ──────────────────────────────
    serializers: {
      err:   pino.stdSerializers.err,
      error: pino.stdSerializers.err,
      req:   pino.stdSerializers.req,
      res:   pino.stdSerializers.res,
    },

    // ── Redact sensitive values before they hit logs ─────
    // These are redacted to "[REDACTED]" if present in any log field.
    redact: {
      paths: [
        'password',
        'token',
        'accessToken',
        'refreshToken',
        'authorization',
        'cookie',
        'apiKey',
        '*.password',
        '*.token',
        '*.accessToken',
        '*.refreshToken',
        'req.headers.authorization',
        'req.headers.cookie',
      ],
      censor: '[REDACTED]',
    },
  };

  // ── Pretty printing for development ──────────────────────
  if (isPretty) {
    return {
      ...base,
      transport: {
        target:  'pino-pretty',
        options: {
          colorize:         true,
          translateTime:    'SYS:yyyy-mm-dd HH:MM:ss.l',
          ignore:           'pid,hostname,version',
          singleLine:       false,
          messageKey:       'msg',
          levelFirst:       true,
          customPrettifiers: {
            service: (s: string) => `[${s}]`,
          },
        },
      },
    };
  }

  // ── Production: raw JSON to stdout ───────────────────────
  // Promtail reads from Docker json-file driver → parses JSON → Loki
  return base;
}

// ── Factory function ──────────────────────────────────────────

/**
 * Create a service-level Pino logger.
 * Call once per service (module-level singleton).
 *
 * @param service  Service name (e.g. 'api', 'worker-bot')
 */
export function createLogger(service: string): Logger {
  return pino(buildOptions(service));
}

// ── Child logger helpers ──────────────────────────────────────

/**
 * Create a request-scoped child logger.
 * Binds requestId and optionally userId to all log lines.
 * Zero allocation cost — pino reuses the parent config.
 */
export function requestLogger(
  parent:    Logger,
  requestId: string,
  userId?:   string | null,
): Logger {
  return parent.child({
    requestId,
    ...(userId ? { userId } : {}),
  });
}

/**
 * Create a job-scoped child logger.
 * Binds jobId, queue, and optionally userId.
 */
export function jobLogger(
  parent: Logger,
  jobId:  string,
  queue:  string,
  userId?: string | null,
): Logger {
  return parent.child({
    jobId,
    queue,
    ...(userId ? { userId } : {}),
  });
}

/**
 * Create a bot-session child logger.
 * Binds applicationId, portal (job board name), and userId.
 */
export function botSessionLogger(
  parent:        Logger,
  applicationId: string,
  portal:        string,
  userId?:       string | null,
): Logger {
  return parent.child({
    applicationId,
    portal,
    ...(userId ? { userId } : {}),
  });
}

// ── Default service-agnostic logger ──────────────────────────
// Used by shared utilities that don't have a service context.
export const defaultLogger = createLogger('shared');
