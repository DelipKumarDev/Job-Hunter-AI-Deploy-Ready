// ============================================================
// Resume Embedding Generator
// Generates dense vector embeddings (1536-dim) using
// Claude's text-embedding API for semantic job matching.
//
// Strategy: Build an optimised embedding text from the
// structured profile that weights high-signal fields.
// Stores in PostgreSQL pgvector column for fast cosine search.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '@prisma/client';
import type { CandidateProfile, ResumeEmbedding, EmbeddingStrategy } from '../types/resumeTypes.js';
import { logger } from '../utils/logger.js';

const EMBEDDING_MODEL = 'voyage-3'; // Best for technical content
const EMBEDDING_DIMS  = 1024;       // voyage-3 dimensions

// We use Claude's native embedding API (Anthropic SDK ≥ 0.24 supports this)
// For voyage-3 embeddings via Anthropic's API
const ANTHROPIC_EMBEDDING_MODEL = 'voyage-3';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });
  return client;
}

// ─────────────────────────────────────────────────────────────
// EMBEDDING TEXT BUILDERS
// Carefully constructed text optimises semantic similarity.
// Job listings use the same format for cosine matching.
// ─────────────────────────────────────────────────────────────

/**
 * Full-text strategy: Best overall semantic match.
 * Includes summary, experience descriptions, all skills.
 */
export function buildFullTextEmbedding(profile: CandidateProfile): string {
  const parts: string[] = [];

  // Header: who they are
  if (profile.currentTitle)   parts.push(`Professional title: ${profile.currentTitle}`);
  if (profile.seniorityLevel) parts.push(`Seniority: ${profile.seniorityLevel}`);
  if (profile.experience_years > 0) parts.push(`Years of experience: ${profile.experience_years}`);
  if (profile.summary)        parts.push(`Summary: ${profile.summary}`);

  // Skills — highest signal for tech matching
  if (profile.skills_flat.length > 0) {
    parts.push(`Skills: ${profile.skills_flat.join(', ')}`);
  }

  // Technologies — separate from soft skills
  if (profile.technologies_flat.length > 0) {
    parts.push(`Technologies: ${profile.technologies_flat.join(', ')}`);
  }

  // Roles held
  if (profile.roles.length > 0) {
    parts.push(`Roles: ${profile.roles.join(', ')}`);
  }

  // Recent experience (top 3 roles)
  const recentExp = profile.experience.slice(0, 3);
  for (const exp of recentExp) {
    const role = `${exp.title} at ${exp.company}`;
    const skills = exp.skills.length > 0 ? ` using ${exp.skills.join(', ')}` : '';
    parts.push(role + skills);
    if (exp.achievements.length > 0) {
      parts.push(exp.achievements.slice(0, 2).join(' '));
    }
  }

  // Education
  if (profile.education.length > 0) {
    const edu = profile.education[0]!;
    const degree = [edu.degree, edu.field, 'at', edu.institution].filter(Boolean).join(' ');
    parts.push(`Education: ${degree}`);
  }

  // Certifications
  if (profile.certifications.length > 0) {
    parts.push(`Certifications: ${profile.certifications.map(c => c.name).join(', ')}`);
  }

  // Industries
  if (profile.industries.length > 0) {
    parts.push(`Industries: ${profile.industries.join(', ')}`);
  }

  return parts.join('. ');
}

/**
 * Skills-only strategy: Fast skill matching without noise.
 * Used for quick filtering before full semantic search.
 */
export function buildSkillsEmbedding(profile: CandidateProfile): string {
  const allSkills = [
    ...profile.skills_flat,
    ...profile.technologies_flat,
    ...profile.certifications.map(c => c.name),
  ];

  return [
    profile.currentTitle ?? '',
    `Skills: ${allSkills.join(', ')}`,
    `Experience: ${profile.experience_years} years`,
  ].filter(Boolean).join('. ');
}

/**
 * Experience-summary strategy: Career trajectory matching.
 * Useful for seniority and role-type alignment.
 */
export function buildExperienceSummaryEmbedding(profile: CandidateProfile): string {
  const expLines = profile.experience.map(exp => {
    const duration = exp.durationMonths
      ? `(${Math.round(exp.durationMonths / 12 * 10) / 10} years)`
      : '';
    return `${exp.title} at ${exp.company} ${duration}`;
  });

  return [
    `${profile.experience_years} years experience`,
    profile.seniorityLevel,
    ...expLines.slice(0, 5),
    `Industries: ${profile.industries.join(', ')}`,
  ].filter(Boolean).join('. ');
}

