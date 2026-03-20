/**
 * ============================================================
 * Application Bot — Main Orchestrator
 * 9-stage pipeline for autonomous job application.
 *
 * Stealth stack integrated via browser-factory.ts:
 *   playwright-extra + stealth plugin + fingerprint profiles + proxy rotation
 *
 * Additional protection layers:
 *   • captcha-detector.ts — detects and pauses on all captcha types
 *   • rate-limiter.ts     — per-portal sliding-window throttling
 * ============================================================
 */

import type { Page } from 'playwright';
import { PrismaClient } from '@prisma/client';

// ── Stealth layer ─────────────────────────────────────────────
import {
  BrowserFactory,
  type BotSession,
  type StealthSession,
} from '../stealth/browser-factory.js';
import {
  assertNoCaptcha,
  waitForCaptchaResolution,
  CaptchaDetectedError,
} from '../stealth/captcha-detector.js';
import { getRateLimiter } from '../stealth/rate-limiter.js';

// ── Existing pipeline modules ─────────────────────────────────
import { detectApplyButton }                    from '../detectors/applyButtonDetector.js';
import { runStepLoop }                          from './multiStepHandler.js';
import { getAdapter, detectAlreadyApplied }     from '../adapters/platformAdapters.js';
import { humanClickLocator, readingPause, sleep, humanScroll } from '../humanizer/humanBehavior.js';
import { loadCandidate }                        from '../processors/candidateLoader.js';
import { takeScreenshot }                       from '../utils/screenshotManager.js';
import { logger }                               from '../utils/logger.js';
import type { BotJobPayload, BotRunResult, ApplicationStatus } from '../types/botTypes.js';

// ── Singletons ────────────────────────────────────────────────
const factory     = BrowserFactory.getInstance();
const rateLimiter = getRateLimiter();

export class ApplicationBot {
  constructor(private readonly prisma: PrismaClient) {}

