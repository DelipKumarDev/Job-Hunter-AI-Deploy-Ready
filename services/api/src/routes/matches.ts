// ============================================================
// Match API Routes — /api/v1/jobs/matches/*
// Exposes match scores to the frontend and allows
// manual re-scoring, threshold configuration, and analytics.
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { getRedis } from '../lib/redis.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { Queues } from '../lib/queues.js';

export const matchRouter = Router();
const prisma = new PrismaClient();

// ── GET /api/v1/jobs/matches — Top matches for user ────────
matchRouter.get('/', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const page = parseInt(String(req.query['page'] ?? '1'), 10);
    const limit = Math.min(parseInt(String(req.query['limit'] ?? '20'), 10), 100);
    const minScore = parseInt(String(req.query['minScore'] ?? '0'), 10);
    const recommendation = req.query['recommendation'] as string | undefined;

    const where: Record<string, unknown> = {
      userId,
      matchScore: { gte: minScore },
    };
    if (recommendation && ['YES', 'MAYBE', 'NO'].includes(recommendation)) {
      where['recommendation'] = recommendation;
    }

    const [total, matches] = await Promise.all([
      prisma.jobMatch.count({ where }),
      prisma.jobMatch.findMany({
        where,
        include: {
          jobListing: {
            select: {
              title: true,
              company: true,
              location: true,
              remoteType: true,
              jobType: true,
              salaryMin: true,
              salaryMax: true,
              salaryCurrency: true,
              sourcePlatform: true,
              sourceUrl: true,
              postedAt: true,
              companyLogoUrl: true,
            },
          },
        },
        orderBy: { matchScore: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    res.json({
      success: true,
      data: {
        matches: matches.map(m => ({
          matchId: m.id,
          jobId: m.jobListingId,
          job: m.jobListing,
          score: {
            total: m.matchScore,
            skills: m.skillsScore,
            experience: m.experienceScore,
            location: m.locationScore,
            salary: m.salaryScore,
          },
          recommendation: m.recommendation,
          missingSkills: m.missingSkills,
          strengthAreas: m.strengthAreas,
          summary: m.summary,
          scoredAt: m.scoredAt,
        })),
      },
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/jobs/matches/:jobId — Single match detail ──
matchRouter.get('/:jobId', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { jobId } = req.params as { jobId: string };

    const match = await prisma.jobMatch.findUnique({
      where: { userId_jobListingId: { userId, jobListingId: jobId } },
      include: {
        jobListing: true,
      },
    });

    if (!match) {
      throw new AppError('Match score not found', 404, 'NOT_FOUND');
    }

    res.json({
      success: true,
      data: {
        matchId: match.id,
        jobId: match.jobListingId,
        job: match.jobListing,
        score: {
          total: match.matchScore,
          breakdown: [
            { dimension: 'Skills Match',      weight: 40, raw: match.skillsScore,     weighted: (match.skillsScore ?? 0) * 0.4 },
            { dimension: 'Experience',         weight: 30, raw: match.experienceScore, weighted: (match.experienceScore ?? 0) * 0.3 },
            { dimension: 'Location Fit',       weight: 20, raw: match.locationScore,   weighted: (match.locationScore ?? 0) * 0.2 },
            { dimension: 'Salary Alignment',   weight: 10, raw: match.salaryScore,     weighted: (match.salaryScore ?? 0) * 0.1 },
          ],
        },
        recommendation: match.recommendation,
        missingSkills: match.missingSkills,
        strengthAreas: match.strengthAreas,
        summary: match.summary,
        tokensUsed: match.tokensUsed,
        scoredAt: match.scoredAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/jobs/matches/:jobId/rescore — Force rescore ─
matchRouter.post('/:jobId/rescore', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { jobId } = req.params as { jobId: string };

    // Verify job exists
    const job = await prisma.jobListing.findUnique({
      where: { id: jobId },
      select: { id: true, title: true, company: true },
    });
    if (!job) throw new AppError('Job not found', 404, 'NOT_FOUND');

    // Enqueue high-priority rescore
    const queueJob = await Queues.enqueueAiMatch({
      userId,
      jobListingId: jobId,
      forceRescore: true,
    });

    res.json({
      success: true,
      data: {
        message: `Rescoring ${job.title} at ${job.company}`,
        queueJobId: queueJob.id,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/jobs/matches/analytics/funnel ─────────────
matchRouter.get('/analytics/funnel', async (req, res, next) => {
  try {
    const userId = req.user!.id;

    const matches = await prisma.jobMatch.findMany({
      where: { userId },
      select: {
        matchScore: true,
        recommendation: true,
        skillsScore: true,
        experienceScore: true,
        locationScore: true,
        salaryScore: true,
      },
    });

    const prefs = await prisma.jobPreference.findUnique({
      where: { userId },
      select: { minMatchScore: true },
    });
    const threshold = prefs?.minMatchScore ?? 75;

    const total = matches.length;
    const avg = total > 0
      ? Math.round(matches.reduce((s, m) => s + m.matchScore, 0) / total)
      : 0;

    res.json({
      success: true,
      data: {
        totalScored: total,
        avgScore: avg,
        threshold,
        distribution: {
          excellent: matches.filter(m => m.matchScore >= 90).length,
          strong: matches.filter(m => m.matchScore >= 75 && m.matchScore < 90).length,
          good: matches.filter(m => m.matchScore >= 60 && m.matchScore < 75).length,
          partial: matches.filter(m => m.matchScore >= 45 && m.matchScore < 60).length,
          weak: matches.filter(m => m.matchScore >= 30 && m.matchScore < 45).length,
          poor: matches.filter(m => m.matchScore < 30).length,
        },
        byRecommendation: {
          yes: matches.filter(m => m.recommendation === 'YES').length,
          maybe: matches.filter(m => m.recommendation === 'MAYBE').length,
          no: matches.filter(m => m.recommendation === 'NO').length,
        },
        qualified: matches.filter(m => m.matchScore >= threshold).length,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── PUT /api/v1/jobs/matches/threshold ────────────────────
const ThresholdSchema = z.object({
  body: z.object({
    minMatchScore: z.number().int().min(0).max(100),
  }),
});

matchRouter.put('/threshold', validate(ThresholdSchema), async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { minMatchScore } = req.body as { minMatchScore: number };

    await prisma.jobPreference.update({
      where: { userId },
      data: { minMatchScore },
    });

    res.json({
      success: true,
      data: {
        message: `Match threshold updated to ${minMatchScore}`,
        minMatchScore,
      },
    });
  } catch (error) {
    next(error);
  }
});
