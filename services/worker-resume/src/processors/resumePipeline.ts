// ============================================================
// Resume Intelligence Pipeline Orchestrator
// Ties together: parse → extract → embed → persist
// Each stage is independently retryable and logged.
// ============================================================

import { PrismaClient } from '@prisma/client';
import type { ResumeParsePayload, ResumeIntelligenceResult } from '../types/resumeTypes.js';
import { parseResume } from '../parsers/documentParser.js';
import { extractCandidateProfile } from '../extractors/nlpExtractor.js';
import { generateResumeEmbedding } from '../embeddings/embeddingGenerator.js';
import {
  persistResumeProfile,
  persistEmbeddingToDb,
  syncExperienceToProfile,
} from './profilePersister.js';
import { logger } from '../utils/logger.js';

export async function runResumePipeline(
  prisma: PrismaClient,
  payload: ResumeParsePayload,
): Promise<ResumeIntelligenceResult> {
  const startMs = Date.now();
  const { resumeId, userId, s3Url, fileType } = payload;

  logger.info('Resume pipeline starting', { resumeId, userId, fileType });

  // ── Stage 1: Parse document to raw text ──────────────────
  logger.info('Stage 1/4: Parsing document', { fileType, s3Url });
  const rawResume = await parseResume(s3Url, fileType);

  if (rawResume.metadata.wordCount < 50) {
    throw new Error(
      `Resume text too short (${rawResume.metadata.wordCount} words). ` +
      'The file may be image-based or corrupted.'
    );
  }

  logger.info('Document parsed', {
    pages:    rawResume.metadata.pageCount,
    words:    rawResume.metadata.wordCount,
    sections: rawResume.sections.length,
    hasStructure: rawResume.metadata.hasStructure,
  });

  // ── Stage 2: NLP extraction with Claude ──────────────────
  logger.info('Stage 2/4: NLP extraction');
  const { profile, tokensUsed, model } = await extractCandidateProfile(rawResume);

  logger.info('NLP extraction complete', {
    skills:       profile.skills.length,
    tech:         profile.technologies.length,
    roles:        profile.roles.length,
    expYears:     profile.experience_years,
    education:    profile.education.length,
    seniority:    profile.seniorityLevel,
    confidence:   profile._meta.confidence,
    tokensUsed,
  });

  // ── Stage 3: Generate embedding ───────────────────────────
  logger.info('Stage 3/4: Generating embedding');
  let embedding = null;
  try {
    embedding = await generateResumeEmbedding(resumeId, userId, profile, 'full_text');
    await persistEmbeddingToDb(prisma, resumeId, embedding);
    logger.info('Embedding generated and persisted', {
      dims:  embedding.dimensions,
      model: embedding.model,
    });
  } catch (err) {
    // Non-fatal — resume can still be used without embedding
    logger.warn('Embedding generation failed (non-fatal)', { error: String(err) });
  }

  // ── Stage 4: Persist to DB ────────────────────────────────
  logger.info('Stage 4/4: Persisting profile to database');
  await persistResumeProfile(prisma, resumeId, userId, rawResume.full, profile);
  await syncExperienceToProfile(prisma, userId, profile);

  const result: ResumeIntelligenceResult = {
    resumeId,
    userId,
    profile,
    embedding,
    skillsExtracted:  profile.skills.length,
    techExtracted:    profile.technologies.length,
    rolesExtracted:   profile.roles.length,
    educationCount:   profile.education.length,
    experienceYears:  profile.experience_years,
    processingMs:     Date.now() - startMs,
    tokensUsed,
  };

  logger.info('Resume pipeline complete ✅', {
    resumeId,
    processingMs:   result.processingMs,
    skillsExtracted: result.skillsExtracted,
    techExtracted:   result.techExtracted,
    tokensUsed:      result.tokensUsed,
  });

  return result;
}
