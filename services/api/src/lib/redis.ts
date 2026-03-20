/**
 * ============================================================
 * Redis — IORedis client with connection management
 *
 * connectRedis() and getRedisConnection() accept the URL
 * explicitly from the secrets object, never from process.env.
 * ============================================================
 */

import Redis from 'ioredis';
import type { ConnectionOptions } from 'bullmq';
import { logger } from './logger.js';

let redisClient: Redis | null = null;

export function getRedis(): Redis {
  if (!redisClient) throw new Error('[redis] getRedis() called before connectRedis()');
  return redisClient;
}

/**
 * Parse a Redis URL into BullMQ ConnectionOptions.
 * The password is extracted from the URL and passed directly —
 * it is never written to any log.
 */
export function getRedisConnection(redisUrl: string): ConnectionOptions {
  if (!redisUrl) throw new Error('[redis] redisUrl must be non-empty');
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
  if (!redisUrl) throw new Error('[redis] redisUrl must be non-empty');

  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      logger.warn('Redis reconnecting', { attempt: times, delayMs: delay });
      return delay;
    },
  });

  redisClient.on('error', (err) => {
    // Sanitize: the error may contain the URL (with password) in some ioredis versions
    logger.error('Redis client error', {
      message: err.message.replace(/(?<=:\/\/[^:]*:)[^@]+(?=@)/g, '[REDACTED]'),
    });
  });

  redisClient.on('reconnecting', () => logger.warn('Redis reconnecting…'));

  await redisClient.connect();
  await redisClient.ping();
}

// ── Cache helpers (unchanged API) ────────────────────────────
const DEFAULT_TTL = 3600;

export async function cacheGet<T>(key: string): Promise<T | null> {
  const value = await getRedis().get(key);
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = DEFAULT_TTL): Promise<void> {
  await getRedis().setex(key, ttlSeconds, JSON.stringify(value));
}

export async function cacheDelete(key: string): Promise<void> {
  await getRedis().del(key);
}

export async function cacheClear(pattern: string): Promise<void> {
  const keys = await getRedis().keys(pattern);
  if (keys.length > 0) await getRedis().del(...keys);
}

export const CacheKeys = {
  jobMatch:      (userId: string, jobId: string) => `match:${userId}:${jobId}`,
  userProfile:   (userId: string)               => `profile:${userId}`,
  jobListing:    (jobId: string)                => `job:${jobId}`,
  userJobs:      (userId: string)               => `user-jobs:${userId}`,
  notifications: (userId: string)               => `notifs:${userId}`,
} as const;
