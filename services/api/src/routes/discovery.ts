// ============================================================
// Job Discovery API Routes
//
// POST /api/v1/discovery/trigger     — Manual run for current user
// GET  /api/v1/discovery/status      — Queue status
// GET  /api/v1/discovery/jobs        — Paginated job listings
// GET  /api/v1/discovery/jobs/:id    — Single job detail
// GET  /api/v1/discovery/stats       — Counts by platform / remote / type
// ============================================================

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { randomUUID } from 'crypto';
// ScraperConfig inlined to avoid cross-service import dependency
interface ScraperConfig {
  userId: string;
  platforms: string[];
  keywords: string[];
  location?: string;
  remote?: boolean;
  maxResultsPerPlatform?: number;
}

export const discoveryRouter = Router();
const prisma = new PrismaClient();

import { getQueueOrDirect } from '../lib/queues.js';
const discoveryQueue = getQueueOrDirect('job-discovery-queue');

// ── POST /trigger — manually kick off discovery ───────────────
discoveryRouter.post('/trigger', async (req, res, next) => {
  try {
    const userId = req.user!.id;

    // Load user preferences
    const prefs = await prisma.jobPreference.findUnique({ where: { userId } });
    if (!prefs) {
      return res.status(400).json({
        success: false,
        error: 'No job preferences found. Set your target roles first.',
      });
    }

    const keywords  = (prefs.targetRoles as string[]) ?? [];
    const locations = (prefs.preferredLocations as string[]) ?? ['Remote'];

    if (keywords.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Add at least one target role to your job preferences.',
      });
    }

    const config: ScraperConfig = {
      userId,
      keywords:  keywords.slice(0, 5),
      locations: locations.slice(0, 3),
      experienceLevel: 'unknown',
      jobTypes:  ['full_time'],
      remoteOnly: prefs.remoteOnly ?? false,
      excludedCompanies: (prefs.excludedCompanies as string[]) ?? [],
      salaryMin:  prefs.salaryMin as number ?? null,
      platforms:  ['linkedin', 'indeed', 'naukri', 'wellfound', 'company_page'],
      maxResultsPerPlatform: 50,
    };

    const runId = randomUUID();
    const jobs  = await Promise.all(
      config.platforms.map(platform =>
        discoveryQueue.add('discover', { userId, platform, config, runId }, {
          priority:         1,
          attempts:         2,
          removeOnComplete: { count: 100 },
        })
      )
    );

    return res.json({
      success: true,
      data: {
        runId,
        message:   `Discovery triggered across ${config.platforms.length} platforms`,
        platforms: config.platforms,
        queueJobIds: jobs.map(j => j.id),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /jobs — paginated job listings ────────────────────────
const JobsQuerySchema = z.object({
  page:     z.coerce.number().min(1).default(1),
  limit:    z.coerce.number().min(1).max(100).default(20),
  platform: z.string().optional(),
  remote:   z.enum(['remote','hybrid','onsite']).optional(),
  jobType:  z.string().optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  keyword:  z.string().optional(),
});

discoveryRouter.get('/jobs', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const query  = JobsQuerySchema.parse(req.query);
    const skip   = (query.page - 1) * query.limit;

    const where: Record<string, unknown> = { isActive: true };

    if (query.platform) where['sourcePlatform'] = query.platform.toUpperCase();
    if (query.remote)   where['remoteType']     = query.remote.toUpperCase();
    if (query.jobType)  where['jobType']         = query.jobType.toUpperCase();
    if (query.keyword)  where['OR'] = [
      { jobTitle: { contains: query.keyword, mode: 'insensitive' } },
      { company:  { contains: query.keyword, mode: 'insensitive' } },
    ];

    const [total, jobs] = await Promise.all([
      prisma.jobListing.count({ where }),
      prisma.jobListing.findMany({
        where,
        skip,
        take:    query.limit,
        orderBy: { postedAt: 'desc' },
        select: {
          id: true, jobTitle: true, company: true, sourcePlatform: true,
          location: true, remoteType: true, jobType: true,
          salaryRaw: true, salaryMin: true, salaryMax: true, salaryCurrency: true,
          experienceLevel: true, companyLogoUrl: true,
          postedAt: true, scrapedAt: true, sourceUrl: true,
          // Include AI match score for this user if available
          jobMatches: {
            where: { userId },
            select: { matchScore: true, recommendation: true },
            take: 1,
          },
        },
      }),
    ]);

    return res.json({
      success: true,
      data: {
        jobs: jobs.map(j => ({
          ...j,
          matchScore:     j.jobMatches[0]?.matchScore ?? null,
          recommendation: j.jobMatches[0]?.recommendation ?? null,
          jobMatches:     undefined,
        })),
        pagination: {
          total, page: query.page, limit: query.limit,
          totalPages: Math.ceil(total / query.limit),
          hasNext: skip + query.limit < total,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /jobs/:id — single job ────────────────────────────────
discoveryRouter.get('/jobs/:id', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const job    = await prisma.jobListing.findUnique({
      where:  { id: req.params!['id'] },
      include: {
        jobMatches: {
          where:  { userId },
          select: { matchScore: true, recommendation: true, strengthAreas: true, missingSkills: true },
        },
      },
    });

    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    return res.json({ success: true, data: { ...job, matchData: job.jobMatches[0] ?? null } });
  } catch (err) {
    next(err);
  }
});

// ── GET /stats — platform and type breakdown ──────────────────
discoveryRouter.get('/stats', async (req, res, next) => {
  try {
    const [byPlatform, byRemote, byType, total, recentCount] = await Promise.all([
      prisma.jobListing.groupBy({
        by: ['sourcePlatform'],
        where: { isActive: true },
        _count: { id: true },
      }),
      prisma.jobListing.groupBy({
        by: ['remoteType'],
        where: { isActive: true },
        _count: { id: true },
      }),
      prisma.jobListing.groupBy({
        by: ['jobType'],
        where: { isActive: true },
        _count: { id: true },
      }),
      prisma.jobListing.count({ where: { isActive: true } }),
      prisma.jobListing.count({
        where: {
          isActive: true,
          scrapedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    return res.json({
      success: true,
      data: {
        total, last24h: recentCount,
        byPlatform: Object.fromEntries(byPlatform.map(r => [r.sourcePlatform.toLowerCase(), r._count.id])),
        byRemote:   Object.fromEntries(byRemote.map(r   => [r.remoteType.toLowerCase(),   r._count.id])),
        byType:     Object.fromEntries(byType.map(r     => [r.jobType.toLowerCase(),       r._count.id])),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /status — queue health ─────────────────────────────────
discoveryRouter.get('/status', async (_req, res, next) => {
  try {
    const counts = await discoveryQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    return res.json({ success: true, data: { queue: 'job-discovery-queue', counts } });
  } catch (err) {
    next(err);
  }
});
