// ============================================================
// Bull Board — BullMQ Queue Dashboard
// Accessible at /queues (protected by basic auth in prod)
// ============================================================

import { createBullBoard }        from '@bull-board/api';
import { BullMQAdapter }          from '@bull-board/api/bullMQAdapter.js';
import { ExpressAdapter }         from '@bull-board/express';
import { QUEUES }                 from './queues.js';

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/queues');

// Lazily initialize - queues must be initialized first via initQueues()
let boardInitialized = false;

export function initBullBoard(): void {
  if (boardInitialized) return;

  try {
    const { getQueueOrDirect } = require('./queues.js');

    const adapters = Object.values(QUEUES).map(
      (name) => new BullMQAdapter(getQueueOrDirect(name))
    );

    createBullBoard({ queues: adapters, serverAdapter });
    boardInitialized = true;
  } catch (err) {
    // Non-fatal - Bull Board is a dev/ops convenience, not critical path
    console.warn('[bull-board] Failed to initialize:', (err as Error).message);
  }
}

export const bullBoardRouter = serverAdapter.getRouter();
