// ============================================================
// Job Discovery Scheduler
// Cron-driven scheduler that fans out discovery runs for all
// active users across all configured platforms.
//
// Schedule (configurable via env):
//   Discovery:  every 2 hours   → 0 */2 * * *
//   Cleanup:    every day 3am   → 0 3 * * *
//   Stats:      every 6 hours   → 0 */6 * * *
//
// Anti-detection: stagger user start times by 0–20 min random
// so all users don't hit job boards simultaneously.
// ============================================================

import { CronJob } from 'cron';
import { jobAddOptions, QUEUE_NAMES } from '@job-hunter/shared';
import { Queue } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { ScraperConfig, JobPlatform, JobType, ExperienceLevel } from '../types/scraperTypes.js';
import { DeduplicationEngine } from '../deduplication/deduplication.js';
import { getRedisConnection, getRedis } from '../utils/redis.js';
import { logger } from '../utils/logger.js';

const DEFAULT_PLATFORMS: JobPlatform[] = ['linkedin', 'indeed', 'naukri', 'wellfound', 'company_page'];
const MAX_RESULTS_PER_PLATFORM = 50;

export class DiscoveryScheduler {
  private readonly discoveryQueue: Queue;
  private jobs: CronJob[] = [];

  constructor(private readonly prisma: PrismaClient) {
    this.discoveryQueue = new Queue('job-discovery-queue', {
      connection: getRedisConnection(),
      prefix:     process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
    });
  }

  start(): void {
    // ── 1. Discovery: every 2 hours ───────────────────────
    const discoveryCron = process.env['DISCOVERY_CRON'] ?? '0 */2 * * *';
    this.jobs.push(
      new CronJob(discoveryCron, () => {
        this.runDiscovery().catch(err =>
          logger.error('Discovery cron error', { error: String(err) })
        );
      }, null, true, 'UTC')
    );

    // ── 2. Stale job cleanup: daily at 3am UTC ─────────────
    this.jobs.push(
      new CronJob('0 3 * * *', () => {
        this.runCleanup().catch(err =>
          logger.error('Cleanup cron error', { error: String(err) })
        );
      }, null, true, 'UTC')
    );

    // ── 3. Stats log: every 6 hours ───────────────────────
    this.jobs.push(
      new CronJob('0 */6 * * *', () => {
        this.logStats().catch(err =>
          logger.error('Stats cron error', { error: String(err) })
        );
      }, null, true, 'UTC')
    );

    logger.info('Discovery scheduler started', {
      discoveryCron,
      cleanup: '0 3 * * *',
      stats:   '0 */6 * * *',
    });
  }

  // ── Fan out discovery jobs for all active users ────────────
  async runDiscovery(): Promise<void> {
    const runId = randomUUID();
    logger.info('Discovery run starting', { runId });

    // Load all users with auto_apply_enabled or active subscriptions
    const users = await this.prisma.user.findMany({
      where: { isActive: true },
      select: {
        id:            true,
        jobPreference: {
          select: {
            targetRoles:       true,
            preferredLocations: true,
            jobType:           true,
            remoteOnly:        true,
            excludedCompanies: true,
            salaryMin:         true,
            autoApplyEnabled:  true,
          },
        },
        profiles: {
          select: { seniorityLevel: true },
        },
      },
    });

    logger.info(`Scheduling discovery for ${users.length} users`);

    for (let i = 0; i < users.length; i++) {
      const user = users[i]!;
      if (!user.jobPreference) continue;

      const pref = user.jobPreference;
      const keywords = (pref.targetRoles as string[]) ?? [];
      const locations = (pref.preferredLocations as string[]) ?? ['Remote'];

      if (keywords.length === 0) {
        logger.debug('User has no target roles, skipping', { userId: user.id });
        continue;
      }

      const config: ScraperConfig = {
        userId:               user.id,
        keywords:             keywords.slice(0, 5),  // Max 5 keywords
        locations:            locations.slice(0, 3), // Max 3 locations
        experienceLevel:      (user.profiles?.seniorityLevel ?? 'unknown') as ExperienceLevel,
        jobTypes:             [(pref.jobType ?? 'full_time') as JobType],
        remoteOnly:           pref.remoteOnly ?? false,
        excludedCompanies:    (pref.excludedCompanies as string[]) ?? [],
        salaryMin:            pref.salaryMin as number | null ?? null,
        platforms:            DEFAULT_PLATFORMS,
        maxResultsPerPlatform: MAX_RESULTS_PER_PLATFORM,
      };

      // Stagger: 0–20 min random delay per user (anti-detection)
      const staggerMs = Math.floor(Math.random() * 20 * 60 * 1000); // 0–20 min in ms

      for (const platform of config.platforms) {
        await this.discoveryQueue.add(
          'discover',
          { userId: user.id, platform, config, runId } satisfies import('../types/scraperTypes.js').DiscoveryQueuePayload,
          jobAddOptions(QUEUE_NAMES.JOB_DISCOVERY, {
            delay: staggerMs + platformOffset(platform),
          }),
        );
      }

      logger.debug('Discovery queued for user', {
        userId:   user.id,
        keywords: keywords.slice(0, 2),
        staggerMs,
        platforms: config.platforms.length,
      });
    }

    logger.info('Discovery run enqueued', { runId, userCount: users.length });
  }

