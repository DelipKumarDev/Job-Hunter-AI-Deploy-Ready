// ============================================================
// Multi-Step Form Handler
// Navigates multi-step job application forms end-to-end.
//
// Step loop:
//  1. Detect current step's fields
//  2. Fill text/select/radio/checkbox fields
//  3. Upload files (resume, cover letter)
//  4. Validate: check for inline errors
//  5. If errors → attempt recovery (re-fill errored fields)
//  6. Click Next / Continue / Submit
//  7. Wait for page transition / new fields to appear
//  8. Repeat until submission confirmed or max steps hit
//
// Review page: human-scroll to read, then confirm/submit
// ============================================================

import type { Page } from 'playwright';
import type { CandidateFormData, FormStep } from '../types/botTypes.js';
import { detectFormFields } from '../detectors/formDetector.js';
import { fillAllFields }    from './formFiller.js';
import { uploadAllFiles }   from './fileUploader.js';
import { humanClickLocator, humanScroll, sleep, moveMouse } from '../humanizer/humanBehavior.js';
import { logger } from '../utils/logger.js';

const MAX_STEPS        = 15;   // Safety cap
const STEP_TIMEOUT_MS  = 30000;
const TRANSITION_DELAY = 1500; // ms to wait after clicking Next

// ── Button text patterns ──────────────────────────────────────
const NEXT_BTN_SELECTORS = [
  'button:has-text("Next")',
  'button:has-text("Continue")',
  'button:has-text("Next Step")',
  'button:has-text("Save & Continue")',
  'button:has-text("Save and Continue")',
  'button:has-text("Proceed")',
  'input[type="submit"][value*="Next"]',
  'input[type="submit"][value*="Continue"]',
  '[data-testid="next-button"]',
  '[data-automation-id="bottom-navigation-next-button"]',
  '.next-button',
  '#next-button',
];

const SUBMIT_BTN_SELECTORS = [
  'button:has-text("Submit Application")',
  'button:has-text("Submit")',
  'button:has-text("Apply")',
  'button:has-text("Apply Now")',
  'button:has-text("Send Application")',
  'button:has-text("Complete Application")',
  'button:has-text("Finish")',
  'input[type="submit"][value*="Submit"]',
  'input[type="submit"][value*="Apply"]',
  '[data-testid="submit-button"]',
  '[data-automation-id="submit-application-button"]',
  '#submit-button',
  '.submit-button',
];

const REVIEW_BTN_SELECTORS = [
  'button:has-text("Review")',
  'button:has-text("Review Application")',
  'button:has-text("Preview")',
  'button:has-text("Confirm")',
];

// ─────────────────────────────────────────────────────────────
// MAIN STEP LOOP
// ─────────────────────────────────────────────────────────────
export interface StepLoopResult {
  stepsCompleted: number;
  fieldsFilled:   number;
  submitted:      boolean;
  warnings:       string[];
  error?:         string;
}

