// ============================================================
// Match Analytics
// Aggregated statistics on match quality and funnel metrics.
// Used by the dashboard API to show insights to users.
// ============================================================

import { PrismaClient } from '@prisma/client';
import { SCORE_WEIGHTS } from '../types.js';

export interface MatchFunnelStats {
  totalScored: number;
  avgScore: number;
  distribution: {
    excellent: number;   // 90-100
    strong: number;      // 75-89
    good: number;        // 60-74
    partial: number;     // 45-59
    weak: number;        // 30-44
    poor: number;        // 0-29
  };
  byRecommendation: {
    yes: number;
    maybe: number;
    no: number;
  };
  qualifiedForApply: number;  // Above user's threshold
  topDimensionScores: {
    avgSkills: number;
    avgExperience: number;
    avgLocation: number;
    avgSalary: number;
  };
}

export interface TopMatchedJob {
  jobId: string;
  title: string;
  company: string;
  platform: string;
  matchScore: number;
  recommendation: string;
  location: string | null;
  remoteType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  strengthAreas: string[];
  missingSkills: string[];
}

export class MatchAnalytics {
  constructor(private readonly prisma: PrismaClient) {}

  async getFunnelStats(userId: string): Promise<MatchFunnelStats> {
    const matches = await this.prisma.jobMatch.findMany({
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

    if (matches.length === 0) {
      return this.emptyStats();
    }

    const total = matches.length;
    const avgScore = Math.round(
      matches.reduce((sum, m) => sum + m.matchScore, 0) / total
    );

    const distribution = {
      excellent: matches.filter(m => m.matchScore >= 90).length,
      strong: matches.filter(m => m.matchScore >= 75 && m.matchScore < 90).length,
      good: matches.filter(m => m.matchScore >= 60 && m.matchScore < 75).length,
      partial: matches.filter(m => m.matchScore >= 45 && m.matchScore < 60).length,
      weak: matches.filter(m => m.matchScore >= 30 && m.matchScore < 45).length,
      poor: matches.filter(m => m.matchScore < 30).length,
    };

    const byRecommendation = {
      yes: matches.filter(m => m.recommendation === 'YES').length,
      maybe: matches.filter(m => m.recommendation === 'MAYBE').length,
      no: matches.filter(m => m.recommendation === 'NO').length,
    };

    // Get user's threshold
    const prefs = await this.prisma.jobPreference.findUnique({
      where: { userId },
      select: { minMatchScore: true },
    });
    const threshold = prefs?.minMatchScore ?? 75;
    const qualifiedForApply = matches.filter(m => m.matchScore >= threshold).length;

    const withSkills = matches.filter(m => m.skillsScore != null);
    const avgDimension = (field: keyof typeof matches[0]): number =>
      withSkills.length === 0
        ? 0
        : Math.round(
          withSkills.reduce((sum, m) => sum + ((m[field] as number | null) ?? 0), 0) / withSkills.length
        );

    return {
      totalScored: total,
      avgScore,
      distribution,
      byRecommendation,
      qualifiedForApply,
      topDimensionScores: {
        avgSkills: avgDimension('skillsScore'),
        avgExperience: avgDimension('experienceScore'),
        avgLocation: avgDimension('locationScore'),
        avgSalary: avgDimension('salaryScore'),
      },
    };
  }

  async getTopMatches(userId: string, limit: number = 20): Promise<TopMatchedJob[]> {
    const matches = await this.prisma.jobMatch.findMany({
      where: {
        userId,
        recommendation: { not: 'NO' },
        matchScore: { gte: 50 },
      },
      include: {
        jobListing: {
          select: {
            id: true,
            title: true,
            company: true,
            sourcePlatform: true,
            location: true,
            remoteType: true,
            salaryMin: true,
            salaryMax: true,
          },
        },
      },
      orderBy: { matchScore: 'desc' },
      take: limit,
    });

    return matches.map(m => ({
      jobId: m.jobListingId,
      title: m.jobListing.title,
      company: m.jobListing.company,
      platform: m.jobListing.sourcePlatform,
      matchScore: m.matchScore,
      recommendation: m.recommendation,
      location: m.jobListing.location,
      remoteType: m.jobListing.remoteType,
      salaryMin: m.jobListing.salaryMin,
      salaryMax: m.jobListing.salaryMax,
      strengthAreas: (m.strengthAreas as string[]) ?? [],
      missingSkills: (m.missingSkills as string[]) ?? [],
    }));
  }

  async getSkillGapReport(userId: string): Promise<{
    topMissingSkills: Array<{ skill: string; frequency: number }>;
    topStrengths: Array<{ skill: string; frequency: number }>;
  }> {
    const matches = await this.prisma.jobMatch.findMany({
      where: { userId },
      select: {
        missingSkills: true,
        strengthAreas: true,
      },
    });

    const missingCount = new Map<string, number>();
    const strengthCount = new Map<string, number>();

    for (const match of matches) {
      for (const skill of (match.missingSkills as string[]) ?? []) {
        missingCount.set(skill, (missingCount.get(skill) ?? 0) + 1);
      }
      for (const area of (match.strengthAreas as string[]) ?? []) {
        strengthCount.set(area, (strengthCount.get(area) ?? 0) + 1);
      }
    }

    const toSorted = (map: Map<string, number>) =>
      Array.from(map.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([skill, frequency]) => ({ skill, frequency }));

    return {
      topMissingSkills: toSorted(missingCount),
      topStrengths: toSorted(strengthCount),
    };
  }

  private emptyStats(): MatchFunnelStats {
    return {
      totalScored: 0,
      avgScore: 0,
      distribution: { excellent: 0, strong: 0, good: 0, partial: 0, weak: 0, poor: 0 },
      byRecommendation: { yes: 0, maybe: 0, no: 0 },
      qualifiedForApply: 0,
      topDimensionScores: { avgSkills: 0, avgExperience: 0, avgLocation: 0, avgSalary: 0 },
    };
  }
}