  // ── Main entry point ───────────────────────────────────────
  async run(payload: BotJobPayload): Promise<BotRunResult> {
    const { userId, applicationId, jobListingId, applyUrl, resumeId } = payload;
    const sessionId = `bot_${applicationId}_${Date.now()}`;
    const startMs   = Date.now();

    const result: BotRunResult = {
      sessionId,
      status:         'starting',
      screenshotUrl:  null,
      fieldsDetected: 0,
      fieldsFilled:   0,
      stepsCompleted: 0,
      durationMs:     0,
      error:          null,
      warnings:       [],
    };

    let session: BotSession | null = null;

    try {
      // ──────────────────────────────────────────────────────
      // STAGE 1: Launch stealth browser
      // Uses BrowserFactory — playwright-extra + stealth plugin
      // + fingerprint profile + proxy rotation
      // ──────────────────────────────────────────────────────
      logger.info('Bot stage 1: launching stealth browser', { sessionId, applyUrl });
      await this.updateApplicationStatus(applicationId, 'starting');

      session = await factory.createSession(sessionId);

      // ──────────────────────────────────────────────────────
      // STAGE 2: Navigate to job URL with rate limiting
      // ──────────────────────────────────────────────────────
      logger.info('Bot stage 2: navigating to job URL', { applyUrl });
      await this.updateApplicationStatus(applicationId, 'navigating');

      // Respect portal rate limits before loading the page
      await rateLimiter.wait(applyUrl, 'navigate');

      const navStart = Date.now();
      await session.page.goto(applyUrl, {
        waitUntil: 'domcontentloaded',
        timeout:   45_000,
      });
      factory.markProxySuccess(session, Date.now() - navStart);

      // ── Check for Cloudflare / challenge page immediately ──
      await assertNoCaptcha(session.page);

      // Human reading pause: scroll + time as if reading JD
      await readingPause(session.page, 250);

      // ──────────────────────────────────────────────────────
      // STAGE 3: Already-applied check
      // ──────────────────────────────────────────────────────
      if (await detectAlreadyApplied(session.page, applyUrl)) {
        logger.info('Already applied to this job — skipping', { applyUrl });
        result.status = 'already_applied';
        result.durationMs = Date.now() - startMs;
        await this.updateApplicationStatus(applicationId, 'already_applied');
        return result;
      }

      // ──────────────────────────────────────────────────────
      // STAGE 4: Load candidate data
      // ──────────────────────────────────────────────────────
      const candidate = await loadCandidate(
        this.prisma, userId, resumeId, payload.coverLetterId,
      );
      logger.info('Candidate loaded', { name: candidate.fullName });

      // ──────────────────────────────────────────────────────
      // STAGE 5: Detect apply button and click
      // ──────────────────────────────────────────────────────
      logger.info('Bot stage 5: detecting apply button');
      await this.updateApplicationStatus(applicationId, 'detecting_form');

      const applyBtn = await detectApplyButton(session.page);
      if (!applyBtn) {
        throw new Error('Apply button not found on page');
      }

      logger.info('Apply button detected', {
        text:        applyBtn.text,
        method:      applyBtn.method,
        confidence:  applyBtn.confidence,
        isEasyApply: applyBtn.isEasyApply,
      });

      await takeScreenshot(session.page, applicationId, 'pre_apply');

      // Rate-limit before clicking
      await rateLimiter.wait(applyUrl, 'click');

      if (applyBtn.opensNewTab) {
        const newPagePromise = session.context.waitForEvent('page');
        await humanClickLocator(session.page, applyBtn.selector);
        const newPage = await newPagePromise;
        await newPage.waitForLoadState('domcontentloaded');
        session = { ...session, page: newPage };
      } else {
        await humanClickLocator(session.page, applyBtn.selector);
      }

      await sleep(1500 + Math.random() * 1000);

      // ── Check for captcha after clicking apply ─────────────
      await assertNoCaptcha(session.page);

      // ──────────────────────────────────────────────────────
      // STAGE 6: Platform adapter setup
      // ──────────────────────────────────────────────────────
      const adapter = getAdapter(session.page.url() || applyUrl);
      logger.info('Bot stage 6: platform adapter prepare', { adapter: adapter.name });
      await adapter.prepare(session.page);

      // ──────────────────────────────────────────────────────
      // STAGE 7: Run form step loop (with per-step captcha + rate checks)
      // ──────────────────────────────────────────────────────
      logger.info('Bot stage 7: running step loop');
      await this.updateApplicationStatus(applicationId, 'filling_form');

      const stepResult = await this.runStepLoopWithGuards(
        session.page,
        candidate,
        applyUrl,
      );

      result.stepsCompleted = stepResult.stepsCompleted;
      result.fieldsFilled   = stepResult.fieldsFilled;
      result.warnings.push(...stepResult.warnings);

      // ──────────────────────────────────────────────────────
      // STAGE 8: Confirm submission
      // ──────────────────────────────────────────────────────
      logger.info('Bot stage 8: confirming submission');

      let confirmed = stepResult.submitted;
      if (!confirmed) {
        await sleep(2000);
        confirmed = await adapter.isConfirmed(session.page);
      }

      if (confirmed) {
        const screenshotUrl = await takeScreenshot(session.page, applicationId, 'success');
        result.screenshotUrl = screenshotUrl;
        result.status        = 'applied';

        // Post-submission rate-limit pause
        await rateLimiter.postSubmitPause(applyUrl);

        // ── STAGE 9: Update DB to APPLIED ──────────────────
        await this.markApplied(applicationId, {
          screenshotUrl,
          fieldsDetected: result.fieldsDetected,
          fieldsFilled:   result.fieldsFilled,
          stepsCompleted: result.stepsCompleted,
          warnings:       result.warnings,
        });

        logger.info('Application submitted successfully', {
          applicationId,
          jobListingId,
          steps:  result.stepsCompleted,
          fields: result.fieldsFilled,
          proxy:  session.proxyLabel,
        });

      } else {
        const screenshotUrl = await takeScreenshot(session.page, applicationId, 'unconfirmed');
        result.screenshotUrl = screenshotUrl;
        result.status  = 'failed';
        result.error   = stepResult.error ?? 'Submission not confirmed';
        result.warnings.push('Submission confirmation page not detected');
        await this.markFailed(applicationId, result.error, screenshotUrl);
      }

    } catch (err) {
      // ── Captcha special handling ──────────────────────────
      if (err instanceof CaptchaDetectedError) {
        logger.warn('Bot: captcha challenge — queuing retry', {
          vendor:    err.detection.vendor,
          sessionId,
        });
        result.status = 'failed';
        result.error  = `captcha:${err.detection.vendor}`;
        // Don't take screenshot — it would capture the captcha challenge and waste S3
        await this.markFailed(applicationId, result.error, null).catch(() => null);

      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Mark proxy as failed only for network-level errors
        if (session && this.isNetworkError(errMsg)) {
          factory.markProxyFailure(session);
        }

        logger.error('Bot run failed', { sessionId, error: errMsg });
        result.status = 'failed';
        result.error  = errMsg;

        if (session) {
          try {
            result.screenshotUrl = await takeScreenshot(session.page, applicationId, 'error');
          } catch { /* screenshot failed */ }
        }
        await this.markFailed(applicationId, errMsg, result.screenshotUrl).catch(() => null);
      }

    } finally {
      if (session) await factory.closeSession(session).catch(() => null);
      result.durationMs = Date.now() - startMs;
    }

    return result;
  }

