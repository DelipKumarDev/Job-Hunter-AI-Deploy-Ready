// ============================================================
// Threshold Manager
// Manages configurable score thresholds that control whether
// a job proceeds to the auto-application stage.
//
// Thresholds are evaluated in priority order:
//   1. Per-user override (from job_preferences.min_match_score)
//   2. Per-plan defaults (higher plans = more selective)
//   3. Global system defaults
// ============================================================

import { PrismaClient } from '@prisma/client';
import type { ThresholdConfig } from '../types.js';
import { DEFAULT_THRESHOLDS } from '../types.js';
import { logger } from '../utils/logger.js';

// Plan-based default thresholds
const PLAN_THRESHOLDS: Record<string, ThresholdConfig> = {
  FREE: {
    autoApply: 85,    // Free tier is conservative — only near-perfect matches
    recommend: 70,
    hide: 40,
  },
  STARTER: {
    autoApply: 78,
    recommend: 65,
    hide: 35,
  },
  PROFESSIONAL: {
    autoApply: 72,    // Pro users can be more aggressive
    recommend: 58,
    hide: 30,
  },
  ENTERPRISE: {
    autoApply: 65,    // Enterprise has most flexibility
    recommend: 50,
    hide: 25,
  },
};

export class ThresholdManager {
  constructor(private readonly prisma: PrismaClient) {}

  async getThresholdsForUser(userId: string): Promise<ThresholdConfig & {
    source: 'user_override' | 'plan_default' | 'system_default';
  }> {
    try {
      const userData = await this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          jobPreferences: {
            select: { minMatchScore: true },
          },
          subscription: {
            select: { plan: true },
          },
        },
      });

      // Priority 1: User's custom minMatchScore
      const userMin = userData?.jobPreferences?.minMatchScore;
      if (userMin != null && userMin > 0) {
        return {
          autoApply: userMin,
          recommend: Math.max(userMin - 15, 30),
          hide: Math.max(userMin - 40, 15),
          source: 'user_override',
        };
      }

      // Priority 2: Plan-based defaults
      const plan = userData?.subscription?.plan ?? 'FREE';
      const planConfig = PLAN_THRESHOLDS[plan] ?? PLAN_THRESHOLDS['FREE']!;

      return { ...planConfig, source: 'plan_default' };

    } catch (err) {
      logger.warn('Failed to load user thresholds, using defaults', { userId, error: String(err) });
      return { ...DEFAULT_THRESHOLDS, source: 'system_default' };
    }
  }

  // Evaluate a score against thresholds
  async evaluateScore(
    userId: string,
    score: number,
    recommendation: 'YES' | 'MAYBE' | 'NO',
  ): Promise<{
    shouldAutoApply: boolean;
    shouldRecommend: boolean;
    shouldHide: boolean;
    thresholds: ThresholdConfig;
    reason: string;
  }> {
    const thresholds = await this.getThresholdsForUser(userId);

    // NO recommendation always blocks auto-apply
    const shouldAutoApply =
      recommendation !== 'NO' &&
      score >= thresholds.autoApply;

    const shouldRecommend =
      recommendation !== 'NO' &&
      score >= thresholds.recommend;

    const shouldHide = score < thresholds.hide;

    let reason: string;
    if (shouldAutoApply) {
      reason = `Score ${score} ≥ threshold ${thresholds.autoApply} → Queued for auto-apply`;
    } else if (shouldRecommend) {
      reason = `Score ${score} ≥ recommend threshold ${thresholds.recommend} → Shown as recommended`;
    } else if (shouldHide) {
      reason = `Score ${score} < hide threshold ${thresholds.hide} → Hidden from results`;
    } else {
      reason = `Score ${score} in ${thresholds.hide}–${thresholds.autoApply} range → Shown, not auto-applied`;
    }

    return {
      shouldAutoApply,
      shouldRecommend,
      shouldHide,
      thresholds,
      reason,
    };
  }

  // Get jobs above threshold for a user (for batch processing)
  async getQualifiedJobIds(
    userId: string,
    minScore?: number,
  ): Promise<Array<{ jobListingId: string; score: number; recommendation: string }>> {
    const thresholds = await this.getThresholdsForUser(userId);
    const effectiveMin = minScore ?? thresholds.autoApply;

    return this.prisma.jobMatch.findMany({
      where: {
        userId,
        matchScore: { gte: effectiveMin },
        recommendation: { not: 'NO' },
      },
      select: {
        jobListingId: true,
        matchScore: true,
        recommendation: true,
      },
      orderBy: { matchScore: 'desc' },
    });
  }
}