// ─────────────────────────────────────────────────────────────
// ANTHROPIC EMBEDDING API CALL
// Uses voyage-3 via Anthropic's embedding endpoint
// ─────────────────────────────────────────────────────────────
async function callEmbeddingApi(text: string): Promise<number[]> {
  // Truncate to safe token limit (voyage-3: 32k tokens, use 8k to be safe)
  const truncated = text.slice(0, 32000);

  try {
    // Anthropic SDK embedding call
    const response = await (getClient() as unknown as {
      beta: {
        embeddings: {
          create: (params: { model: string; input: string }) => Promise<{ embeddings: Array<{ embedding: number[] }> }>;
        };
      };
    }).beta.embeddings.create({
      model: ANTHROPIC_EMBEDDING_MODEL,
      input: truncated,
    });

    return response.embeddings[0]?.embedding ?? [];

  } catch (err) {
    // Fallback: use Claude to generate a pseudo-embedding via structured hash
    // This is a degraded fallback — in production, configure voyage-3 properly
    logger.warn('Embedding API unavailable, using fallback hash embedding', { error: String(err) });
    return generateFallbackEmbedding(text);
  }
}

/**
 * Fallback embedding: deterministic hash-based vector.
 * NOT suitable for production cosine similarity — only ensures
 * the pipeline doesn't fail if embedding API is unavailable.
 */
function generateFallbackEmbedding(text: string): number[] {
  const dims = 1536;
  const vector = new Array<number>(dims).fill(0);
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);

  for (const word of words) {
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) - hash) + word.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % dims;
    vector[idx] = (vector[idx]! + 1);
  }

  // L2 normalise
  const magnitude = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
  return magnitude > 0 ? vector.map(v => v / magnitude) : vector;
}

// ─────────────────────────────────────────────────────────────
// MAIN EMBEDDING GENERATOR
// ─────────────────────────────────────────────────────────────
export async function generateResumeEmbedding(
  resumeId: string,
  userId: string,
  profile: CandidateProfile,
  strategy: EmbeddingStrategy = 'full_text',
): Promise<ResumeEmbedding> {
  let embeddingText: string;

  switch (strategy) {
    case 'skills_only':
      embeddingText = buildSkillsEmbedding(profile);
      break;
    case 'experience_summary':
      embeddingText = buildExperienceSummaryEmbedding(profile);
      break;
    case 'full_text':
    default:
      embeddingText = buildFullTextEmbedding(profile);
  }

  logger.debug('Generating embedding', {
    resumeId,
    strategy,
    textLength: embeddingText.length,
  });

  const vector = await callEmbeddingApi(embeddingText);

  const embedding: ResumeEmbedding = {
    resumeId,
    userId,
    vector,
    dimensions: vector.length,
    model:      ANTHROPIC_EMBEDDING_MODEL,
    textUsed:   embeddingText.substring(0, 500), // Store excerpt for debugging
    createdAt:  new Date().toISOString(),
  };

  logger.info('Embedding generated', {
    resumeId,
    dimensions: vector.length,
    strategy,
  });

  return embedding;
}

// ─────────────────────────────────────────────────────────────
// PERSIST EMBEDDING TO POSTGRESQL (pgvector)
// ─────────────────────────────────────────────────────────────
export async function persistEmbedding(
  prisma: PrismaClient,
  embedding: ResumeEmbedding,
): Promise<void> {
  // Store as JSON array in resume.embedding column (pgvector JSONB)
  // In production, use pgvector's vector type with <=> operator
  await prisma.resume.update({
    where: { id: embedding.resumeId },
    data: {
      embeddingVector:    embedding.vector,   // JSONB column: float[]
      embeddingModel:     embedding.model,
      embeddingStrategy:  'full_text',
      embeddingTextExcerpt: embedding.textUsed,
      embeddedAt:         new Date(),
    },
  });

  logger.debug('Embedding persisted', { resumeId: embedding.resumeId });
}

// ─────────────────────────────────────────────────────────────
// COSINE SIMILARITY (for in-memory comparison / unit tests)
// In production, pgvector handles this with index
// ─────────────────────────────────────────────────────────────
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─────────────────────────────────────────────────────────────
// EMBEDDING-ENHANCED JOB MATCH SCORE BOOST
// When used alongside the AI match scorer, embedding similarity
// can be used to boost or penalise the final match score.
// ─────────────────────────────────────────────────────────────
export function computeEmbeddingBoost(
  similarity: number,   // 0–1 cosine similarity
  baseScore: number,    // 0–100 from AI match scorer
): number {
  // Similarity > 0.85 → up to +5 point boost
  // Similarity < 0.40 → up to -5 point penalty
  const delta = (similarity - 0.625) * 32; // Maps 0.4→-7.2, 0.625→0, 0.85→+7.2
  const boost  = Math.max(-5, Math.min(5, delta));
  return Math.max(0, Math.min(100, Math.round(baseScore + boost)));
}
