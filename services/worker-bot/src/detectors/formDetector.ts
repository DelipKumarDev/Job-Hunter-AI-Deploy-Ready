// ============================================================
// Form Detector
// Deep DOM analysis to find and categorise every input on
// a job application form.
//
// Detection flow:
//  1. Scan all inputs / selects / textareas
//  2. Classify each via label text, name, id, placeholder
//  3. Detect form steps (multi-step indicator patterns)
//  4. Score field confidence, build DetectedField list
//  5. Detect nav buttons (Next / Previous / Submit)
// ============================================================

import type { Page } from 'playwright';
import type { DetectedField, FieldCategory, FieldType, FormStep } from '../types/botTypes.js';
import { logger } from '../utils/logger.js';

// ── Category inference rules ordered by specificity ──────────
const CATEGORY_RULES: Array<{
  pattern: RegExp;
  category: FieldCategory;
  confidence: number;
}> = [
  // File uploads
  { pattern: /resume|cv\b/i,               category: 'resume',              confidence: 0.97 },
  { pattern: /cover.?letter/i,             category: 'cover_letter',        confidence: 0.97 },
  { pattern: /work.?sample|portfolio.?file/i, category: 'work_sample',      confidence: 0.90 },

  // Name fields
  { pattern: /first.?name|given.?name/i,   category: 'first_name',          confidence: 0.99 },
  { pattern: /last.?name|family.?name|surname/i, category: 'last_name',     confidence: 0.99 },
  { pattern: /\bfull.?name\b|your name/i,  category: 'full_name',           confidence: 0.95 },
  { pattern: /^name$/i,                    category: 'full_name',           confidence: 0.80 },

  // Contact
  { pattern: /email|e-mail/i,              category: 'email',               confidence: 0.99 },
  { pattern: /phone|mobile|cell|tel/i,     category: 'phone',               confidence: 0.97 },

  // Social
  { pattern: /linkedin/i,                  category: 'linkedin',            confidence: 0.99 },
  { pattern: /github/i,                    category: 'github',              confidence: 0.99 },
  { pattern: /portfolio|personal.?site|website/i, category: 'portfolio',   confidence: 0.93 },

  // Location
  { pattern: /\baddress\b/i,              category: 'address',              confidence: 0.92 },
  { pattern: /\bcity\b/i,                 category: 'city',                 confidence: 0.95 },
  { pattern: /state|province/i,           category: 'state',                confidence: 0.90 },
  { pattern: /country|nation/i,           category: 'country',              confidence: 0.93 },
  { pattern: /zip|postal.?code/i,         category: 'zip',                  confidence: 0.95 },
  { pattern: /location|where.?are.?you/i, category: 'location',             confidence: 0.85 },

  // Work history
  { pattern: /current.*company|current.*employer|present.*company/i, category: 'current_company', confidence: 0.93 },
  { pattern: /current.*title|current.*role|current.*position/i, category: 'current_title',    confidence: 0.93 },
  { pattern: /years.*experience|experience.*years|how many years/i, category: 'years_experience', confidence: 0.95 },

  // Compensation
  { pattern: /salary.*expect|expect.*salary|desired.*salary|comp.*expect|desired.*comp/i, category: 'salary_expectation', confidence: 0.96 },

  // Availability
  { pattern: /start.?date|when.?can.?you.?start|earliest.?start/i, category: 'start_date', confidence: 0.95 },
  { pattern: /notice.?period|notice.?required/i,                    category: 'notice_period', confidence: 0.96 },
  { pattern: /available|availability/i,                             category: 'availability', confidence: 0.82 },

  // Authorization
  { pattern: /work.*authoriz|authoriz.*work|legal.*work|right.*work/i, category: 'work_authorization', confidence: 0.97 },
  { pattern: /sponsor|visa.*sponsor|require.*sponsor/i,               category: 'require_sponsorship', confidence: 0.97 },
  { pattern: /relocat/i,                                              category: 'relocation',           confidence: 0.95 },

  // EEO / Demographic (always decline)
  { pattern: /gender|sex\b/i,             category: 'gender',               confidence: 0.97 },
  { pattern: /ethnic|race\b|racial/i,     category: 'ethnicity',            confidence: 0.97 },
  { pattern: /veteran|military/i,         category: 'veteran',              confidence: 0.97 },
  { pattern: /disability|disabled/i,      category: 'disability',           confidence: 0.97 },

  // Education
  { pattern: /education.*level|highest.*degree|degree.*level/i, category: 'education_level', confidence: 0.95 },
  { pattern: /\bschool\b|university|college|institution/i,       category: 'school',          confidence: 0.88 },
  { pattern: /\bdegree\b|major|field.*study/i,                   category: 'degree',          confidence: 0.88 },
  { pattern: /graduation|class.?of|grad.?year/i,                 category: 'graduation_year', confidence: 0.92 },

  // Text content
  { pattern: /cover.?letter.?text|write.*cover|tell.*about|cover.*letter/i, category: 'cover_letter_text', confidence: 0.92 },
  { pattern: /summary|about.?yourself|introduce.?yourself/i,                category: 'summary',           confidence: 0.85 },
  { pattern: /headline|professional.?title/i,                               category: 'headline',          confidence: 0.88 },

  // Preferences
  { pattern: /remote|work.*from.?home/i,      category: 'remote_preference', confidence: 0.88 },
  { pattern: /willing.*travel|travel.*willing/i, category: 'willing_to_travel', confidence: 0.90 },

  // Source
  { pattern: /hear.*about|found.*job|how.*did.*you.*find|referr/i, category: 'referral_source', confidence: 0.90 },
];