  // ── Cleanup stale job listings ─────────────────────────────
  async runCleanup(): Promise<void> {
    logger.info('Running stale job cleanup');
    const dedup = new DeduplicationEngine(getRedis(), this.prisma);
    const pruned = await dedup.pruneStaleJobs(60);
    logger.info('Cleanup complete', { prunedCount: pruned });
  }

  // ── Log stats ─────────────────────────────────────────────
  async logStats(): Promise<void> {
    const [totalJobs, activeJobs, queuedJobs] = await Promise.all([
      this.prisma.jobListing.count(),
      this.prisma.jobListing.count({ where: { isActive: true } }),
      this.discoveryQueue.getJobCounts('waiting', 'active', 'delayed'),
    ]);

    logger.info('Discovery stats', {
      db: { totalJobs, activeJobs },
      queue: queuedJobs,
    });
  }

  // ── Trigger immediate discovery for a single user ──────────
  async triggerForUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: {
        id: true,
        jobPreference: {
          select: {
            targetRoles: true, preferredLocations: true,
            jobType: true, remoteOnly: true, excludedCompanies: true, salaryMin: true,
          },
        },
        profiles: { select: { seniorityLevel: true } },
      },
    });

    if (!user?.jobPreference) {
      throw new Error(`User ${userId} has no job preferences configured`);
    }

    const pref = user.jobPreference;
    const config: ScraperConfig = {
      userId,
      keywords:    (pref.targetRoles as string[])       ?? [],
      locations:   (pref.preferredLocations as string[]) ?? ['Remote'],
      experienceLevel: (user.profiles?.seniorityLevel ?? 'unknown') as ExperienceLevel,
      jobTypes:    [(pref.jobType ?? 'full_time') as JobType],
      remoteOnly:  pref.remoteOnly ?? false,
      excludedCompanies: (pref.excludedCompanies as string[]) ?? [],
      salaryMin:   pref.salaryMin as number | null ?? null,
      platforms:   DEFAULT_PLATFORMS,
      maxResultsPerPlatform: MAX_RESULTS_PER_PLATFORM,
    };

    const runId = randomUUID();
    for (const platform of config.platforms) {
      await this.discoveryQueue.add(
        'discover',
        { userId, platform, config, runId },
        jobAddOptions(QUEUE_NAMES.JOB_DISCOVERY, { priority: 1 }),
      );
    }

    logger.info('Manual discovery triggered', { userId, runId, platforms: config.platforms });
  }

  stop(): void {
    this.jobs.forEach(j => j.stop());
    this.jobs = [];
    logger.info('Discovery scheduler stopped');
  }

  async close(): Promise<void> {
    this.stop();
    await this.discoveryQueue.close();
  }
}

// Offset platforms so they don't all fire at t=0
function platformOffset(platform: JobPlatform): number {
  const offsets: Record<string, number> = {
    linkedin:     0,
    indeed:       90_000,   // +1.5 min
    naukri:       180_000,  // +3 min
    wellfound:    270_000,  // +4.5 min
    company_page: 360_000,  // +6 min
  };
  return offsets[platform] ?? 0;
}
