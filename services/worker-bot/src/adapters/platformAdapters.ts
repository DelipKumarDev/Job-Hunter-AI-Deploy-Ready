// ============================================================
// Platform Adapters
// Each adapter wraps platform-specific pre/post-apply logic.
//
// All adapters expose:
//   prepare(page)    → platform-specific setup before form
//   isConfirmed(page)→ detect successful application
//   getApplyUrl(job) → resolve final URL to navigate to
//
// Supported:
//   LinkedIn Easy Apply (in-modal), Indeed, Greenhouse,
//   Lever, Workday, Ashby, generic
// ============================================================

import type { Page } from 'playwright';
import { humanClickLocator, sleep, humanScroll } from '../humanizer/humanBehavior.js';
import { logger } from '../utils/logger.js';

export type PlatformAdapter = {
  name:         string;
  matches:      (url: string) => boolean;
  prepare:      (page: Page) => Promise<void>;
  isConfirmed:  (page: Page) => Promise<boolean>;
};

// ─────────────────────────────────────────────────────────────
// LINKEDIN EASY APPLY
// Opens a modal — the form is inside it, not the full page
// ─────────────────────────────────────────────────────────────
const linkedinAdapter: PlatformAdapter = {
  name: 'LinkedIn',
  matches: (url) => /linkedin\.com/i.test(url),

  prepare: async (page) => {
    logger.debug('LinkedIn adapter: preparing');

    // Wait for modal to open after apply button click
    try {
      await page.waitForSelector(
        '.jobs-easy-apply-modal, .artdeco-modal, [aria-label*="Apply"]',
        { timeout: 8000 }
      );
      await sleep(800);
    } catch {
      logger.debug('LinkedIn: no modal detected, proceeding with full page');
    }

    // Dismiss cookie banner if present
    await humanClickLocator(page, 'button[action-type="DENY"], .artdeco-global-alert__dismiss')
      .catch(() => null);
  },

  isConfirmed: async (page) => {
    try {
      // Success modal shows "Your application was sent"
      const successText = await page.evaluate(() =>
        document.body.innerText.includes('application was sent') ||
        document.body.innerText.includes('You applied') ||
        document.body.innerText.includes('Application submitted') ||
        !!document.querySelector('.artdeco-inline-feedback--success, [data-test-id="easy-apply-success"]')
      );
      return successText;
    } catch {
      return false;
    }
  },
};

// ─────────────────────────────────────────────────────────────
// INDEED
// ─────────────────────────────────────────────────────────────
const indeedAdapter: PlatformAdapter = {
  name: 'Indeed',
  matches: (url) => /indeed\.com/i.test(url),

  prepare: async (page) => {
    logger.debug('Indeed adapter: preparing');
    // Accept cookies if banner appears
    await humanClickLocator(page, '#onetrust-accept-btn-handler, button[id*="cookie-accept"]')
      .catch(() => null);
    await sleep(500);

    // Indeed may show "Continue" before the actual form
    const continueBtn = page.locator('button:has-text("Continue"), a:has-text("Continue to apply")').first();
    if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await humanClickLocator(page, 'button:has-text("Continue"), a:has-text("Continue to apply")');
      await sleep(1000);
    }
  },

  isConfirmed: async (page) => {
    try {
      return await page.evaluate(() =>
        document.body.innerText.includes('application has been submitted') ||
        document.body.innerText.includes('application was submitted') ||
        document.body.innerText.includes('Your application is complete') ||
        !!document.querySelector('[data-tn-component="jobApplicationSubmissionConfirmation"]')
      );
    } catch {
      return false;
    }
  },
};

// ─────────────────────────────────────────────────────────────
// GREENHOUSE
// ─────────────────────────────────────────────────────────────
const greenhouseAdapter: PlatformAdapter = {
  name: 'Greenhouse',
  matches: (url) => /greenhouse\.io/i.test(url),

  prepare: async (page) => {
    logger.debug('Greenhouse adapter: preparing');
    // Greenhouse forms load instantly — just wait for form
    await page.waitForSelector('form#application-form, #application_form, form.application', {
      timeout: 10000,
    }).catch(() => null);
    await sleep(600);
  },

  isConfirmed: async (page) => {
    try {
      return await page.evaluate(() =>
        document.body.innerText.includes('application has been received') ||
        document.body.innerText.includes('Thank you for applying') ||
        document.body.innerText.includes('application was submitted') ||
        !!document.querySelector('.confirmation-message, #confirmation')
      );
    } catch {
      return false;
    }
  },
};

