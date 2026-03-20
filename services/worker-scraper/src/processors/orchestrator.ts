// ============================================================
// Discovery Orchestrator
// Coordinates the full pipeline for a single discovery run:
//   Scraper → Normaliser → Deduplication → DB Persist → Queue AI Match
//
// One orchestrator run = one platform × one user.
// Multiple runs fan out in parallel across platforms via BullMQ.
// ============================================================

import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import type { ScraperConfig, ScrapeRunResult, JobPlatform } from '../types/scraperTypes.js';
import { LinkedInScraper }     from '../scrapers/linkedinScraper.js';
import { IndeedScraper }       from '../scrapers/indeedScraper.js';
import { NaukriScraper }       from '../scrapers/naukriScraper.js';
import { WellfoundScraper }    from '../scrapers/wellfoundScraper.js';
import { CompanyPageScraper, type CompanyCareerPage } from '../scrapers/companyPageScraper.js';
import { normalise }           from '../normalizer/jobNormalizer.js';
import { DeduplicationEngine } from '../deduplication/deduplication.js';
import { logger }              from '../utils/logger.js';

// ── Default company career pages to always scan ───────────────
const DEFAULT_COMPANY_PAGES: CompanyCareerPage[] = [
  { company: 'Stripe',      url: 'https://boards.greenhouse.io/stripe',      ats: 'greenhouse' },
  { company: 'Airbnb',      url: 'https://boards.greenhouse.io/airbnb',      ats: 'greenhouse' },
  { company: 'Notion',      url: 'https://boards.greenhouse.io/notion',      ats: 'greenhouse' },
  { company: 'Linear',      url: 'https://jobs.ashbyhq.com/linear',          ats: 'ashby' },
  { company: 'Vercel',      url: 'https://jobs.ashbyhq.com/vercel',          ats: 'ashby' },
  { company: 'Figma',       url: 'https://jobs.lever.co/figma',              ats: 'lever' },
  { company: 'Loom',        url: 'https://jobs.lever.co/loom',               ats: 'lever' },
  { company: 'Shopify',     url: 'https://www.shopify.com/careers/search',   ats: 'generic' },
  { company: 'GitHub',      url: 'https://jobs.github.com',                  ats: 'generic' },
  { company: 'HashiCorp',   url: 'https://www.hashicorp.com/jobs',           ats: 'generic' },
  { company: 'PlanetScale', url: 'https://jobs.lever.co/planetscale',        ats: 'lever' },
  { company: 'Railway',     url: 'https://jobs.ashbyhq.com/railway',         ats: 'ashby' },
];

// ── Scraper registry ──────────────────────────────────────────
function buildScraper(platform: JobPlatform, companyPages: CompanyCareerPage[]) {
  switch (platform) {
    case 'linkedin':     return new LinkedInScraper();
    case 'indeed':       return new IndeedScraper();
    case 'naukri':       return new NaukriScraper();
    case 'wellfound':    return new WellfoundScraper();
    case 'company_page': return new CompanyPageScraper(companyPages);
    default:             return null;
  }
}

export class DiscoveryOrchestrator {
  private readonly dedup:     DeduplicationEngine;
  private readonly matchQueue: Queue;

  constructor(
    private readonly prisma:    PrismaClient,
    private readonly redis:     Redis,
    private readonly companyPages: CompanyCareerPage[] = DEFAULT_COMPANY_PAGES,
  ) {
    this.dedup = new DeduplicationEngine(redis, prisma);

    this.matchQueue = new Queue('ai-match-queue', {
      connection: {
        host: process.env['REDIS_HOST'] ?? 'localhost',
        port: parseInt(process.env['REDIS_PORT'] ?? '6379'),
      },
      prefix: process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
    });
  }

  // ── Run discovery for one platform + one user ─────────────
  async run(config: ScraperConfig, platform: JobPlatform): Promise<ScrapeRunResult> {
    const startMs = Date.now();
    const result: ScrapeRunResult = {
      userId: config.userId, platform,
      jobsFound: 0, jobsNew: 0, jobsDuplicate: 0, jobsFailed: 0,
      durationMs: 0, errors: [], ranAt: new Date(),
    };

    const scraper = buildScraper(platform, this.companyPages);
    if (!scraper) {
      result.errors.push(`No scraper registered for platform: ${platform}`);
      return result;
    }

    logger.info('Discovery run starting', { userId: config.userId, platform });

    try {
      for await (const rawJob of scraper.scrape(config)) {
        result.jobsFound++;

        try {
          // Normalise raw job to canonical format
          const job = normalise(rawJob);

          // Layer 1 + 2 deduplication check
          const dup = await this.dedup.isDuplicate(job, config.userId);
          if (dup) {
            result.jobsDuplicate++;
            continue;
          }

          // Layer 3: persist to DB (includes unique constraint guard)
          const { id, isNew } = await this.dedup.persistJob(job);
          if (!isNew) {
            result.jobsDuplicate++;
            continue;
          }

          // Mark in Redis cache
          await this.dedup.markAsSeen(job, config.userId);
          result.jobsNew++;

          // Enqueue AI match scoring for this user × job
          await this.matchQueue.add('score', {
            userId:       config.userId,
            jobListingId: id,
          }, {
            attempts:         3,
            removeOnComplete: { count: 500 },
            removeOnFail:     { count: 100 },
            // Slight delay so DB write is visible to worker
            delay: 500,
          });

          logger.debug('New job found', {
            title:    job.job_title,
            company:  job.company,
            platform: job.platform,
          });

        } catch (err) {
          result.jobsFailed++;
          result.errors.push(`Failed to process job: ${String(err)}`);
          logger.warn('Failed to process job', { error: String(err), rawJob });
        }
      }
    } catch (err) {
      result.errors.push(`Scraper threw: ${String(err)}`);
      logger.error('Scraper error', { platform, userId: config.userId, error: String(err) });
    }

    result.durationMs = Date.now() - startMs;

    logger.info('Discovery run complete', {
      platform,
      userId:    config.userId,
      found:     result.jobsFound,
      new:       result.jobsNew,
      duplicate: result.jobsDuplicate,
      failed:    result.jobsFailed,
      durationMs: result.durationMs,
    });

    return result;
  }

  // ── Run discovery across all platforms for a user ─────────
  async runAll(config: ScraperConfig): Promise<ScrapeRunResult[]> {
    const results: ScrapeRunResult[] = [];

    for (const platform of config.platforms) {
      try {
        const result = await this.run(config, platform);
        results.push(result);
      } catch (err) {
        logger.error('Platform run failed', { platform, error: String(err) });
      }
    }

    const totals = results.reduce((acc, r) => ({
      found: acc.found + r.jobsFound,
      new:   acc.new   + r.jobsNew,
      dup:   acc.dup   + r.jobsDuplicate,
    }), { found: 0, new: 0, dup: 0 });

    logger.info('Full discovery run complete', {
      userId:    config.userId,
      platforms: config.platforms.length,
      ...totals,
    });

    return results;
  }

  async close(): Promise<void> {
    await this.matchQueue.close();
  }
}
