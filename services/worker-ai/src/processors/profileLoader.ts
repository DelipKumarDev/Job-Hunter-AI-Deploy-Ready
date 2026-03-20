// ============================================================
// Profile Loader
// Assembles a complete CandidateProfile from all related
// DB tables for use in match scoring.
// Cached per-user with 1h TTL (profile changes infrequently).
// ============================================================

import { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type { CandidateProfile } from '../types.js';
import { logger } from '../utils/logger.js';

const PROFILE_CACHE_TTL = 3600; // 1 hour

export class ProfileLoader {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
  ) {}

  private cacheKey(userId: string): string {
    return `profile:v1:${userId}`;
  }

  async load(userId: string): Promise<CandidateProfile> {
    // Check Redis cache first
    try {
      const cached = await this.redis.get(this.cacheKey(userId));
      if (cached) {
        return JSON.parse(cached) as CandidateProfile;
      }
    } catch {
      // Fall through to DB load
    }

    const profile = await this.loadFromDb(userId);

    // Cache it
    try {
      await this.redis.setex(
        this.cacheKey(userId),
        PROFILE_CACHE_TTL,
        JSON.stringify(profile),
      );
    } catch {
      // Non-critical
    }

    return profile;
  }

  async invalidate(userId: string): Promise<void> {
    try {
      await this.redis.del(this.cacheKey(userId));
    } catch {
      // Non-critical
    }
  }

  private async loadFromDb(userId: string): Promise<CandidateProfile> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        profile: true,
        skills: {
          where: { isExtracted: false }, // Prefer manually added skills
          orderBy: [
            { proficiency: 'desc' },
            { name: 'asc' },
          ],
          take: 50, // Cap at 50 skills for prompt size
        },
        resumes: {
          where: { isActive: true },
          orderBy: { version: 'desc' },
          take: 1,
          select: {
            parsedText: true,
            parsedJson: true,
          },
        },
        jobPreferences: true,
      },
    });

    if (!user) throw new Error(`User not found: ${userId}`);

    // If no manually-added skills, fall back to AI-extracted ones
    let skills = user.skills;
    if (skills.length === 0) {
      skills = await this.prisma.skill.findMany({
        where: { userId, isExtracted: true },
        orderBy: { name: 'asc' },
        take: 50,
      });
    }

    // Extract experience summary from parsed resume JSON if available
    let experienceSummary: string | null = null;
    const resumeJson = user.resumes[0]?.parsedJson;
    if (resumeJson && typeof resumeJson === 'object') {
      const parsed = resumeJson as Record<string, unknown>;
      const exp = parsed['experience'];
      if (Array.isArray(exp) && exp.length > 0) {
        // Build a text summary from structured experience data
        experienceSummary = exp
          .slice(0, 3) // Top 3 roles
          .map((e: Record<string, unknown>) => {
            const title = e['title'] ?? e['role'] ?? 'Unknown Role';
            const company = e['company'] ?? e['employer'] ?? '';
            const duration = e['duration'] ?? e['dates'] ?? '';
            return `${title}${company ? ` at ${company}` : ''}${duration ? ` (${duration})` : ''}`;
          })
          .join(' → ');
      }
    }

    const prefs = user.jobPreferences;

    return {
      userId,
      firstName: user.profile?.firstName ?? '',
      lastName: user.profile?.lastName ?? '',
      headline: user.profile?.headline ?? null,
      currentTitle: user.profile?.currentTitle ?? null,
      yearsExperience: user.profile?.yearsExperience ?? null,
      seniorityLevel: user.profile?.seniorityLevel ?? null,
      bio: user.profile?.bio ?? null,
      location: user.profile?.location ?? null,
      country: user.profile?.country ?? null,
      skills: skills.map(s => ({
        name: s.name,
        proficiency: s.proficiency,
        category: s.category ?? null,
      })),
      experienceSummary,
      resumeText: user.resumes[0]?.parsedText ?? null,
      preferences: prefs ? {
        targetRoles: prefs.targetRoles as string[],
        preferredLocations: prefs.preferredLocations as string[],
        remotePreference: prefs.remotePreference,
        salaryMin: prefs.salaryMin ?? null,
        salaryMax: prefs.salaryMax ?? null,
        salaryCurrency: prefs.salaryCurrency ?? 'USD',
        jobTypes: prefs.jobTypes as string[],
        minMatchScore: prefs.minMatchScore,
      } : null,
    };
  }
}