// ── Navigation button patterns ────────────────────────────────
const NEXT_PATTERNS   = /^(next|continue|proceed|next step|save & continue|save and continue)$/i;
const PREV_PATTERNS   = /^(back|previous|go back|prev)$/i;
const SUBMIT_PATTERNS = /^(submit|submit application|apply|send application|complete application|finish)$/i;
const REVIEW_PATTERNS = /^(review|review application|preview|confirm)$/i;

// ─────────────────────────────────────────────────────────────
// MAIN FORM SCANNER
// ─────────────────────────────────────────────────────────────
export async function detectFormFields(page: Page): Promise<FormStep> {
  logger.debug('Scanning form fields...');

  const raw = await page.evaluate(() => {
    interface RawField {
      tagName: string; type: string; name: string; id: string;
      placeholder: string; labelText: string; ariaLabel: string;
      required: boolean; value: string; options: string[];
      selector: string; visible: boolean;
      rect: { x: number; y: number; width: number; height: number };
    }

    const fields: RawField[] = [];

    // Collect all interactive form elements
    const elements = document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea'
    );

    function getLabelText(el: Element): string {
      // Explicit label via for= / id
      const id = el.id;
      if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) return label.textContent?.trim() ?? '';
      }
      // Wrapped in label
      const parentLabel = el.closest('label');
      if (parentLabel) return parentLabel.textContent?.replace(el.textContent ?? '', '').trim() ?? '';
      // Preceding sibling label
      let sibling = el.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === 'LABEL') return sibling.textContent?.trim() ?? '';
        if (sibling.tagName !== 'SPAN' && sibling.tagName !== 'I') break;
        sibling = sibling.previousElementSibling;
      }
      // aria-labelledby
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const labelEl = document.getElementById(labelledBy);
        if (labelEl) return labelEl.textContent?.trim() ?? '';
      }
      // Closest heading/legend
      const fieldset = el.closest('fieldset');
      if (fieldset) {
        const legend = fieldset.querySelector('legend');
        if (legend) return legend.textContent?.trim() ?? '';
      }
      return '';
    }

    function buildSelector(el: Element): string {
      const id = (el as HTMLElement).id;
      if (id) return `#${id}`;
      const name = (el as HTMLInputElement).name;
      if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
      // Positional selector as fallback
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        const idx = siblings.indexOf(el);
        return `${el.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;
      }
      return el.tagName.toLowerCase();
    }

    elements.forEach(el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      const visible = rect.width > 0 &&
                      rect.height > 0 &&
                      style.display !== 'none' &&
                      style.visibility !== 'hidden' &&
                      style.opacity !== '0';

      const input  = el as HTMLInputElement;
      const select = el as HTMLSelectElement;

      const options = el.tagName === 'SELECT'
        ? Array.from(select.options).map(o => o.text.trim()).filter(Boolean)
        : el.querySelectorAll('option')
          ? Array.from(el.querySelectorAll('option')).map(o => o.textContent?.trim() ?? '').filter(Boolean)
          : [];

      fields.push({
        tagName:    el.tagName,
        type:       input.type || el.tagName.toLowerCase(),
        name:       input.name || '',
        id:         el.id || '',
        placeholder: input.placeholder || '',
        labelText:  getLabelText(el),
        ariaLabel:  el.getAttribute('aria-label') || '',
        required:   input.required || el.getAttribute('aria-required') === 'true',
        value:      input.value || '',
        options,
        selector:   buildSelector(el),
        visible,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    });

    return fields;
  });

  // Classify each field
  const fields: DetectedField[] = [];
  for (const f of raw) {
    if (!f.visible) continue;

    const { category, confidence } = classifyField(f);
    const fieldType = resolveFieldType(f.tagName, f.type);

    fields.push({
      selector:     f.selector,
      label:        f.labelText || f.ariaLabel || f.placeholder || f.name || f.id,
      category,
      fieldType,
      isRequired:   f.required,
      options:      f.options.length > 0 ? f.options : undefined,
      placeholder:  f.placeholder,
      currentValue: f.value,
      confidence,
    });
  }

  // Detect step info
  const stepInfo = await detectStepInfo(page);
  const navButtons = await detectNavButtons(page);

  logger.debug(`Detected ${fields.length} fields`, {
    categories: fields.map(f => f.category),
    step: stepInfo,
  });

  return {
    stepNumber:  stepInfo.current,
    totalSteps:  stepInfo.total,
    title:       stepInfo.title,
    fields,
    hasNextBtn:  navButtons.hasNext,
    hasPrevBtn:  navButtons.hasPrev,
    isReview:    navButtons.isReview,
  };
}

// ── Field classifier ──────────────────────────────────────────
function classifyField(f: {
  labelText: string; ariaLabel: string; placeholder: string;
  name: string; id: string; type: string;
}): { category: FieldCategory; confidence: number } {

  // Build combined signal text (ordered by reliability)
  const signals = [
    f.labelText,
    f.ariaLabel,
    f.name,
    f.id,
    f.placeholder,
  ].join(' ');

  // File input is unambiguous
  if (f.type === 'file') {
    // Use text signals to distinguish resume vs cover letter
    if (/cover.?letter/i.test(signals)) return { category: 'cover_letter', confidence: 0.99 };
    if (/resume|cv\b/i.test(signals))   return { category: 'resume',       confidence: 0.99 };
    return { category: 'resume', confidence: 0.75 };
  }

  // Email input type is unambiguous
  if (f.type === 'email') return { category: 'email', confidence: 0.99 };

  // Try pattern rules
  let best: { category: FieldCategory; confidence: number } = { category: 'unknown', confidence: 0 };

  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(signals) && rule.confidence > best.confidence) {
      best = { category: rule.category, confidence: rule.confidence };
    }
  }

  if (best.confidence > 0.5) return best;

  // Fallback inference from type
  if (f.type === 'tel')    return { category: 'phone',    confidence: 0.85 };
  if (f.type === 'url')    return { category: 'portfolio', confidence: 0.60 };
  if (f.type === 'number') return { category: 'years_experience', confidence: 0.50 };

  return { category: 'custom_question', confidence: 0.50 };
}

function resolveFieldType(tagName: string, type: string): FieldType {
  if (tagName === 'SELECT')   return 'select';
  if (tagName === 'TEXTAREA') return 'textarea';
  const map: Record<string, FieldType> = {
    text: 'text', email: 'email', tel: 'tel', number: 'number',
    date: 'date', url: 'url', file: 'file', radio: 'radio',
    checkbox: 'checkbox', hidden: 'hidden',
  };
  return map[type.toLowerCase()] ?? 'unknown';
}

// ── Step detection ────────────────────────────────────────────
async function detectStepInfo(page: Page): Promise<{
  current: number; total: number | null; title: string | null;
}> {
  return page.evaluate(() => {
    // Progress bar indicators
    const stepIndicators = [
      '[class*="step"][class*="active"]',
      '[class*="progress"]',
      '[aria-current="step"]',
      '.step-indicator .active',
      '[data-step]',
    ];

    for (const sel of stepIndicators) {
      const el = document.querySelector(sel);
      if (!el) continue;

      // Look for "Step N of M" text pattern
      const container = el.closest('[class*="progress"], [class*="step"], [class*="wizard"]') ?? el.parentElement;
      const text = container?.textContent ?? '';
      const m = text.match(/step\s*(\d+)\s*(?:of|\/)\s*(\d+)/i);
      if (m) return { current: parseInt(m[1]!), total: parseInt(m[2]!), title: null };

      // Count total step dots/circles
      const allSteps = document.querySelectorAll('[class*="step-dot"], [class*="step-circle"], [aria-label*="step"]');
      if (allSteps.length > 0) {
        const activeIdx = Array.from(allSteps).findIndex(s =>
          s.classList.contains('active') || s.getAttribute('aria-current') === 'step'
        );
        return { current: Math.max(1, activeIdx + 1), total: allSteps.length, title: null };
      }
    }

    // Page title heuristic
    const h1 = document.querySelector('h1, h2, [class*="form-title"], [class*="step-title"]');
    return { current: 1, total: null, title: h1?.textContent?.trim() ?? null };
  });
}

// ── Nav button detection ──────────────────────────────────────
async function detectNavButtons(page: Page): Promise<{
  hasNext: boolean; hasPrev: boolean; isReview: boolean;
}> {
  return page.evaluate((patterns) => {
    const btns = Array.from(document.querySelectorAll(
      'button, input[type="submit"], a[role="button"]'
    ));

    let hasNext   = false;
    let hasPrev   = false;
    let isReview  = false;

    btns.forEach(btn => {
      const text = btn.textContent?.trim() ?? '';
      const rect = btn.getBoundingClientRect();
      if (rect.width < 10) return;

      if (new RegExp(patterns.next,   'i').test(text)) hasNext  = true;
      if (new RegExp(patterns.prev,   'i').test(text)) hasPrev  = true;
      if (new RegExp(patterns.review, 'i').test(text)) isReview = true;
      if (new RegExp(patterns.submit, 'i').test(text)) hasNext  = true;
    });

    return { hasNext, hasPrev, isReview };
  }, {
    next:   NEXT_PATTERNS.source,
    prev:   PREV_PATTERNS.source,
    submit: SUBMIT_PATTERNS.source,
    review: REVIEW_PATTERNS.source,
  });
}