export async function runStepLoop(
  page:      Page,
  candidate: CandidateFormData,
): Promise<StepLoopResult> {

  let stepsCompleted = 0;
  let totalFilled    = 0;
  const warnings: string[] = [];

  for (let attempt = 0; attempt < MAX_STEPS; attempt++) {
    logger.info(`Processing form step ${stepsCompleted + 1}`, { attempt });

    // ── Detect all fields on current step ────────────────
    const step = await detectFormFields(page);
    logger.info(`Step ${step.stepNumber}: ${step.fields.length} fields detected`, {
      title:  step.title,
      total:  step.totalSteps,
      review: step.isReview,
    });

    // ── Handle review/confirmation page ──────────────────
    if (step.isReview || (step.fields.length === 0 && step.stepNumber > 1)) {
      logger.info('Review page detected — scrolling then submitting');
      await handleReviewPage(page);

      const submitted = await clickSubmitButton(page);
      if (submitted) {
        stepsCompleted++;
        return { stepsCompleted, fieldsFilled: totalFilled, submitted: true, warnings };
      }
    }

    // ── Fill text/select/radio/checkbox fields ────────────
    if (step.fields.length > 0) {
      const { filled, warnings: fw } = await fillAllFields(page, step.fields, candidate);
      totalFilled += filled;
      warnings.push(...fw);

      // Small pause after filling all fields (like a human reviewing)
      await sleep(800 + Math.random() * 1200);

      // ── Upload files ──────────────────────────────────
      const uploadResults = await uploadAllFiles(page, step.fields, candidate);
      for (const r of uploadResults) {
        if (!r.success) warnings.push(`Upload failed: ${r.field} — ${r.error}`);
      }

      await sleep(500 + Math.random() * 800);
    }

    // ── Check for inline validation errors ───────────────
    const errors = await detectValidationErrors(page);
    if (errors.length > 0) {
      logger.warn(`Validation errors on step ${step.stepNumber}`, { errors });
      const recovered = await recoverFromErrors(page, errors, step, candidate);
      if (!recovered) {
        warnings.push(`Could not recover from validation errors: ${errors.join(', ')}`);
      }
      await sleep(600);
    }

    // ── Attempt to proceed to next step ──────────────────
    const advanced = await advanceStep(page, step);

    if (advanced === 'submitted') {
      stepsCompleted++;
      return { stepsCompleted, fieldsFilled: totalFilled, submitted: true, warnings };
    }

    if (advanced === 'next') {
      stepsCompleted++;
      // Wait for transition: URL change or new DOM content
      await waitForStepTransition(page, step.stepNumber);
      continue;
    }

    // Couldn't advance — log and stop
    logger.warn('Could not advance to next step', { stepNumber: step.stepNumber });
    warnings.push(`Stuck on step ${step.stepNumber}`);
    return { stepsCompleted, fieldsFilled: totalFilled, submitted: false, warnings,
             error: 'Could not advance past step' };
  }

  return {
    stepsCompleted,
    fieldsFilled:  totalFilled,
    submitted:     false,
    warnings,
    error: `Exceeded max steps (${MAX_STEPS})`,
  };
}

// ─────────────────────────────────────────────────────────────
// ADVANCE STEP — click Next, Review, or Submit
// ─────────────────────────────────────────────────────────────
async function advanceStep(
  page: Page,
  step: FormStep,
): Promise<'next' | 'submitted' | 'stuck'> {

  // Scroll to bottom to reveal buttons
  await humanScroll(page, 400);
  await sleep(500);

  // Try submit first if we think this is the last step
  if (!step.hasNextBtn || step.isReview) {
    for (const sel of SUBMIT_BTN_SELECTORS) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
          // Scroll to center button in view
          await el.scrollIntoViewIfNeeded();
          await sleep(600 + Math.random() * 400);

          // Human-like review scroll before final submit
          await simulateFormReview(page);

          await humanClickLocator(page, sel);
          await sleep(2000);
          return 'submitted';
        }
      } catch { continue; }
    }
  }

  // Try Next / Continue
  for (const sel of NEXT_BTN_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        const isDisabled = await el.isDisabled().catch(() => false);
        if (isDisabled) continue;

        await el.scrollIntoViewIfNeeded();
        await sleep(400 + Math.random() * 300);
        await humanClickLocator(page, sel);
        await sleep(500);
        return 'next';
      }
    } catch { continue; }
  }

  // Try Review button
  for (const sel of REVIEW_BTN_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await humanClickLocator(page, sel);
        await sleep(1500);
        return 'next';
      }
    } catch { continue; }
  }

  return 'stuck';
}

// ─────────────────────────────────────────────────────────────
// CLICK SUBMIT BUTTON
// ─────────────────────────────────────────────────────────────
async function clickSubmitButton(page: Page): Promise<boolean> {
  for (const sel of SUBMIT_BTN_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        const isDisabled = await el.isDisabled().catch(() => false);
        if (isDisabled) continue;
        await el.scrollIntoViewIfNeeded();
        await sleep(600);
        await humanClickLocator(page, sel);
        await sleep(2500);
        return true;
      }
    } catch { continue; }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// WAIT FOR STEP TRANSITION
