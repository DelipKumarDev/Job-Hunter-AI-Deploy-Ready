// ============================================================
// Apply Button Detector
// Locates the primary apply CTA on any job page.
//
// 3-pass detection:
//  Pass 1: Known ATS-specific selectors (exact matches)
//  Pass 2: Text pattern matching with confidence scoring
//  Pass 3: Heuristic fallback (prominent button near top)
//
// Returns the element with highest confidence score.
// ============================================================

import type { Page } from 'playwright';
import { logger } from '../utils/logger.js';

export interface ApplyButtonResult {
  selector:   string;
  text:       string;
  confidence: number;       // 0–1
  method:     'ats_selector' | 'text_pattern' | 'heuristic';
  isEasyApply: boolean;
  opensModal:  boolean;
  opensNewTab: boolean;
}

// ── Pass 1: ATS-specific selectors ───────────────────────────
const ATS_SELECTORS = [
  // LinkedIn
  '.jobs-apply-button',
  'button[data-control-name="jobdetails_topcard_inapply"]',
  '.artdeco-button--primary:has-text("Apply")',
  'button.jobs-apply-button--top-card',

  // Indeed
  '#indeedApplyButton',
  '.indeed-apply-button',
  'button[data-tn-component="jobsearch-SerpJobCard-applyButton"]',
  '[data-indeed-apply-jobid]',

  // Greenhouse
  '#app_submit',
  '.s-btn-primary[type="submit"]',
  'a[href*="/apply"]',

  // Lever
  '.posting-apply-btn',
  '.template-btn-submit',
  'a.template-btn-submit',

  // Workday
  'button[data-automation-id="applyNowButton"]',
  'a[data-automation-id="applyBtn"]',

  // Ashby
  'a[href*="ashbyhq.com"][href*="apply"]',
  'button:has-text("Apply for this job")',

  // SmartRecruiters
  '.smart-apply',
  'a[href*="jobs.smartrecruiters.com/apply"]',

  // BambooHR
  '#btn-apply',
  '.btn-apply',
  'a[href*="bamboohr.com"][href*="apply"]',

  // Wellfound (AngelList)
  'button.apply-button',
  'a[href*="apply"]:has-text("Apply")',

  // Generic
  'button#apply-now',
  'button#apply',
  'a#apply-now',
  'a#apply',
  '[data-qa="apply-button"]',
  '[data-testid="apply-button"]',
  '[data-test="apply-button"]',
];

// ── Pass 2: Text patterns with confidence weights ─────────────
const TEXT_PATTERNS: Array<{ pattern: RegExp; confidence: number }> = [
  { pattern: /^apply now$/i,              confidence: 1.00 },
  { pattern: /^apply$/i,                  confidence: 0.95 },
  { pattern: /^easy apply$/i,             confidence: 1.00 },
  { pattern: /^apply for this (job|role|position)$/i, confidence: 0.98 },
  { pattern: /^apply online$/i,           confidence: 0.90 },
  { pattern: /^quick apply$/i,            confidence: 0.90 },
  { pattern: /^submit (application|your application)$/i, confidence: 0.88 },
  { pattern: /^start application$/i,      confidence: 0.85 },
  { pattern: /^apply with linkedin$/i,    confidence: 0.85 },
  { pattern: /^apply with indeed$/i,      confidence: 0.85 },
  { pattern: /^apply externally$/i,       confidence: 0.80 },
  { pattern: /apply/i,                    confidence: 0.55 },
];

// Reduce confidence if button is hidden, disabled, or secondary
const NEGATIVE_INDICATORS = [
  /job alert/i, /save (job|this)/i, /share/i, /refer/i,
  /follow/i, /similar jobs/i, /notify me/i,
];

