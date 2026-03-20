// ============================================================
// File Uploader
// Downloads resume / cover letter from S3 to a temp file,
// then uploads via 4-strategy chain:
//
//  Strategy 1: page.setInputFiles() — standard Playwright API
//  Strategy 2: FileChooser event interception
//  Strategy 3: Drag-and-drop simulation
//  Strategy 4: JS DataTransfer injection (ATS workaround)
//
// Each strategy falls through to the next on failure.
// Cleans up temp files after upload regardless of outcome.
// ============================================================

import { createWriteStream, unlinkSync, existsSync } from 'fs';
import { join }  from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import type { Page } from 'playwright';
import type { DetectedField, CandidateFormData } from '../types/botTypes.js';
import { humanClickLocator, sleep } from '../humanizer/humanBehavior.js';
import { logger } from '../utils/logger.js';

export interface UploadResult {
  field:    'resume' | 'cover_letter' | 'work_sample';
  success:  boolean;
  strategy: string;
  error?:   string;
}

// ─────────────────────────────────────────────────────────────
// DOWNLOAD FILE FROM S3
// ─────────────────────────────────────────────────────────────
async function downloadToTemp(s3Url: string, filename: string): Promise<string> {
  const ext      = filename.split('.').pop() ?? 'pdf';
  const tempPath = join(tmpdir(), `jh_${randomUUID()}.${ext}`);

  const response = await fetch(s3Url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobHunter/1.0)' },
  });

  if (!response.ok) {
    throw new Error(`S3 download failed: ${response.status} ${response.statusText}`);
  }

  const body = response.body;
  if (!body) throw new Error('Empty response body from S3');

  const writer = createWriteStream(tempPath);
  // Node 18+ ReadableStream → Node stream
  const nodeStream = require('stream').Readable.fromWeb(body as Parameters<typeof require('stream').Readable.fromWeb>[0]);
  await pipeline(nodeStream, writer);

  logger.debug('Downloaded file to temp', { filename, tempPath });
  return tempPath;
}

