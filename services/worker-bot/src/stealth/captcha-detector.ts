/**
 * ============================================================
 * captcha-detector.ts
 *
 * Detects the presence of captcha challenges on a page and
 * provides a structured pause mechanism for the automation.
 *
 * Supported challenges:
 *   • reCAPTCHA v2  (checkbox + image challenge)
 *   • reCAPTCHA v3  (invisible score-based)
 *   • hCaptcha      (used by LinkedIn, Cloudflare)
 *   • Cloudflare    (browser challenge + Turnstile)
 *   • FunCaptcha / Arkose Labs  (rotating cube / games)
 *   • DataDome      (bot protection platform)
 *   • GeeTest       (slider / click puzzle)
 *   • Incapsula / Imperva
 *
 * On detection:
 *   1. CaptchaDetectedError is thrown
 *   2. applicationBot.ts catches it and pauses the queue job
 *   3. The job re-queues with a delay for human review or
 *      an external solver service
 *
 * External solver hooks:
 *   Stubs are provided for 2captcha and Anti-Captcha services.
 *   Set CAPTCHA_SOLVER=2captcha|anticaptcha and CAPTCHA_API_KEY
 *   to enable automatic solving.
 * ============================================================
 */

import type { Page } from 'playwright';
import { logger }    from '../utils/logger.js';
import { sleep }     from '../humanizer/humanBehavior.js';

// ── Types ─────────────────────────────────────────────────────

export type CaptchaVendor =
  | 'recaptcha-v2'
  | 'recaptcha-v3'
  | 'hcaptcha'
  | 'cloudflare'
  | 'cloudflare-turnstile'
  | 'arkose'
  | 'datadome'
  | 'geetest'
  | 'incapsula'
  | 'unknown';

export interface CaptchaDetection {
  detected:   boolean;
  vendor:     CaptchaVendor | null;
  confidence: number;           // 0–1
  selector:   string | null;    // CSS selector of captcha element
  siteKey:    string | null;    // Extracted site key if available
  pageUrl:    string;
  detectedAt: Date;
}

export class CaptchaDetectedError extends Error {
  constructor(
    public readonly detection: CaptchaDetection,
    message?: string,
  ) {
    super(message ?? `Captcha detected: ${detection.vendor} on ${detection.pageUrl}`);
    this.name = 'CaptchaDetectedError';
  }
}

// ── Detection signatures ──────────────────────────────────────

interface DetectionRule {
  vendor:     CaptchaVendor;
  confidence: number;
  checks:     Array<{
    type:    'selector' | 'url' | 'title' | 'body-text' | 'frame-url';
    value:   string;
  }>;
}

const DETECTION_RULES: DetectionRule[] = [
  // ── Cloudflare challenge page ──────────────────────────────
  {
    vendor:     'cloudflare',
    confidence: 0.95,
    checks: [
      { type: 'selector',  value: '#challenge-running'         },
      { type: 'selector',  value: '#cf-wrapper'                },
      { type: 'selector',  value: '.cf-browser-verification'   },
      { type: 'title',     value: 'Just a moment'              },
      { type: 'url',       value: 'cdn-cgi/challenge-platform' },
    ],
  },
  // ── Cloudflare Turnstile ───────────────────────────────────
  {
    vendor:     'cloudflare-turnstile',
    confidence: 0.90,
    checks: [
      { type: 'selector',  value: 'cf-turnstile'               },
      { type: 'frame-url', value: 'challenges.cloudflare.com'  },
      { type: 'selector',  value: '[data-sitekey][class*="turnstile"]' },
    ],
  },
  // ── reCAPTCHA v2 ──────────────────────────────────────────
  {
    vendor:     'recaptcha-v2',
    confidence: 0.95,
    checks: [
      { type: 'selector',  value: '.g-recaptcha'               },
      { type: 'selector',  value: '#recaptcha-anchor'          },
      { type: 'frame-url', value: 'google.com/recaptcha'       },
      { type: 'frame-url', value: 'recaptcha/api2'             },
      { type: 'selector',  value: 'iframe[src*="recaptcha"]'   },
    ],
  },
  // ── reCAPTCHA v3 (invisible) ──────────────────────────────
  {
    vendor:     'recaptcha-v3',
    confidence: 0.75,
    checks: [
      { type: 'selector',  value: '.grecaptcha-badge'          },
      { type: 'body-text', value: 'grecaptcha.execute'         },
      { type: 'selector',  value: 'script[src*="recaptcha/api.js"]' },
    ],
  },
  // ── hCaptcha ──────────────────────────────────────────────
  {
    vendor:     'hcaptcha',
    confidence: 0.95,
    checks: [
      { type: 'selector',  value: '.h-captcha'                 },
      { type: 'selector',  value: '#hcaptcha'                  },
      { type: 'frame-url', value: 'hcaptcha.com'               },
      { type: 'selector',  value: 'iframe[src*="hcaptcha.com"]' },
    ],
  },
  // ── Arkose Labs / FunCaptcha ───────────────────────────────
  {
    vendor:     'arkose',
    confidence: 0.90,
    checks: [
      { type: 'frame-url', value: 'arkoselabs.com'             },
      { type: 'frame-url', value: 'funcaptcha.com'             },
      { type: 'selector',  value: 'iframe[src*="arkoselabs"]'  },
      { type: 'selector',  value: 'iframe[src*="funcaptcha"]'  },
      { type: 'selector',  value: '#FunCaptcha'                },
    ],
  },
  // ── DataDome ──────────────────────────────────────────────
  {
    vendor:     'datadome',
    confidence: 0.88,
    checks: [
      { type: 'selector',  value: '#datadome'                  },
      { type: 'selector',  value: '.datadome-captcha'          },
      { type: 'url',       value: 'datadome.co'                },
      { type: 'body-text', value: 'datadome'                   },
    ],
  },
  // ── GeeTest ───────────────────────────────────────────────
  {
    vendor:     'geetest',
    confidence: 0.88,
    checks: [
      { type: 'selector',  value: '.geetest_holder'            },
      { type: 'selector',  value: '#geetest-box'               },
      { type: 'selector',  value: '.geetest_popup_wrap'        },
      { type: 'frame-url', value: 'geetest.com'                },
    ],
  },
  // ── Incapsula / Imperva ───────────────────────────────────
  {
    vendor:     'incapsula',
    confidence: 0.85,
    checks: [
      { type: 'selector',  value: '#incapsula-block'           },
      { type: 'url',       value: '_Incapsula_Resource'        },
      { type: 'title',     value: 'Request unsuccessful'       },
      { type: 'body-text', value: 'Incapsula incident'         },
    ],
  },
];

