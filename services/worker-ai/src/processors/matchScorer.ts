// ============================================================
// Match Scorer — Core Scoring Engine
// Orchestrates the full pipeline:
//   1. Load candidate profile (Redis cache → DB)
//   2. Check existing score (Redis cache → DB)
//   3. Call Claude API with structured prompt
//   4. Validate + compute weighted score
//   5. Persist to PostgreSQL job_matches table
//   6. Cache result in Redis
//   7. Trigger auto-apply queue if above threshold
// ============================================================

import { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type {
  AiMatchPayload,
  MatchAnalysis,
  JobListingForMatch,
  BatchMatchRequest,
  BatchMatchResult,
} from '../types.js';
import { DEFAULT_THRESHOLDS } from '../types.js';
import { ProfileLoader } from './profileLoader.js';
import { MatchScoreCache } from '../cache/matchScoreCache.js';
import { callClaudeForJson, selectModel, trackCost } from '../utils/claudeClient.js';
import {
  MATCH_SYSTEM_PROMPT,
  buildMatchPrompt,
} from '../prompts/matchPrompts.js';
import {
  validateClaudeOutput,
  buildMatchAnalysis,
  computeWeightedScore,
} from '../scorers/scoreValidator.js';
import { logger } from '../utils/logger.js';
import pLimit from 'p-limit';

export class MatchScorer {
  private profileLoader: ProfileLoader;
  private scoreCache: MatchScoreCache;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
  ) {
    this.profileLoader = new ProfileLoader(prisma, redis);
    this.scoreCache = new MatchScoreCache(redis);
  }

  // ── Score a single job for one user ───────────────────────
  async scoreOne(payload: AiMatchPayload): Promise<MatchAnalysis> {
    const { userId, jobListingId, forceRescore = false } = payload;

    // ── Step 1: Check existing score (cache → DB) ──────────
    if (!forceRescore) {
      // Check Redis cache
      const cached = await this.scoreCache.get(userId, jobListingId);
      if (cached) {
        logger.debug('Cache hit for match score', { userId, jobListingId });
        return cached;
      }

      // Check DB
      const existing = await this.prisma.jobMatch.findUnique({
        where: { userId_jobListingId: { userId, jobListingId } },
      });

      if (existing) {
        // Reconstruct minimal MatchAnalysis from DB record
        const analysis = this.dbRecordToAnalysis(existing);
        await this.scoreCache.set(userId, jobListingId, analysis);
        return analysis;
      }
    }

    // ── Step 2: Load candidate profile ────────────────────
    const candidate = await this.profileLoader.load(userId);

    if (!candidate.skills || candidate.skills.length === 0) {
      logger.warn('Candidate has no skills — using minimal profile', { userId });
    }

    // ── Step 3: Load job listing ────────────────────────────
    const job = await this.prisma.jobListing.findUnique({
      where: { id: jobListingId },
      select: {
        id: true,
        title: true,
        company: true,
        location: true,
        country: true,
        remoteType: true,
        jobType: true,
        description: true,
        requirements: true,
        salaryMin: true,
        salaryMax: true,
        salaryCurrency: true,
        sourcePlatform: true,
        experienceLevel: true,
      },
    });

    if (!job) {
      throw new Error(`Job listing not found: ${jobListingId}`);
    }

    const jobForMatch: JobListingForMatch = {
      ...job,
      remoteType: job.remoteType ?? null,
      jobType: job.jobType ?? null,
      salaryCurrency: job.salaryCurrency ?? null,
      experienceLevel: job.experienceLevel ?? null,
    };

    // ── Step 4: Build prompt ────────────────────────────────
    const userPrompt = buildMatchPrompt(candidate, jobForMatch);

    logger.debug('Calling Claude for match score', {
      userId,
      jobId: jobListingId,
      jobTitle: job.title,
      company: job.company,
    });

    // ── Step 5: Call Claude ─────────────────────────────────
    const { data: rawOutput, meta } = await callClaudeForJson(
      {
        systemPrompt: MATCH_SYSTEM_PROMPT,
        userPrompt,
        model: selectModel('bulk'),
        maxTokens: 1500,
        temperature: 0.1,
      },
      (parsed) => validateClaudeOutput(parsed),
    );

    trackCost(meta.estimatedCostUsd);

    // ── Step 6: Build full analysis with weighted score ─────
    const analysis = buildMatchAnalysis(
      rawOutput,
      meta.tokensUsed,
      meta.model,
      meta.durationMs,
    );

    logger.info('Match score computed', {
      userId,
      jobId: jobListingId,
      company: job.company,
      title: job.title,
      totalScore: analysis.totalScore,
      recommendation: analysis.recommendation,
      skills: analysis.skillsScore.raw,
      experience: analysis.experienceScore.raw,
      location: analysis.locationScore.raw,
      salary: analysis.salaryScore.raw,
    });

    // ── Step 7: Persist to DB ───────────────────────────────
    await this.persistScore(userId, jobListingId, analysis);

    // ── Step 8: Cache result ────────────────────────────────
    await this.scoreCache.set(userId, jobListingId, analysis);

    // ── Step 9: Trigger auto-apply if above threshold ───────
    const threshold = candidate.preferences?.minMatchScore ?? DEFAULT_THRESHOLDS.autoApply;
    if (analysis.totalScore >= threshold && analysis.recommendation !== 'NO') {
      await this.enqueueForApplication(userId, jobListingId, analysis.totalScore);
    }

    return analysis;
  }

  // ── Batch score multiple jobs for one user ─────────────────
  async scoreBatch(request: BatchMatchRequest): Promise<BatchMatchResult> {
    const startTime = Date.now();
    const { userId, jobIds, forceRescore = false } = request;

    const result: BatchMatchResult = {
      userId,
      processed: 0,
      skipped: 0,
      failed: 0,
      qualifiedForApply: 0,
      totalTokensUsed: 0,
      durationMs: 0,
    };

    // Pre-check which jobs already have scores (bulk check)
    let jobsToProcess = jobIds;
    if (!forceRescore) {
      const cachedScores = await this.scoreCache.mget(userId, jobIds);
      const existingInDb = await this.prisma.jobMatch.findMany({
        where: { userId, jobListingId: { in: jobIds } },
        select: { jobListingId: true },
      });
      const existingIds = new Set([
        ...cachedScores.keys(),
        ...existingInDb.map(r => r.jobListingId),
      ]);
      result.skipped = existingIds.size;
      jobsToProcess = jobIds.filter(id => !existingIds.has(id));
    }

    if (jobsToProcess.length === 0) {
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // Process with concurrency limit (respect API rate limits)
    const concurrency = parseInt(process.env['AI_MATCH_CONCURRENCY'] ?? '5', 10);
    const limit = pLimit(concurrency);

    const tasks = jobsToProcess.map(jobId =>
      limit(async () => {
        try {
          const analysis = await this.scoreOne({ userId, jobListingId: jobId, forceRescore });
          result.processed++;
          result.totalTokensUsed += analysis.tokensUsed;
          if (analysis.totalScore >= DEFAULT_THRESHOLDS.autoApply) {
            result.qualifiedForApply++;
          }
        } catch (err) {
          result.failed++;
          logger.error('Batch score failed for job', {
            userId,
            jobId,
            error: String(err),
          });
        }
      })
    );

    await Promise.allSettled(tasks);
    result.durationMs = Date.now() - startTime;

    logger.info('Batch scoring complete', {
      userId,
      ...result,
    });

    return result;
  }

  // ── Persist score to PostgreSQL ───────────────────────────
  private async persistScore(
    userId: string,
    jobListingId: string,
    analysis: MatchAnalysis,
  ): Promise<void> {
    await this.prisma.jobMatch.upsert({
      where: {
        userId_jobListingId: { userId, jobListingId },
      },
      update: {
        matchScore: analysis.totalScore,
        recommendation: analysis.recommendation,
        skillsScore: analysis.skillsScore.raw,
        experienceScore: analysis.experienceScore.raw,
        locationScore: analysis.locationScore.raw,
        salaryScore: analysis.salaryScore.raw,
        missingSkills: analysis.missingSkills,
        strengthAreas: analysis.strengthAreas,
        summary: analysis.summary,
        tokensUsed: analysis.tokensUsed,
        scoredAt: new Date(),
      },
      create: {
        userId,
        jobListingId,
        matchScore: analysis.totalScore,
        recommendation: analysis.recommendation,
        skillsScore: analysis.skillsScore.raw,
        experienceScore: analysis.experienceScore.raw,
        locationScore: analysis.locationScore.raw,
        salaryScore: analysis.salaryScore.raw,
        missingSkills: analysis.missingSkills,
        strengthAreas: analysis.strengthAreas,
        summary: analysis.summary,
        tokensUsed: analysis.tokensUsed,
      },
    });
  }

  // ── Enqueue for auto-application ─────────────────────────
  private async enqueueForApplication(
    userId: string,
    jobListingId: string,
    score: number,
  ): Promise<void> {
    try {
      // Check user's auto-apply setting
      const prefs = await this.prisma.jobPreference.findUnique({
        where: { userId },
        select: { autoApplyEnabled: true },
      });

      if (!prefs?.autoApplyEnabled) return;

      // Check daily application limit
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const [prefs2, todayCount] = await Promise.all([
        this.prisma.jobPreference.findUnique({
          where: { userId },
          select: { maxApplicationsPerDay: true },
        }),
        this.prisma.application.count({
          where: {
            userId,
            createdAt: { gte: todayStart },
          },
        }),
      ]);

      const dailyLimit = prefs2?.maxApplicationsPerDay ?? 10;
      if (todayCount >= dailyLimit) {
        logger.info('Daily apply limit reached, skipping auto-apply', { userId, todayCount, dailyLimit });
        return;
      }

      // Check if application already exists
      const existing = await this.prisma.application.findUnique({
        where: { userId_jobListingId: { userId, jobListingId } },
      });
      if (existing) return;

      // Create pending application record first
      const application = await this.prisma.application.create({
        data: {
          userId,
          jobListingId,
          status: 'PENDING',
        },
      });

      // Enqueue for resume tailoring first, then apply
      const { Queue } = await import('bullmq');
      const { getRedisConnection } = await import('../utils/redis.js');

      const tailorQueue = new Queue('resume-tailor-queue', {
        connection: getRedisConnection(),
        prefix: process.env['REDIS_QUEUE_PREFIX'] ?? 'jhq',
      });

      // Find user's active resume
      const resume = await this.prisma.resume.findFirst({
        where: { userId, isActive: true },
        orderBy: { version: 'desc' },
        select: { id: true },
      });

      if (resume) {
        await tailorQueue.add('tailor', {
          userId,
          resumeId: resume.id,
          jobListingId,
          applicationId: application.id,
        }, {
          priority: score >= 85 ? 1 : 2,
          attempts: 2,
          removeOnComplete: { count: 100 },
        });
      }

      logger.info('Enqueued for auto-application', {
        userId,
        jobListingId,
        applicationId: application.id,
        score,
      });

    } catch (err) {
      logger.error('Failed to enqueue for application', {
        userId,
        jobListingId,
        error: String(err),
      });
    }
  }

  // ── Reconstruct MatchAnalysis from DB record ──────────────
  private dbRecordToAnalysis(record: {
    matchScore: number;
    recommendation: string;
    skillsScore: number | null;
    experienceScore: number | null;
    locationScore: number | null;
    salaryScore: number | null;
    missingSkills: unknown;
    strengthAreas: unknown;
    summary: string | null;
    tokensUsed: number | null;
  }): MatchAnalysis {
    const toArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

    return {
      totalScore: record.matchScore,
      recommendation: (record.recommendation as 'YES' | 'MAYBE' | 'NO') ?? 'MAYBE',
      skillsScore: {
        raw: record.skillsScore ?? 0,
        weighted: (record.skillsScore ?? 0) * 0.4,
        rationale: '',
        signals: [],
      },
      experienceScore: {
        raw: record.experienceScore ?? 0,
        weighted: (record.experienceScore ?? 0) * 0.3,
        rationale: '',
        signals: [],
      },
      locationScore: {
        raw: record.locationScore ?? 0,
        weighted: (record.locationScore ?? 0) * 0.2,
        rationale: '',
        signals: [],
      },
      salaryScore: {
        raw: record.salaryScore ?? 0,
        weighted: (record.salaryScore ?? 0) * 0.1,
        rationale: '',
        signals: [],
      },
      summary: record.summary ?? '',
      missingSkills: toArr(record.missingSkills),
      strengthAreas: toArr(record.strengthAreas),
      redFlags: [],
      keyHighlights: [],
      tokensUsed: record.tokensUsed ?? 0,
      modelUsed: 'cached',
      processingMs: 0,
    };
  }
}
