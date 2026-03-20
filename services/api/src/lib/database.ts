/**
 * ============================================================
 * Database — Prisma Client singleton
 *
 * connectDatabase() accepts the resolved URL explicitly so the
 * connection string never needs to exist in process.env after
 * the secrets loader has wiped it.
 * ============================================================
 */

import { PrismaClient } from '@prisma/client';
import { logger }       from './logger.js';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

let _prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!_prisma) throw new Error('[database] getPrisma() called before connectDatabase()');
  return _prisma;
}

// Proxy so existing `prisma.user.findUnique(…)` calls keep working
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) { return getPrisma()[prop as keyof PrismaClient]; },
});

/**
 * Open the Prisma connection using an explicitly supplied URL.
 * NEVER read from process.env inside this function.
 */
export async function connectDatabase(databaseUrl: string): Promise<void> {
  if (!databaseUrl) throw new Error('[database] databaseUrl must be non-empty');

  if (globalThis.__prisma) {
    _prisma = globalThis.__prisma;
    await _prisma.$queryRaw`SELECT 1`;
    return;
  }

  _prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: process.env['DATABASE_LOG_QUERIES'] === 'true'
      ? [
          { emit: 'event', level: 'query' as const },
          { emit: 'event', level: 'error' as const },
        ]
      : [{ emit: 'event', level: 'error' as const }],
    errorFormat: 'minimal',
  });

  if (process.env['DATABASE_LOG_QUERIES'] === 'true') {
    // @ts-expect-error Prisma event typing
    _prisma.$on('query', (e: { query: string; duration: number }) => {
      if (e.duration > 100) {
        logger.warn('Slow query', { query: e.query.substring(0, 300), durationMs: e.duration });
      }
    });
  }

  // @ts-expect-error Prisma event typing
  _prisma.$on('error', (e: { message: string }) => {
    logger.error('Prisma error', {
      message: e.message.replace(/(?<=:\/\/[^:]*:)[^@]+(?=@)/g, '[REDACTED]'),
    });
  });

  if (process.env['NODE_ENV'] !== 'production') globalThis.__prisma = _prisma;

  try {
    await _prisma.$connect();
    await _prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[database] Connection failed: ${msg.replace(/(?<=:\/\/[^:]*:)[^@]+(?=@)/g, '[REDACTED]')}`);
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (_prisma) { await _prisma.$disconnect(); _prisma = null; }
}