// Detects URL change, new fields appearing, or spinner gone
// ─────────────────────────────────────────────────────────────
async function waitForStepTransition(page: Page, prevStep: number): Promise<void> {
  const startUrl = page.url();

  try {
    // Wait up to 8s for either URL change OR new content
    await Promise.race([
      page.waitForURL(url => url.toString() !== startUrl, { timeout: 8000 }),
      page.waitForFunction(
        (step: number) => {
          // Look for step indicator increment
          const stepText = document.body.innerText;
          return new RegExp(`step\\s*${step + 1}`, 'i').test(stepText);
        },
        prevStep,
        { timeout: 8000 }
      ),
      page.waitForLoadState('networkidle', { timeout: 8000 }),
    ]).catch(() => null);

  } catch { /* timeout is OK — continue anyway */ }

  // Always wait minimum delay for DOM to settle
  await sleep(TRANSITION_DELAY + Math.random() * 500);
}

// ─────────────────────────────────────────────────────────────
// HANDLE REVIEW PAGE
// Scroll through to simulate reading, then locate submit
// ─────────────────────────────────────────────────────────────
async function handleReviewPage(page: Page): Promise<void> {
  logger.debug('Simulating review page read');

  // Get page height and scroll through in sections
  const height = await page.evaluate(() => document.body.scrollHeight);
  const sections = Math.ceil(height / 600);

  for (let i = 0; i < Math.min(sections, 5); i++) {
    await humanScroll(page, 550 + Math.random() * 100);
    await sleep(800 + Math.random() * 600);

    // Occasional mouse movement (reading behavior)
    const x = 200 + Math.random() * 600;
    const y = 200 + i * 100;
    await moveMouse(page, x, y);
  }

  // Scroll back to top to read from beginning one more time
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await sleep(1000);
}

// ─────────────────────────────────────────────────────────────
// SIMULATE FORM REVIEW (before final submit)
// ─────────────────────────────────────────────────────────────
async function simulateFormReview(page: Page): Promise<void> {
  // Scroll up, pause, scroll back down to submit button
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await sleep(600 + Math.random() * 400);
  await humanScroll(page, 300 + Math.random() * 200);
  await sleep(400 + Math.random() * 300);
  await humanScroll(page, 500 + Math.random() * 300);
  await sleep(500 + Math.random() * 400);
}

// ─────────────────────────────────────────────────────────────
// DETECT VALIDATION ERRORS
// ─────────────────────────────────────────────────────────────
async function detectValidationErrors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const errorSelectors = [
      '.error-message', '.field-error', '.validation-error',
      '[class*="error"]:not(input):not(select)', '[class*="invalid"]',
      '[aria-invalid="true"]', '.help-inline.error',
      '[data-error]', '.alert-danger',
    ];

    const errors: string[] = [];
    for (const sel of errorSelectors) {
      document.querySelectorAll(sel).forEach(el => {
        const rect = el.getBoundingClientRect();
        const text = el.textContent?.trim() ?? '';
        if (rect.width > 0 && text.length > 0 && text.length < 200) {
          errors.push(text);
        }
      });
    }

    // HTML5 native validation
    document.querySelectorAll(':invalid').forEach(el => {
      const input  = el as HTMLInputElement;
      const label  = document.querySelector(`label[for="${input.id}"]`)?.textContent?.trim() ?? input.name;
      if (input.validationMessage) {
        errors.push(`${label}: ${input.validationMessage}`);
      }
    });

    return [...new Set(errors)]; // dedupe
  });
}

// ─────────────────────────────────────────────────────────────
// RECOVER FROM VALIDATION ERRORS
// Re-detect fields, attempt to re-fill the ones with errors
// ─────────────────────────────────────────────────────────────
async function recoverFromErrors(
  page:      Page,
  errors:    string[],
  step:      FormStep,
  candidate: CandidateFormData,
): Promise<boolean> {
  logger.debug('Attempting error recovery', { errorCount: errors.length });

  // Scroll to first error
  await page.evaluate(() => {
    const errEl = document.querySelector('[class*="error"], [aria-invalid="true"], :invalid');
    if (errEl) errEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  await sleep(600);

  // Re-detect and re-fill fields (DOM may have updated with error states)
  const updatedStep = await detectFormFields(page);
  const invalidFields = updatedStep.fields.filter(f =>
    // target fields that are required and likely empty
    f.isRequired && (!f.currentValue || f.currentValue.trim() === '')
  );

  if (invalidFields.length === 0) return false;

  const { filled } = await fillAllFields(page, invalidFields, candidate);
  return filled > 0;
}
