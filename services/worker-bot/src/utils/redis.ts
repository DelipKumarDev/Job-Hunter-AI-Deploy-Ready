/**
 * Redis utility — accepts explicit URL from secrets loader.
 * Never reads REDIS_URL from process.env.
 */

import Redis from 'ioredis';
import type { ConnectionOptions } from 'bullmq';
import { logger } from './logger.js';

let _client: Redis | null = null;

export function getRedis(): Redis {
  if (!_client) throw new Error('[redis] getRedis() called before connectRedis()');
  return _client;
}

export function getRedisConnection(redisUrl: string): ConnectionOptions {
  const parsed = new URL(redisUrl);
  return {
    host:     parsed.hostname,
    port:     parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

export async function connectRedis(redisUrl: string): Promise<void> {
  _client = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  });
  _client.on('error', (err) => {
    logger.error('Redis error', {
      message: err.message.replace(/(?<=:\/\/[^:]*:)[^@]+(?=@)/g, '[REDACTED]'),
    });
  });
  await _client.connect();
  logger.info('Redis connected');
}
