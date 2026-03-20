// ============================================================
// Profile Persister
// Takes the extracted CandidateProfile and writes it to:
//   1. resumes.parsed_json  — full CandidateProfile JSONB
//   2. resumes.parsed_text  — cleaned raw text
//   3. profiles.*           — top-level fields (name, title, exp)
//   4. skills.*             — individual skill records (upsert)
//   5. resumes.embedding_*  — embedding vector + metadata
//
// Uses transactions to ensure consistency.
// ============================================================

import { PrismaClient } from '@prisma/client';
import type { CandidateProfile, ResumeEmbedding } from '../types/resumeTypes.js';
import { logger } from '../utils/logger.js';

export async function persistResumeProfile(
  prisma: PrismaClient,
  resumeId: string,
  userId: string,
  rawText: string,
  profile: CandidateProfile,
): Promise<void> {
  logger.info('Persisting resume profile', {
    resumeId,
    userId,
    skills: profile.skills.length,
    tech:   profile.technologies.length,
    roles:  profile.roles.length,
  });

  await prisma.$transaction(async (tx) => {

    // ── 1. Update resume record ───────────────────────────
    await tx.resume.update({
      where: { id: resumeId },
      data: {
        parsedText:    rawText,
        parsedJson:    profile as object,
        isParsed:      true,
        parsedAt:      new Date(),
        wordCount:     rawText.split(/\s+/).filter(Boolean).length,
        confidence:    profile._meta.confidence,
        parserVersion: profile._meta.parserVersion,
      },
    });

    // ── 2. Upsert profile fields ──────────────────────────
    const profileUpdate: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    // Only update profile fields if they were extracted
    // and the user hasn't manually set them (check by null)
    const existingProfile = await tx.profile.findUnique({
      where: { userId },
      select: {
        firstName: true,
        lastName: true,
        currentTitle: true,
        yearsExperience: true,
        seniorityLevel: true,
        location: true,
        phone: true,
        linkedinUrl: true,
        githubUrl: true,
        portfolioUrl: true,
        bio: true,
      },
    });

    if (profile.name && existingProfile) {
      const parts = profile.name.trim().split(/\s+/);
      if (!existingProfile.firstName && parts[0]) profileUpdate['firstName'] = parts[0];
      if (!existingProfile.lastName  && parts.slice(1).join(' ')) profileUpdate['lastName']  = parts.slice(1).join(' ');
    }
    if (!existingProfile?.currentTitle  && profile.currentTitle)    profileUpdate['currentTitle']    = profile.currentTitle;
    if (!existingProfile?.yearsExperience && profile.experience_years > 0) profileUpdate['yearsExperience'] = profile.experience_years;
    if (!existingProfile?.seniorityLevel && profile.seniorityLevel !== 'unknown') profileUpdate['seniorityLevel'] = profile.seniorityLevel;
    if (!existingProfile?.location     && profile.location)          profileUpdate['location']     = profile.location;
    if (!existingProfile?.phone        && profile.phone)             profileUpdate['phone']        = profile.phone;
    if (!existingProfile?.linkedinUrl  && profile.linkedinUrl)       profileUpdate['linkedinUrl']  = profile.linkedinUrl;
    if (!existingProfile?.githubUrl    && profile.githubUrl)         profileUpdate['githubUrl']    = profile.githubUrl;
    if (!existingProfile?.portfolioUrl && profile.portfolioUrl)      profileUpdate['portfolioUrl'] = profile.portfolioUrl;
    if (!existingProfile?.bio          && profile.summary)           profileUpdate['bio']          = profile.summary;

    if (Object.keys(profileUpdate).length > 1) {
      await tx.profile.upsert({
        where: { userId },
        update: profileUpdate,
        create: {
          userId,
          ...profileUpdate,
        },
      });
    }

    // ── 3. Upsert skills ──────────────────────────────────
    // First: deactivate all AI-extracted skills (will re-add)
    await tx.skill.deleteMany({
      where: { userId, isExtracted: true },
    });

    // Insert new skills in batches of 50
    const skillBatches = chunkArray(profile.skills, 50);
    for (const batch of skillBatches) {
      await Promise.all(batch.map(skill =>
        tx.skill.upsert({
          where: { userId_name: { userId, name: skill.name } },
          update: {
            category:    skill.category,
            proficiency: skill.proficiency,
            yearsUsed:   skill.yearsUsed,
            isExtracted: true,
            updatedAt:   new Date(),
          },
          create: {
            userId,
            name:        skill.name,
            category:    skill.category,
            proficiency: skill.proficiency,
            yearsUsed:   skill.yearsUsed,
            isExtracted: true,
          },
        })
      ));
    }

    logger.debug(`Persisted ${profile.skills.length} skills`);
  });

  logger.info('Profile persist complete', { resumeId, userId });
}

// ── Persist embedding ─────────────────────────────────────────
export async function persistEmbeddingToDb(
  prisma: PrismaClient,
  resumeId: string,
  embedding: ResumeEmbedding,
): Promise<void> {
  // Store vector as JSON array
  // In production: ALTER TABLE resumes ADD COLUMN embedding_vector vector(1024);
  // Then use: UPDATE resumes SET embedding_vector = $1::vector WHERE id = $2
  // For now we store as JSONB
  await prisma.resume.update({
    where: { id: resumeId },
    data: {
      embeddingVector:      embedding.vector as unknown as object,
      embeddingModel:       embedding.model,
      embeddingDimensions:  embedding.dimensions,
      embeddingText:        embedding.textUsed,
      embeddedAt:           new Date(),
    },
  });

  logger.debug('Embedding persisted to DB', {
    resumeId,
    dims: embedding.dimensions,
    model: embedding.model,
  });
}

// ── Sync extracted data to user profile ──────────────────────
export async function syncExperienceToProfile(
  prisma: PrismaClient,
  userId: string,
  profile: CandidateProfile,
): Promise<void> {
  // Update job_preferences with inferred data if not set
  const prefs = await prisma.jobPreference.findUnique({ where: { userId } });

  if (prefs) {
    const updates: Record<string, unknown> = {};

    // Infer target roles from experience if not set
    if ((!prefs.targetRoles || (prefs.targetRoles as string[]).length === 0) && profile.roles.length > 0) {
      updates['targetRoles'] = profile.roles.slice(0, 3);
    }

    if (Object.keys(updates).length > 0) {
      await prisma.jobPreference.update({
        where: { userId },
        data: updates,
      });
      logger.debug('Job preferences updated from resume', { userId, updates: Object.keys(updates) });
    }
  }
}

// ── Helper ────────────────────────────────────────────────────
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
