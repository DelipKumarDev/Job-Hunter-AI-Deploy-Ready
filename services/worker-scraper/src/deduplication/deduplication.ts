// ============================================================
// Deduplication Engine — 3-Layer Architecture
//
// Layer 1: Redis SET membership check (~1ms)
//   ↓ (miss)
// Layer 2: PostgreSQL content_hash lookup (~10ms)
//   ↓ (miss)
// Layer 3: Database INSERT with UNIQUE constraint (final guard)
//
// Also handles: expired jobs cleanup, stat tracking
// ============================================================

import type { Redis } from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import type { NormalisedJob } from '../types/scraperTypes.js';
import { logger } from '../utils/logger.js';

// Redis key for the job hash set
// We use a rolling window: separate key per day so old hashes auto-expire
const redisKey = (userId: string) => {
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `dedup:jobs:${userId}:${yyyymmdd}`;
};
const REDIS_TTL_SECS = 60 * 60 * 24 * 14; // 14 days

export interface DeduplicationResult {
  isNew:      boolean;
  reason?:    'redis_hit' | 'db_hit' | 'unique_constraint';
}

export class DeduplicationEngine {
  constructor(
    private readonly redis: Redis,
    private readonly prisma: PrismaClient,
  ) {}

  // ── Check if job is a duplicate ──────────────────────────
  async isDuplicate(job: NormalisedJob, userId: string): Promise<boolean> {
    const hash = job.content_hash;
    const key  = redisKey(userId);

    // Layer 1: Redis O(1) set membership
    const inRedis = await this.redis.sismember(key, hash);
    if (inRedis) {
      logger.debug('Dedup: Redis hit', { hash: hash.slice(0, 12), title: job.job_title });
      return true;
    }

    // Layer 2: PostgreSQL lookup
    const exists = await this.prisma.jobListing.findFirst({
      where: { contentHash: hash },
      select: { id: true },
    });

    if (exists) {
      // Warm Redis cache for next time
      await this.redis.sadd(key, hash);
      await this.redis.expire(key, REDIS_TTL_SECS);
      logger.debug('Dedup: DB hit', { hash: hash.slice(0, 12), title: job.job_title });
      return true;
    }

    return false;
  }

  // ── Mark hash as seen (after successful insert) ──────────
  async markAsSeen(job: NormalisedJob, userId: string): Promise<void> {
    const key = redisKey(userId);
    await this.redis.sadd(key, job.content_hash);
    await this.redis.expire(key, REDIS_TTL_SECS);
  }

  // ── Persist a new job listing to DB ──────────────────────
  async persistJob(job: NormalisedJob): Promise<{ id: string; isNew: boolean }> {
    try {
      const record = await this.prisma.jobListing.upsert({
        where:  { contentHash: job.content_hash },
        update: {
          isActive:  true,
          scrapedAt: job.scraped_at,
          // Update salary/location if we now have better data
          ...(job.salary.raw     && { salaryRaw:  job.salary.raw     }),
          ...(job.salary.min     && { salaryMin:  job.salary.min     }),
          ...(job.salary.max     && { salaryMax:  job.salary.max     }),
          ...(job.location       && { location:   job.location       }),
          ...(job.description    && { description: job.description   }),
        },
        create: {
          jobTitle:        job.job_title,
          company:         job.company,
          sourcePlatform:  job.platform.toUpperCase() as 'LINKEDIN' | 'INDEED' | 'NAUKRI' | 'WELLFOUND' | 'COMPANY_PAGE' | 'UNKNOWN',
          sourceUrl:       job.apply_link,
          sourceJobId:     job.source_job_id,
          contentHash:     job.content_hash,

          location:        job.location,
          city:            job.city,
          country:         job.country,
          remoteType:      job.remote_type.toUpperCase() as 'REMOTE' | 'HYBRID' | 'ONSITE' | 'UNKNOWN',

          description:     job.description,
          requirements:    job.requirements,
          jobType:         job.job_type.toUpperCase() as 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'INTERNSHIP' | 'FREELANCE' | 'UNKNOWN',
          experienceLevel: job.experience_level.toUpperCase() as 'ENTRY' | 'MID' | 'SENIOR' | 'LEAD' | 'EXECUTIVE' | 'UNKNOWN',

          salaryRaw:       job.salary.raw,
          salaryMin:       job.salary.min,
          salaryMax:       job.salary.max,
          salaryCurrency:  job.salary.currency,
          salaryPeriod:    job.salary.period.toUpperCase() as 'ANNUAL' | 'MONTHLY' | 'HOURLY' | 'UNKNOWN',
          salaryEstimated: job.salary.is_estimated,

          companyLogoUrl:  job.company_logo_url,
          postedAt:        job.posted_at,
          scrapedAt:       job.scraped_at,
          isActive:        true,
        },
        select: { id: true },
      });

      return { id: record.id, isNew: true };

    } catch (err: unknown) {
      // Handle unique constraint violation (race condition)
      if (
        typeof err === 'object' && err !== null &&
        'code' in err && (err as { code: string }).code === 'P2002'
      ) {
        logger.debug('Dedup: unique constraint (race condition)', { hash: job.content_hash.slice(0, 12) });
        return { id: '', isNew: false };
      }
      throw err;
    }
  }

  // ── Clean up old / inactive listings ─────────────────────
  async pruneStaleJobs(olderThanDays = 60): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const result = await this.prisma.jobListing.updateMany({
      where:  { scrapedAt: { lt: cutoff }, isActive: true },
      data:   { isActive: false },
    });

    if (result.count > 0) {
      logger.info('Pruned stale job listings', { count: result.count, olderThanDays });
    }
    return result.count;
  }

  // ── Get dedup stats for a user ────────────────────────────
  async getStats(userId: string): Promise<{
    redisKeys: number;
    dbTotal:   number;
    activeJobs: number;
  }> {
    const key       = redisKey(userId);
    const redisKeys = await this.redis.scard(key);
    const dbTotal   = await this.prisma.jobListing.count();
    const activeJobs= await this.prisma.jobListing.count({ where: { isActive: true } });
    return { redisKeys, dbTotal, activeJobs };
  }
}
