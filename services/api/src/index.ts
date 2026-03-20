/**
 * ============================================================
 * Job Hunter AI — API Service Entry Point
 *
 * Boot order is CRITICAL:
 *   1. loadSecrets()     — resolves /run/secrets/ files, wipes env vars
 *   2. connectDatabase() — uses resolved DATABASE_URL
 *   3. connectRedis()    — uses resolved REDIS_URL
 *   4. initQueues()      — uses Redis connection
 *   5. createApp()       — assembles Express, receives secrets object
 *   6. createServer()    — HTTP + WebSocket
 *   7. listen()
 *
 * loadSecrets() MUST run before any import that touches process.env
 * for a managed secret — after loading it wipes those env vars so no
 * code can accidentally read raw secrets from the environment.
 * ============================================================
 */

// ── Step 0: Secrets FIRST — before any other business logic ──
import { loadSecrets } from '@job-hunter/shared/secrets';
const secrets = loadSecrets();   // exits 1 if any required secret is missing

// ── Regular imports ───────────────────────────────────────────
import { createApp }       from './app.js';
import { createServer }    from './server.js';
import { connectDatabase } from './lib/database.js';
import { connectRedis }    from './lib/redis.js';
import { initQueues }      from './lib/queues.js';
import { logger }          from './lib/logger.js';

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);

/** Strip credentials from error messages before they reach the logger */
function sanitizeMessage(msg: string): string {
  return msg
    .replace(/(?<=:\/\/[^:]*:)[^@]+(?=@)/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/sk-ant-[A-Za-z0-9\-_]+/g, 'sk-ant-[REDACTED]')
    .replace(/eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g, '[JWT]');
}

async function bootstrap(): Promise<void> {
  try {
    logger.info('Starting Job Hunter AI API', {
      port: PORT,
      env: process.env['NODE_ENV'],
      corsOrigins: process.env['CORS_ORIGINS'] ?? 'not set',
    });

    await connectDatabase(secrets.DATABASE_URL);
    logger.info('PostgreSQL connected');

    await connectRedis(secrets.REDIS_URL);
    logger.info('Redis connected');

    await initQueues(secrets.REDIS_URL);
    logger.info('BullMQ queues initialized');

    const app    = createApp(secrets);
    const server = createServer(app, secrets);

    server.listen(PORT, '0.0.0.0', () => {
      logger.info('API server ready', { port: PORT });
    });

    const shutdown = async (signal: string): Promise<void> => {
      logger.info(`Received ${signal} — shutting down gracefully`);
      server.close(() => { process.exit(0); });
      setTimeout(() => {
        logger.warn('Shutdown timed out, forcing exit');
        process.exit(1);
      }, 30_000).unref();
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT',  () => void shutdown('SIGINT'));

    process.on('unhandledRejection', (reason) => {
      const safe = reason instanceof Error
        ? { name: reason.name, message: sanitizeMessage(reason.message) }
        : { type: typeof reason };
      logger.error('Unhandled rejection', safe);
      process.exit(1);
    });

  } catch (error) {
    const safe = error instanceof Error
      ? sanitizeMessage(error.message) : 'unknown error';
    logger.error('Failed to start API server', { error: safe });
    process.exit(1);
  }
}

bootstrap();