// ─────────────────────────────────────────────────────────────
// MAIN DETECTOR
// ─────────────────────────────────────────────────────────────
export async function detectApplyButton(page: Page): Promise<ApplyButtonResult | null> {
  // Pass 1: ATS-specific selectors (fast, high confidence)
  for (const selector of ATS_SELECTORS) {
    try {
      const el = page.locator(selector).first();
      const visible = await el.isVisible({ timeout: 1000 }).catch(() => false);
      if (!visible) continue;

      const text = (await el.textContent() ?? '').trim();
      if (!text) continue;

      const isNegative = NEGATIVE_INDICATORS.some(p => p.test(text));
      if (isNegative) continue;

      const href = await el.getAttribute('href').catch(() => null);
      logger.debug('Apply button found via ATS selector', { selector, text });

      return {
        selector,
        text,
        confidence:   0.95,
        method:       'ats_selector',
        isEasyApply:  /easy apply/i.test(text),
        opensModal:   !href || href === '#',
        opensNewTab:  await el.getAttribute('target').then(t => t === '_blank').catch(() => false),
      };
    } catch { continue; }
  }

  // Pass 2: Text pattern scanning all buttons and links
  const candidates = await page.evaluate(() => {
    interface Candidate {
      tagName: string; text: string; id: string; className: string;
      href: string | null; disabled: boolean; visible: boolean;
      rect: { x: number; y: number; width: number; height: number };
      target: string | null; isModal: boolean;
    }

    const results: Candidate[] = [];
    const elements = document.querySelectorAll('button, a[href], [role="button"]');

    elements.forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;

      const text = el.textContent?.trim() ?? '';
      if (!text || text.length > 100) return;

      const isVisible = rect.top < window.innerHeight * 2 &&
                        rect.bottom > 0 &&
                        window.getComputedStyle(el).display !== 'none' &&
                        window.getComputedStyle(el).visibility !== 'hidden';

      results.push({
        tagName:   el.tagName,
        text,
        id:        el.id,
        className: el.className,
        href:      (el as HTMLAnchorElement).href || null,
        disabled:  (el as HTMLButtonElement).disabled ?? false,
        visible:   isVisible,
        rect:      { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        target:    (el as HTMLAnchorElement).target || null,
        isModal:   !!(el as HTMLAnchorElement).href?.includes('#') ||
                   el.getAttribute('data-toggle') === 'modal',
      });
    });

    return results;
  });

  let bestCandidate: (typeof candidates[0] & { confidence: number; patternMatch: string }) | null = null;

  for (const candidate of candidates) {
    if (!candidate.visible || candidate.disabled) continue;

    const isNegative = NEGATIVE_INDICATORS.some(p => p.test(candidate.text));
    if (isNegative) continue;

    let confidence = 0;
    let patternMatch = '';

    for (const { pattern, confidence: c } of TEXT_PATTERNS) {
      if (pattern.test(candidate.text)) {
        if (c > confidence) {
          confidence = c;
          patternMatch = candidate.text;
        }
        break;
      }
    }

    if (confidence === 0) continue;

    // Boost: above the fold
    if (candidate.rect.y < 600) confidence = Math.min(1, confidence * 1.1);
    // Boost: larger button (primary CTA)
    if (candidate.rect.width > 100) confidence = Math.min(1, confidence * 1.05);
    // Boost: has "apply" in ID/class
    if (/apply/i.test(candidate.id + candidate.className)) confidence = Math.min(1, confidence * 1.1);

    if (!bestCandidate || confidence > bestCandidate.confidence) {
      bestCandidate = { ...candidate, confidence, patternMatch };
    }
  }

  if (bestCandidate && bestCandidate.confidence >= 0.5) {
    // Build a reliable selector for found element
    const selector = buildSelector(bestCandidate);
    logger.debug('Apply button found via text pattern', {
      text: bestCandidate.text,
      confidence: bestCandidate.confidence,
      selector,
    });

    return {
      selector,
      text:         bestCandidate.text,
      confidence:   bestCandidate.confidence,
      method:       'text_pattern',
      isEasyApply:  /easy apply/i.test(bestCandidate.text),
      opensModal:   bestCandidate.isModal,
      opensNewTab:  bestCandidate.target === '_blank',
    };
  }

  // Pass 3: Heuristic — find most prominent button in top half
  const heuristicResult = await heuristicApplyButton(page);
  return heuristicResult;
}

function buildSelector(el: { tagName: string; id: string; className: string; text: string }): string {
  if (el.id) return `#${CSS.escape(el.id)}`;

  const primaryClass = el.className.split(' ')
    .find(c => c.length > 3 && /apply|submit|btn|cta/i.test(c));
  if (primaryClass) return `${el.tagName.toLowerCase()}.${CSS.escape(primaryClass)}`;

  return `${el.tagName.toLowerCase()}:has-text("${el.text.slice(0, 30)}")`;
}

async function heuristicApplyButton(page: Page): Promise<ApplyButtonResult | null> {
  // Look for any button/link with "apply" in text, prioritise by position
  const selector = 'button:has-text("Apply"), a:has-text("Apply")';
  try {
    const el = page.locator(selector).first();
    const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
    if (!visible) return null;

    const text = (await el.textContent() ?? '').trim();
    logger.debug('Apply button found via heuristic', { text });

    return {
      selector,
      text,
      confidence:   0.60,
      method:       'heuristic',
      isEasyApply:  false,
      opensModal:   false,
      opensNewTab:  false,
    };
  } catch {
    return null;
  }
}
