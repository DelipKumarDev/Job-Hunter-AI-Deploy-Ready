// ============================================================
// API Logger — Pino structured logger
// Replaces Winston. See packages/shared/src/logger.ts for
// the full schema documentation.
//
// This module re-exports the shared createLogger factory with
// the 'api' service name baked in, so import paths throughout
// the API don't need to change.
// ============================================================

import { createLogger, requestLogger as _reqLogger } from '@job-hunter/shared';
import type { Logger } from 'pino';

export const logger: Logger = createLogger('api');

// Re-export helpers so existing code using this module still works
export { requestLogger, jobLogger } from '@job-hunter/shared';

/**
 * createRequestLogger — backwards-compatible with the old Winston helper.
 * Returns a child logger bound to the given requestId.
 */
export function createRequestLogger(requestId: string, userId?: string): Logger {
  return _reqLogger(logger, requestId, userId ?? undefined);
}