  // ── Step loop with integrated guards ──────────────────────

  private async runStepLoopWithGuards(
    page:      Page,
    candidate: Awaited<ReturnType<typeof loadCandidate>>,
    baseUrl:   string,
  ): Promise<Awaited<ReturnType<typeof runStepLoop>>> {
    // Intercept runStepLoop's internal step transitions to add
    // per-step captcha checks and rate limiting.
    // We wrap the call and check captcha after each navigate event.

    const originalGoto = page.goto.bind(page);
    page.goto = async (url, opts) => {
      await rateLimiter.wait(url ?? baseUrl, 'navigate');
      const response = await originalGoto(url, opts);
      await assertNoCaptcha(page);
      return response;
    };

    try {
      return await runStepLoop(page, candidate);
    } finally {
      // Restore original goto
      page.goto = originalGoto;
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  private isNetworkError(msg: string): boolean {
    return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_PROXY|ERR_TUNNEL|net::ERR/i.test(msg);
  }

  private async updateApplicationStatus(
    applicationId: string,
    status: ApplicationStatus,
  ): Promise<void> {
    try {
      await this.prisma.application.update({
        where: { id: applicationId },
        data:  { status: status.toUpperCase() as any },
      });
    } catch (err) {
      logger.warn('Failed to update application status', {
        applicationId, status, error: (err as Error).message,
      });
    }
  }

  private async markApplied(
    applicationId: string,
    meta: {
      screenshotUrl:  string | null;
      fieldsDetected: number;
      fieldsFilled:   number;
      stepsCompleted: number;
      warnings:       string[];
    },
  ): Promise<void> {
    await this.prisma.application.update({
      where: { id: applicationId },
      data: {
        status:        'APPLIED',
        appliedAt:     new Date(),
        screenshotUrl: meta.screenshotUrl,
        customAnswers: {
          fieldsDetected: meta.fieldsDetected,
          fieldsFilled:   meta.fieldsFilled,
          stepsCompleted: meta.stepsCompleted,
          warnings:       meta.warnings,
        },
      },
    });
  }

  private async markFailed(
    applicationId: string,
    error:         string,
    screenshotUrl: string | null,
  ): Promise<void> {
    await this.prisma.application.update({
      where: { id: applicationId },
      data: {
        status:        'FAILED',
        screenshotUrl,
        customAnswers: { error },
      },
    }).catch(e => logger.error('markFailed DB error', { error: (e as Error).message }));
  }
}
