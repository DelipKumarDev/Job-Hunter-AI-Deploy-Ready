// ============================================================
// Screenshot Manager
// Captures milestone screenshots during bot runs and uploads
// them to S3 for audit trail and debugging.
//
// Milestones: pre_apply, success, error, unconfirmed
// ============================================================

import type { Page } from 'playwright';
import { logger } from './logger.js';

type Milestone = 'pre_apply' | 'success' | 'error' | 'unconfirmed' | 'step_complete';

export async function takeScreenshot(
  page:          Page,
  applicationId: string,
  milestone:     Milestone,
): Promise<string | null> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename  = `${applicationId}_${milestone}_${timestamp}.jpg`;

    // Capture as JPEG (smaller than PNG for storage)
    const buffer = await page.screenshot({
      type:     'jpeg',
      quality:  75,
      fullPage: false,
    });

    // Upload to S3
    const s3Url = await uploadToS3(buffer, filename);
    logger.debug('Screenshot captured', { milestone, filename, bytes: buffer.length });
    return s3Url;

  } catch (err) {
    logger.warn('Screenshot failed', { milestone, error: String(err) });
    return null;
  }
}

async function uploadToS3(buffer: Buffer, filename: string): Promise<string | null> {
  const bucket = process.env['AWS_S3_BUCKET'];
  const region = process.env['AWS_REGION'] ?? 'us-east-1';

  if (!bucket) {
    logger.warn('AWS_S3_BUCKET not set — screenshot not uploaded');
    return null;
  }

  try {
    // Dynamic import to avoid requiring AWS SDK when not configured
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

    const s3 = new S3Client({ region });
    const key = `screenshots/${new Date().getFullYear()}/${filename}`;

    await s3.send(new PutObjectCommand({
      Bucket:      bucket,
      Key:         key,
      Body:        buffer,
      ContentType: 'image/jpeg',
    }));

    return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  } catch (err) {
    logger.warn('S3 upload failed', { filename, error: String(err) });
    return null;
  }
}