// ── Detector ──────────────────────────────────────────────────

/**
 * Scan the current page for any captcha challenge.
 * Returns a CaptchaDetection describing what was found (or not).
 */
export async function detectCaptcha(page: Page): Promise<CaptchaDetection> {
  const pageUrl = page.url();
  const result: CaptchaDetection = {
    detected:   false,
    vendor:     null,
    confidence: 0,
    selector:   null,
    siteKey:    null,
    pageUrl,
    detectedAt: new Date(),
  };

  try {
    const title   = await page.title().catch(() => '');
    const bodyText = await page.$eval('body', el => el.textContent ?? '').catch(() => '');
    const frames   = page.frames();
    const frameUrls = frames.map(f => f.url());

    for (const rule of DETECTION_RULES) {
      let matchCount = 0;
      let firstSelector: string | null = null;

      for (const check of rule.checks) {
        let matched = false;

        if (check.type === 'selector') {
          const el = await page.$(check.value).catch(() => null);
          matched = el !== null;
          if (matched && !firstSelector) firstSelector = check.value;

        } else if (check.type === 'url') {
          matched = pageUrl.includes(check.value);

        } else if (check.type === 'title') {
          matched = title.toLowerCase().includes(check.value.toLowerCase());

        } else if (check.type === 'body-text') {
          matched = bodyText.toLowerCase().includes(check.value.toLowerCase());

        } else if (check.type === 'frame-url') {
          matched = frameUrls.some(u => u.includes(check.value));
        }

        if (matched) matchCount++;
      }

      // Detected if ANY check matches (OR logic)
      if (matchCount > 0) {
        result.detected   = true;
        result.vendor     = rule.vendor;
        result.confidence = rule.confidence;
        result.selector   = firstSelector;
        result.siteKey    = await extractSiteKey(page, rule.vendor).catch(() => null);
        break;
      }
    }
  } catch (err) {
    logger.warn('CaptchaDetector: detection scan error', { error: (err as Error).message });
  }

  return result;
}

/**
 * Check for captcha and throw CaptchaDetectedError if found.
 * Call this:
 *   - After navigation (to catch Cloudflare challenges)
 *   - After clicking the apply button
 *   - After each form step advance
 */
export async function assertNoCaptcha(page: Page): Promise<void> {
  const detection = await detectCaptcha(page);

  if (detection.detected) {
    logger.warn('CaptchaDetector: captcha challenge detected', {
      vendor:     detection.vendor,
      confidence: detection.confidence,
      url:        detection.pageUrl,
      siteKey:    detection.siteKey ? '[present]' : '[absent]',
    });

    // Attempt automatic solving if configured
    const solved = await attemptAutoSolve(page, detection);
    if (solved) {
      logger.info('CaptchaDetector: captcha solved automatically');
      return;
    }

    throw new CaptchaDetectedError(detection);
  }
}

/**
 * Poll for captcha resolution.
 * Used after detecting a captcha to wait for external solver
 * or manual intervention (in debug/manual mode).
 *
 * @param maxWaitMs  Maximum time to wait (default 120s)
 */
export async function waitForCaptchaResolution(
  page:       Page,
  maxWaitMs:  number = 120_000,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  logger.info('CaptchaDetector: waiting for captcha resolution…', {
    maxWaitSec: maxWaitMs / 1000,
  });

  while (Date.now() < deadline) {
    await sleep(3000);
    const detection = await detectCaptcha(page);
    if (!detection.detected) {
      logger.info('CaptchaDetector: captcha resolved');
      return true;
    }
  }

  logger.warn('CaptchaDetector: captcha not resolved within timeout');
  return false;
}

