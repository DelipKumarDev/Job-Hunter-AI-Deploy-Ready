// ============================================================
// Resume Upload + Parse API Routes
// POST /api/v1/resumes/upload  — Upload PDF/DOCX, enqueue parse
// GET  /api/v1/resumes/:id     — Get parsed resume + profile
// GET  /api/v1/resumes/:id/profile — Get CandidateProfile JSON
// POST /api/v1/resumes/:id/reparse — Trigger re-parse
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { AppError } from '../middleware/errorHandler.js';
import { getQueueOrDirect } from '../lib/queues.js';

export const resumeRouter = Router();
const prisma = new PrismaClient();

// ── S3 client ─────────────────────────────────────────────────
const s3 = new S3Client({
  region: process.env['AWS_REGION'] ?? 'us-east-1',
  credentials: process.env['AWS_ACCESS_KEY_ID'] ? {
    accessKeyId:     process.env['AWS_ACCESS_KEY_ID']!,
    secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY']!,
  } : undefined,
});

const S3_BUCKET = process.env['AWS_S3_BUCKET'] ?? 'job-hunter-resumes';
const MAX_FILE_SIZE_MB = 10;
const ALLOWED_MIME_TYPES = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

// ── POST /upload ──────────────────────────────────────────────
// Expects multipart/form-data with `resume` file field
resumeRouter.post('/upload', async (req, res, next) => {
  try {
    const userId = req.user!.id;

    // In real app, use multer middleware to handle file upload
    // @ts-expect-error - multer populates req.file
    const file = req.file as { buffer: Buffer; originalname: string; mimetype: string; size: number } | undefined;

    if (!file) {
      throw new AppError('No file uploaded', 400, 'NO_FILE');
    }

    // ── Validation ─────────────────────────────────────────
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new AppError('Only PDF and DOCX files are accepted', 400, 'INVALID_FILE_TYPE');
    }

    const fileSizeMb = file.size / (1024 * 1024);
    if (fileSizeMb > MAX_FILE_SIZE_MB) {
      throw new AppError(`File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB`, 400, 'FILE_TOO_LARGE');
    }

    const fileType = file.mimetype === 'application/pdf' ? 'pdf' : 'docx';
    const ext      = fileType === 'pdf' ? '.pdf' : '.docx';

    // ── Get next version number ────────────────────────────
    const existingCount = await prisma.resume.count({ where: { userId } });
    const version = existingCount + 1;

    // ── Upload to S3 ───────────────────────────────────────
    const resumeId = randomUUID();
    const s3Key    = `resumes/${userId}/${resumeId}${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket:      S3_BUCKET,
      Key:         s3Key,
      Body:        file.buffer,
      ContentType: file.mimetype,
      Metadata: {
        userId,
        resumeId,
        originalName: encodeURIComponent(file.originalname),
        uploadedAt:   new Date().toISOString(),
      },
    }));

    const s3Url = `s3://${S3_BUCKET}/${s3Key}`;

    // ── Create resume record ───────────────────────────────
    // Deactivate previous resumes
    await prisma.resume.updateMany({
      where: { userId, isActive: true },
      data:  { isActive: false },
    });

    const resume = await prisma.resume.create({
      data: {
        id:       resumeId,
        userId,
        fileUrl:  s3Url,
        fileName: file.originalname,
        fileType: fileType.toUpperCase() as 'PDF' | 'DOCX',
        fileSize: file.size,
        version,
        isActive: true,
        isParsed: false,
      },
    });

    // ── Enqueue for parsing ────────────────────────────────
    const parseQueue = getQueueOrDirect('resume-parse-queue');

    const queueJob = await parseQueue.add('parse', {
      resumeId,
      userId,
      s3Url,
      fileType,
      version,
      forceReparse: false,
    }, {
      attempts:         3,
      removeOnComplete: { count: 50 },
      removeOnFail:     { count: 20 },
    });

    res.status(201).json({
      success: true,
      data: {
        resumeId:    resume.id,
        version:     resume.version,
        status:      'parsing',
        queueJobId:  queueJob.id,
        message:     'Resume uploaded. Parsing will complete in 15–30 seconds.',
        fileType,
        fileSizeMb:  Math.round(fileSizeMb * 10) / 10,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /:id/profile — Full CandidateProfile JSON ─────────────
resumeRouter.get('/:id/profile', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { id }  = req.params as { id: string };

    const resume = await prisma.resume.findFirst({
      where: { id, userId },
      select: {
        id:           true,
        parsedJson:   true,
        isParsed:     true,
        parsedAt:     true,
        version:      true,
        confidence:   true,
        wordCount:    true,
      },
    });

    if (!resume) throw new AppError('Resume not found', 404, 'NOT_FOUND');

    if (!resume.isParsed || !resume.parsedJson) {
      return res.json({
        success: true,
        data: {
          status:  'pending',
          message: 'Resume is still being parsed. Check back in a few seconds.',
        },
      });
    }

    return res.json({
      success: true,
      data: {
        resumeId:  resume.id,
        version:   resume.version,
        parsedAt:  resume.parsedAt,
        confidence: resume.confidence,
        wordCount:  resume.wordCount,
        profile:   resume.parsedJson, // Full CandidateProfile JSON
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /:id/skills — Extracted skills list ────────────────────
resumeRouter.get('/:id/skills', async (req, res, next) => {
  try {
    const userId = req.user!.id;

    const skills = await prisma.skill.findMany({
      where: { userId, isExtracted: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });

    const grouped = skills.reduce((acc, skill) => {
      const cat = skill.category ?? 'other';
      if (!acc[cat]) acc[cat] = [];
      acc[cat]!.push({ name: skill.name, proficiency: skill.proficiency, yearsUsed: skill.yearsUsed });
      return acc;
    }, {} as Record<string, Array<{ name: string; proficiency: string; yearsUsed: number | null }>>);

    res.json({ success: true, data: { total: skills.length, grouped } });
  } catch (error) {
    next(error);
  }
});

// ── POST /:id/reparse — Force re-parse ─────────────────────────
resumeRouter.post('/:id/reparse', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { id }  = req.params as { id: string };

    const resume = await prisma.resume.findFirst({
      where: { id, userId },
      select: { fileUrl: true, fileType: true, version: true },
    });

    if (!resume) throw new AppError('Resume not found', 404, 'NOT_FOUND');

    const parseQueue = getQueueOrDirect('resume-parse-queue');

    const queueJob = await parseQueue.add('parse', {
      resumeId: id,
      userId,
      s3Url:    resume.fileUrl,
      fileType: resume.fileType.toLowerCase() as 'pdf' | 'docx',
      version:  resume.version,
      forceReparse: true,
    }, { priority: 1 });

    res.json({
      success: true,
      data: { message: 'Re-parse enqueued', queueJobId: queueJob.id },
    });
  } catch (error) {
    next(error);
  }
});