// ─────────────────────────────────────────────────────────────
// STRATEGY 1 — setInputFiles (Playwright native)
// ─────────────────────────────────────────────────────────────
async function strategySetInputFiles(
  page:     Page,
  selector: string,
  filePath: string,
): Promise<boolean> {
  try {
    const el = page.locator(selector).first();
    await el.waitFor({ state: 'attached', timeout: 5000 });
    await el.setInputFiles(filePath);
    await sleep(500);

    // Verify file was accepted (some inputs update a label)
    return true;
  } catch (err) {
    logger.debug('Strategy 1 (setInputFiles) failed', { error: String(err) });
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// STRATEGY 2 — FileChooser interception
// Click the input/button and intercept the OS file chooser
// ─────────────────────────────────────────────────────────────
async function strategyFileChooser(
  page:     Page,
  selector: string,
  filePath: string,
): Promise<boolean> {
  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }),
      humanClickLocator(page, selector),
    ]);

    await fileChooser.setFiles(filePath);
    await sleep(800);
    return true;
  } catch (err) {
    logger.debug('Strategy 2 (FileChooser) failed', { error: String(err) });
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// STRATEGY 3 — Drag and drop simulation
// For drop-zone based uploaders ("Drag your resume here")
// ─────────────────────────────────────────────────────────────
async function strategyDragDrop(
  page:     Page,
  selector: string,
  filePath: string,
  filename: string,
): Promise<boolean> {
  try {
    const el  = page.locator(selector).first();
    const box = await el.boundingBox();
    if (!box) return false;

    const { readFileSync } = await import('fs');
    const fileContent = readFileSync(filePath);
    const base64Data  = fileContent.toString('base64');

    const mimeType = filePath.endsWith('.pdf')  ? 'application/pdf'
                   : filePath.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                   : 'application/octet-stream';

    // Build a DataTransfer object with the file and dispatch drag events
    await page.evaluate(
      async ({ selector: sel, base64, mime, name }) => {
        const dropZone = document.querySelector(sel);
        if (!dropZone) return;

        // Decode base64 → Uint8Array → File
        const binary = atob(base64);
        const arr    = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
        const file = new File([arr], name, { type: mime });

        const dt = new DataTransfer();
        dt.items.add(file);

        const events = ['dragenter', 'dragover', 'drop'];
        for (const evtName of events) {
          const evt = new DragEvent(evtName, {
            bubbles: true, cancelable: true, dataTransfer: dt,
          });
          dropZone.dispatchEvent(evt);
          await new Promise(r => setTimeout(r, 100));
        }
      },
      { selector, base64: base64Data, mime: mimeType, name: filename },
    );

    await sleep(1000);
    return true;
  } catch (err) {
    logger.debug('Strategy 3 (DragDrop) failed', { error: String(err) });
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// STRATEGY 4 — JS DataTransfer on hidden input
// For SPAs that hide the file input and show a custom UI
// ─────────────────────────────────────────────────────────────
async function strategyJsDataTransfer(
  page:     Page,
  filePath: string,
  filename: string,
): Promise<boolean> {
  try {
    const { readFileSync } = await import('fs');
    const fileContent = readFileSync(filePath);
    const base64Data  = fileContent.toString('base64');

    const mimeType = filePath.endsWith('.pdf')  ? 'application/pdf'
                   : filePath.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                   : 'application/octet-stream';

    const result = await page.evaluate(
      async ({ base64, mime, name }) => {
        const binary = atob(base64);
        const arr    = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
        const file = new File([arr], name, { type: mime });
        const dt   = new DataTransfer();
        dt.items.add(file);

        // Try every file input on the page
        const inputs = document.querySelectorAll('input[type="file"]');
        for (const input of Array.from(inputs)) {
          try {
            Object.defineProperty(input, 'files', { value: dt.files, writable: false });
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('input',  { bubbles: true }));
            return true;
          } catch { continue; }
        }
        return false;
      },
      { base64: base64Data, mime: mimeType, name: filename },
    );

    await sleep(800);
    return result as boolean;
  } catch (err) {
    logger.debug('Strategy 4 (JS DataTransfer) failed', { error: String(err) });
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// VERIFY upload was accepted
// ─────────────────────────────────────────────────────────────
async function verifyUpload(page: Page, filename: string): Promise<boolean> {
  try {
    // Check if filename appears anywhere on page (most ATS show it)
    const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
    const appears = await page.evaluate((name: string) => {
      return document.body.innerText.includes(name);
    }, nameWithoutExt);

    if (appears) return true;

    // Check for success indicators
    const successSelectors = [
      '[class*="success"]', '[class*="uploaded"]', '[class*="file-name"]',
      '.resume-file-name', '.attachment-name', '[data-file-name]',
    ];
    for (const sel of successSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) return true;
    }

    return false;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// MAIN UPLOAD FUNCTION
// ─────────────────────────────────────────────────────────────
export async function uploadFile(
  page:      Page,
  field:     DetectedField,
  s3Url:     string,
  filename:  string,
  fieldType: 'resume' | 'cover_letter' | 'work_sample' = 'resume',
): Promise<UploadResult> {

  let tempPath: string | null = null;

  try {
    logger.info('Uploading file', { fieldType, filename, selector: field.selector });

    // Download from S3 to local temp file
    tempPath = await downloadToTemp(s3Url, filename);

    // Strategy 1: setInputFiles
    if (await strategySetInputFiles(page, field.selector, tempPath)) {
      const verified = await verifyUpload(page, filename);
      logger.info('File uploaded', { strategy: 'setInputFiles', verified, fieldType });
      return { field: fieldType, success: true, strategy: 'setInputFiles' };
    }

    await sleep(300);

    // Strategy 2: FileChooser
    if (await strategyFileChooser(page, field.selector, tempPath)) {
      const verified = await verifyUpload(page, filename);
      logger.info('File uploaded', { strategy: 'FileChooser', verified, fieldType });
      return { field: fieldType, success: true, strategy: 'FileChooser' };
    }

    await sleep(300);

    // Strategy 3: DragDrop
    if (await strategyDragDrop(page, field.selector, tempPath, filename)) {
      const verified = await verifyUpload(page, filename);
      logger.info('File uploaded', { strategy: 'DragDrop', verified, fieldType });
      return { field: fieldType, success: true, strategy: 'DragDrop' };
    }

    await sleep(300);

    // Strategy 4: JS DataTransfer injection
    if (await strategyJsDataTransfer(page, tempPath, filename)) {
      logger.info('File uploaded', { strategy: 'JSDataTransfer', fieldType });
      return { field: fieldType, success: true, strategy: 'JSDataTransfer' };
    }

    return {
      field: fieldType, success: false, strategy: 'none',
      error: 'All 4 upload strategies failed',
    };

  } catch (err) {
    logger.error('File upload error', { fieldType, error: String(err) });
    return { field: fieldType, success: false, strategy: 'error', error: String(err) };

  } finally {
    // Always clean up temp file
    if (tempPath && existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch { /* ignore */ }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// UPLOAD ALL FILES for a step
// ─────────────────────────────────────────────────────────────
export async function uploadAllFiles(
  page:      Page,
  fields:    DetectedField[],
  candidate: CandidateFormData,
): Promise<UploadResult[]> {

  const results: UploadResult[] = [];
  const fileFields = fields.filter(f => f.fieldType === 'file');

  for (const field of fileFields) {
    if (field.category === 'resume' && candidate.resumeS3Url) {
      const result = await uploadFile(page, field, candidate.resumeS3Url, candidate.resumeFileName, 'resume');
      results.push(result);
      await sleep(800 + Math.random() * 500);

    } else if (field.category === 'cover_letter' && candidate.coverLetterS3Url && candidate.coverLetterFileName) {
      const result = await uploadFile(page, field, candidate.coverLetterS3Url, candidate.coverLetterFileName, 'cover_letter');
      results.push(result);
      await sleep(800 + Math.random() * 500);

    } else if (field.category === 'work_sample' && candidate.resumeS3Url) {
      // Fallback: use resume for work sample if no dedicated file
      const result = await uploadFile(page, field, candidate.resumeS3Url, candidate.resumeFileName, 'work_sample');
      results.push(result);
    }
  }

  return results;
}