// ── Site key extraction ───────────────────────────────────────

async function extractSiteKey(page: Page, vendor: CaptchaVendor): Promise<string | null> {
  try {
    switch (vendor) {
      case 'recaptcha-v2':
      case 'recaptcha-v3':
        return await page.$eval('.g-recaptcha', el => el.getAttribute('data-sitekey'))
          ?? await page.$eval('[data-sitekey]', el => el.getAttribute('data-sitekey'));

      case 'hcaptcha':
        return await page.$eval('.h-captcha', el => el.getAttribute('data-sitekey'))
          ?? await page.$eval('[data-hcaptcha-sitekey]', el => el.getAttribute('data-hcaptcha-sitekey'));

      case 'cloudflare-turnstile':
        return await page.$eval('[data-sitekey]', el => el.getAttribute('data-sitekey'));

      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ── Auto-solver stub ─────────────────────────────────────────

/**
 * Attempt to solve a detected captcha automatically.
 * Returns true if solved, false otherwise.
 *
 * Currently implements:
 *   - reCAPTCHA v3: page reload (no visual challenge to solve)
 *   - Cloudflare:   wait + reload (often resolves automatically)
 *   - Others:       stub hooks for 2captcha / Anti-Captcha
 */
async function attemptAutoSolve(
  page:      Page,
  detection: CaptchaDetection,
): Promise<boolean> {
  const solver    = process.env['CAPTCHA_SOLVER'];
  const apiKey    = process.env['CAPTCHA_API_KEY'];

  // ── Strategy 1: reCAPTCHA v3 — no visual challenge
  if (detection.vendor === 'recaptcha-v3') {
    // v3 is score-based; reload may give a better score on next attempt
    logger.info('CaptchaDetector: reCAPTCHA v3 detected — will retry with fresh session');
    return false; // Let the caller handle retry
  }

  // ── Strategy 2: Cloudflare basic challenge — wait it out
  if (detection.vendor === 'cloudflare') {
    logger.info('CaptchaDetector: Cloudflare challenge — waiting 8s for auto-resolution');
    await sleep(8000);
    const recheckCf = await detectCaptcha(page);
    if (!recheckCf.detected) return true;

    // Try reload once
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => null);
    await sleep(5000);
    const recheckCf2 = await detectCaptcha(page);
    return !recheckCf2.detected;
  }

  // ── Strategy 3: External solver service ──────────────────
  if (solver && apiKey && detection.siteKey) {
    logger.info('CaptchaDetector: attempting external solver', { solver, vendor: detection.vendor });
    try {
      const token = await callExternalSolver(solver, apiKey, detection);
      if (token) {
        await injectSolverToken(page, detection.vendor!, token);
        await sleep(2000);
        const recheck = await detectCaptcha(page);
        return !recheck.detected;
      }
    } catch (err) {
      logger.warn('CaptchaDetector: external solver failed', { error: (err as Error).message });
    }
  }

  return false;
}

/**
 * STUB: Call an external captcha solving service.
 * Replace with actual API calls for your preferred service.
 */
async function callExternalSolver(
  solver:    string,
  apiKey:    string,
  detection: CaptchaDetection,
): Promise<string | null> {
  // This is an integration point — not a full implementation.
  // Wire up your preferred service (2captcha, Anti-Captcha, CapSolver…)
  logger.info('CaptchaDetector: external solver stub called', {
    solver,
    vendor:  detection.vendor,
    pageUrl: detection.pageUrl,
    // Never log apiKey
  });

  /* Example 2captcha integration:
  const response = await fetch('https://2captcha.com/in.php', {
    method: 'POST',
    body: new URLSearchParams({
      key:       apiKey,
      method:    'userrecaptcha',
      googlekey: detection.siteKey!,
      pageurl:   detection.pageUrl,
      json:      '1',
    }),
  });
  const { request: taskId } = await response.json();
  // ... poll for result ...
  return solvedToken;
  */

  void solver; void apiKey;  // Suppress unused variable warnings
  return null;
}

/**
 * Inject a solved captcha token back into the page.
 */
async function injectSolverToken(
  page:   Page,
  vendor: CaptchaVendor,
  token:  string,
): Promise<void> {
  if (vendor === 'recaptcha-v2' || vendor === 'recaptcha-v3') {
    await page.evaluate((t) => {
      const el = document.querySelector('#g-recaptcha-response') as HTMLTextAreaElement | null;
      if (el) { el.value = t; el.style.display = 'block'; }
      // Trigger callback if present
      if ((window as any).___grecaptcha_cfg) {
        const cfg = (window as any).___grecaptcha_cfg;
        const clients = Object.values(cfg.clients ?? {}) as any[];
        for (const client of clients) {
          const callback = client?.U?.callback ?? client?.l?.callback;
          if (typeof callback === 'function') { callback(t); break; }
        }
      }
    }, token);

  } else if (vendor === 'hcaptcha') {
    await page.evaluate((t) => {
      const el = document.querySelector('[name=h-captcha-response]') as HTMLTextAreaElement | null;
      if (el) el.value = t;
    }, token);
  }
}
