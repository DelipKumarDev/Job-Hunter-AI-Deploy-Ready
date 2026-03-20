// ============================================================
// Match Score Cache (Redis)
// Caches computed match scores to avoid recomputing for the
// same user+job pair. 24h TTL — refreshes if job is updated.
// ============================================================

import type Redis from 'ioredis';
import type { MatchAnalysis } from '../types.js';
import { logger } from '../utils/logger.js';

// Cache TTL: 24 hours
const CACHE_TTL_SECONDS = 86400;

// Key format: match:v2:{userId}:{jobId}
// Version prefix allows cache busting when scoring logic changes
const KEY_VERSION = 'v2';

export class MatchScoreCache {
  constructor(private readonly redis: Redis) {}

  private key(userId: string, jobId: string): string {
    return `match:${KEY_VERSION}:${userId}:${jobId}`;
  }

  async get(userId: string, jobId: string): Promise<MatchAnalysis | null> {
    try {
      const raw = await this.redis.get(this.key(userId, jobId));
      if (!raw) return null;
      return JSON.parse(raw) as MatchAnalysis;
    } catch {
      return null;
    }
  }

  async set(userId: string, jobId: string, analysis: MatchAnalysis): Promise<void> {
    try {
      await this.redis.setex(
        this.key(userId, jobId),
        CACHE_TTL_SECONDS,
        JSON.stringify(analysis),
      );
    } catch (err) {
      logger.warn('Failed to cache match score', { userId, jobId, error: String(err) });
    }
  }

  async invalidate(userId: string, jobId: string): Promise<void> {
    try {
      await this.redis.del(this.key(userId, jobId));
    } catch {
      // Non-critical
    }
  }

  async invalidateAllForUser(userId: string): Promise<void> {
    try {
      // Find all match cache keys for this user
      const pattern = `match:${KEY_VERSION}:${userId}:*`;
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(...keys);
        logger.debug(`Invalidated ${keys.length} cached scores for user ${userId}`);
      }
    } catch (err) {
      logger.warn('Failed to invalidate user cache', { userId, error: String(err) });
    }
  }

  async exists(userId: string, jobId: string): Promise<boolean> {
    try {
      const result = await this.redis.exists(this.key(userId, jobId));
      return result === 1;
    } catch {
      return false;
    }
  }

  // Warm cache — check multiple jobs at once
  async mget(userId: string, jobIds: string[]): Promise<Map<string, MatchAnalysis>> {
    const result = new Map<string, MatchAnalysis>();
    if (jobIds.length === 0) return result;

    try {
      const keys = jobIds.map(id => this.key(userId, id));
      const values = await this.redis.mget(...keys);

      values.forEach((val, idx) => {
        if (val) {
          try {
            result.set(jobIds[idx]!, JSON.parse(val) as MatchAnalysis);
          } catch {
            // Skip malformed cache entries
          }
        }
      });
    } catch (err) {
      logger.warn('Batch cache get failed', { error: String(err) });
    }

    return result;
  }

  // Stats for monitoring
  async getCacheHitStats(): Promise<{ cachedCount: number }> {
    try {
      const keys = await this.redis.keys(`match:${KEY_VERSION}:*`);
      return { cachedCount: keys.length };
    } catch {
      return { cachedCount: 0 };
    }
  }
}