// ─────────────────────────────────────────────────────────────
// LEVER
// ─────────────────────────────────────────────────────────────
const leverAdapter: PlatformAdapter = {
  name: 'Lever',
  matches: (url) => /lever\.co/i.test(url),

  prepare: async (page) => {
    logger.debug('Lever adapter: preparing');
    await page.waitForSelector('.application-form, form[action*="apply"]', {
      timeout: 10000,
    }).catch(() => null);
    await sleep(500);
  },

  isConfirmed: async (page) => {
    try {
      return await page.evaluate(() =>
        document.body.innerText.includes('application has been received') ||
        document.body.innerText.includes('Thank you for applying') ||
        !!document.querySelector('.confirmation, .success-message')
      );
    } catch {
      return false;
    }
  },
};

// ─────────────────────────────────────────────────────────────
// WORKDAY
// ─────────────────────────────────────────────────────────────
const workdayAdapter: PlatformAdapter = {
  name: 'Workday',
  matches: (url) => /myworkdayjobs\.com|workday\.com/i.test(url),

  prepare: async (page) => {
    logger.debug('Workday adapter: preparing');

    // Workday needs full React render
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    await sleep(1500);

    // Handle "Sign In" prompt — skip to apply as guest if possible
    const guestBtn = page.locator('button:has-text("Apply Manually"), a:has-text("Apply Manually")').first();
    if (await guestBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await humanClickLocator(page, 'button:has-text("Apply Manually")');
      await sleep(1000);
    }

    // Dismiss cookie modal
    await humanClickLocator(page, '[aria-label*="Accept"], button[title*="Accept"]').catch(() => null);
  },

  isConfirmed: async (page) => {
    try {
      return await page.evaluate(() =>
        document.body.innerText.includes('submitted') &&
        (document.body.innerText.includes('application') || document.body.innerText.includes('Applied')) ||
        !!document.querySelector('[data-automation-id="submissionConfirmation"]')
      );
    } catch {
      return false;
    }
  },
};

// ─────────────────────────────────────────────────────────────
// ASHBY
// ─────────────────────────────────────────────────────────────
const ashbyAdapter: PlatformAdapter = {
  name: 'Ashby',
  matches: (url) => /ashbyhq\.com/i.test(url),

  prepare: async (page) => {
    logger.debug('Ashby adapter: preparing');
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    await sleep(800);
  },

  isConfirmed: async (page) => {
    try {
      return await page.evaluate(() =>
        document.body.innerText.includes('application has been received') ||
        document.body.innerText.includes("We'll be in touch") ||
        !!document.querySelector('[class*="ApplicationSubmitted"], [class*="confirmation"]')
      );
    } catch {
      return false;
    }
  },
};

// ─────────────────────────────────────────────────────────────
// GENERIC (fallback for any other ATS)
// ─────────────────────────────────────────────────────────────
const genericAdapter: PlatformAdapter = {
  name: 'Generic',
  matches: () => true, // Always matches as fallback

  prepare: async (page) => {
    logger.debug('Generic adapter: preparing');
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await sleep(1000);

    // Accept cookies
    for (const sel of [
      '#onetrust-accept-btn-handler',
      'button[id*="cookie-accept"]',
      'button:has-text("Accept All")',
      'button:has-text("Accept Cookies")',
    ]) {
      if (await humanClickLocator(page, sel).catch(() => false)) {
        await sleep(500);
        break;
      }
    }
  },

  isConfirmed: async (page) => {
    try {
      const confirmed = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return (
          text.includes('application received') ||
          text.includes('application submitted') ||
          text.includes('thank you for applying') ||
          text.includes('thank you for your application') ||
          text.includes('we received your application') ||
          text.includes('application has been sent') ||
          text.includes('successfully applied') ||
          !!document.querySelector(
            '.success-message, .confirmation, [class*="success"], [class*="confirm"], [class*="thank"]'
          )
        );
      });
      return confirmed;
    } catch {
      return false;
    }
  },
};

// ─────────────────────────────────────────────────────────────
// ADAPTER REGISTRY
// ─────────────────────────────────────────────────────────────
const ADAPTERS: PlatformAdapter[] = [
  linkedinAdapter,
  indeedAdapter,
  greenhouseAdapter,
  leverAdapter,
  workdayAdapter,
  ashbyAdapter,
  genericAdapter, // Always last
];

export function getAdapter(url: string): PlatformAdapter {
  return ADAPTERS.find(a => a.matches(url)) ?? genericAdapter;
}

// ─────────────────────────────────────────────────────────────
// ALREADY APPLIED DETECTION
// Check before running full bot if user already applied
// ─────────────────────────────────────────────────────────────
export async function detectAlreadyApplied(page: Page, url: string): Promise<boolean> {
  const text = await page.evaluate(() => document.body.innerText.toLowerCase());

  return (
    text.includes('already applied') ||
    text.includes('you have applied') ||
    text.includes('application in progress') ||
    text.includes('withdraw application') ||
    (url.includes('linkedin') && text.includes('applied'))
  );
}
