// ============================================================
// Form Filler
// Maps CandidateFormData to detected form fields and fills
// them using human-simulated interactions.
//
// Field resolution order:
//  1. Static value map (deterministic, fast)
//  2. Select option fuzzy matching
//  3. Claude Haiku for custom/open-ended questions
//  4. EEO fields → always Prefer not to say / Decline
//
// All fills use humanType / humanSelect / humanClick
// to avoid bot detection via event signatures.
// ============================================================

import type { Page } from 'playwright';
import type { DetectedField, CandidateFormData } from '../types/botTypes.js';
import { humanType, humanSelect, humanClick, humanClickLocator, humanCheckbox, sleep } from '../humanizer/humanBehavior.js';
import { logger } from '../utils/logger.js';

// ── EEO decline values (platform-specific fallbacks) ─────────
const EEO_DECLINE_VALUES = [
  'Prefer not to say', 'Decline to state', 'Prefer not to answer',
  'I do not wish to answer', 'Choose not to disclose',
  'Not specified', 'Decline', 'Undisclosed', "I don't wish to answer",
  'Prefer Not To Say',
];

// ── Start date options ────────────────────────────────────────
const START_DATE_OPTIONS = [
  '2 weeks', 'Two weeks', '2 Weeks',
  '3 weeks', 'Three weeks',
  '1 month', 'One month', '4 weeks', 'Four weeks',
  'Immediately', 'ASAP', 'As soon as possible',
];

// ─────────────────────────────────────────────────────────────
// BUILD STATIC VALUE MAP for a candidate
// Called once per bot run; maps FieldCategory → fill value
// ─────────────────────────────────────────────────────────────
function buildValueMap(candidate: CandidateFormData): Record<string, string> {
  const expYears = candidate.yearsExperience != null
    ? String(Math.round(candidate.yearsExperience))
    : '5';

  const salary = candidate.salaryExpectation != null
    ? String(candidate.salaryExpectation)
    : '';

  return {
    first_name:          candidate.firstName,
    last_name:           candidate.lastName,
    full_name:           candidate.fullName,
    email:               candidate.email,
    phone:               candidate.phone ?? '',
    location:            candidate.location ?? '',
    city:                candidate.city ?? '',
    state:               candidate.state ?? '',
    country:             candidate.country ?? 'United States',
    address:             candidate.location ?? '',
    zip:                 '',
    linkedin:            candidate.linkedinUrl ?? '',
    github:              candidate.githubUrl ?? '',
    portfolio:           candidate.portfolioUrl ?? candidate.linkedinUrl ?? '',
    current_title:       candidate.currentTitle ?? '',
    current_company:     candidate.currentCompany ?? '',
    years_experience:    expYears,
    education_level:     mapEducationLevel(candidate.educationLevel),
    school:              candidate.school ?? '',
    degree:              candidate.degree ?? '',
    graduation_year:     String(candidate.graduationYear ?? ''),
    salary_expectation:  salary,
    notice_period:       candidate.noticePeriod ?? '2 weeks',
    start_date:          candidate.noticePeriod ?? '2 weeks',
    availability:        candidate.noticePeriod ?? 'Immediately',
    work_authorization:  candidate.workAuthorization,
    require_sponsorship: candidate.requireSponsorship,
    relocation:          candidate.willingToRelocate,
    remote_preference:   candidate.remotePreference,
    cover_letter_text:   candidate.coverLetterText ?? '',
    summary:             candidate.professionalSummary ?? '',
    headline:            candidate.currentTitle ?? '',
    willing_to_travel:   'No',
    referral_source:     'Job Board',
    heard_about_us:      'Job Board',
    // EEO — always decline
    gender:              'Prefer not to say',
    ethnicity:           'Prefer not to say',
    veteran:             'I am not a protected veteran',
    disability:          'I do not have a disability',
  };
}

function mapEducationLevel(level: string | null): string {
  const map: Record<string, string> = {
    bachelors:  "Bachelor's Degree",
    masters:    "Master's Degree",
    phd:        'Doctorate',
    associate:  "Associate's Degree",
    high_school: 'High School Diploma',
    bootcamp:   'Some College',
  };
  return map[level?.toLowerCase() ?? ''] ?? "Bachelor's Degree";
}

// ─────────────────────────────────────────────────────────────
// FILL SINGLE FIELD
// ─────────────────────────────────────────────────────────────
export async function fillField(
  page:      Page,
  field:     DetectedField,
  candidate: CandidateFormData,
): Promise<{ filled: boolean; warning?: string }> {

  const valueMap = buildValueMap(candidate);

  // Skip file fields (handled by fileUploader)
  if (field.fieldType === 'file') {
    return { filled: false };
  }

  // Skip fields already filled
  if (field.currentValue && field.currentValue.trim().length > 0) {
    logger.debug('Field already has value, skipping', { label: field.label, category: field.category });
    return { filled: true };
  }

  try {
    switch (field.fieldType) {

      case 'text':
      case 'email':
      case 'tel':
      case 'url':
      case 'number':
        return fillTextInput(page, field, valueMap, candidate);

      case 'textarea':
        return fillTextarea(page, field, valueMap, candidate);

      case 'select':
        return fillSelect(page, field, valueMap);

      case 'radio':
        return fillRadio(page, field, valueMap);

      case 'checkbox':
        return fillCheckbox(page, field, valueMap);

      case 'date':
        return fillDateInput(page, field, valueMap);

      default:
        return { filled: false, warning: `Unknown field type: ${field.fieldType}` };
    }
  } catch (err) {
    logger.warn('Field fill error', { label: field.label, category: field.category, error: String(err) });
    return { filled: false, warning: String(err) };
  }
}

// ─────────────────────────────────────────────────────────────
// TEXT INPUT
// ─────────────────────────────────────────────────────────────
async function fillTextInput(
  page:      Page,
  field:     DetectedField,
  valueMap:  Record<string, string>,
  candidate: CandidateFormData,
): Promise<{ filled: boolean; warning?: string }> {

  let value = valueMap[field.category] ?? '';

  // Custom question: use Claude Haiku for an intelligent answer
  if (field.category === 'custom_question' || (!value && field.isRequired)) {
    value = await answerCustomQuestion(field, candidate);
  }

  if (!value) {
    if (field.isRequired) {
      return { filled: false, warning: `No value for required field: ${field.label}` };
    }
    return { filled: false };
  }

  await humanType(page, field.selector, value, { clearFirst: true });
  await sleep(150 + Math.random() * 200);
  return { filled: true };
}

// ─────────────────────────────────────────────────────────────
// TEXTAREA
// ─────────────────────────────────────────────────────────────
async function fillTextarea(
  page:      Page,
  field:     DetectedField,
  valueMap:  Record<string, string>,
  candidate: CandidateFormData,
): Promise<{ filled: boolean; warning?: string }> {

  let value = valueMap[field.category] ?? '';

  if (!value || field.category === 'custom_question') {
    value = await answerCustomQuestion(field, candidate);
  }

  if (!value) {
    if (field.isRequired) {
      return { filled: false, warning: `No value for required textarea: ${field.label}` };
    }
    return { filled: false };
  }

  // Textarea: type slowly (longer content)
  await humanType(page, field.selector, value, { clearFirst: true });
  await sleep(300 + Math.random() * 300);
  return { filled: true };
}

// ─────────────────────────────────────────────────────────────
// SELECT
// ─────────────────────────────────────────────────────────────
async function fillSelect(
  page:     Page,
  field:    DetectedField,
  valueMap: Record<string, string>,
): Promise<{ filled: boolean; warning?: string }> {

  const targetValue = valueMap[field.category] ?? '';
  if (!targetValue) {
    if (field.isRequired) {
      return { filled: false, warning: `No select value for: ${field.label}` };
    }
    return { filled: false };
  }

  const options = field.options ?? [];

  // EEO fields: find decline option
  if (isEeoField(field.category)) {
    const declineOpt = findBestOption(options, EEO_DECLINE_VALUES);
    if (declineOpt) {
      await humanSelect(page, field.selector, declineOpt);
      return { filled: true };
    }
  }

  // Exact match first
  if (options.includes(targetValue)) {
    await humanSelect(page, field.selector, targetValue);
    return { filled: true };
  }

  // Fuzzy match
  const best = findBestOption(options, [targetValue]);
  if (best) {
    await humanSelect(page, field.selector, best);
    return { filled: true };
  }

  // Special case: Yes/No fields
  if (options.some(o => /^yes$/i.test(o)) && /yes|true/i.test(targetValue)) {
    const yesOpt = options.find(o => /^yes$/i.test(o))!;
    await humanSelect(page, field.selector, yesOpt);
    return { filled: true };
  }
  if (options.some(o => /^no$/i.test(o)) && /no|false/i.test(targetValue)) {
    const noOpt = options.find(o => /^no$/i.test(o))!;
    await humanSelect(page, field.selector, noOpt);
    return { filled: true };
  }

  return { filled: false, warning: `No matching option for "${targetValue}" in: ${options.join(', ')}` };
}

// ─────────────────────────────────────────────────────────────
// RADIO
// ─────────────────────────────────────────────────────────────
async function fillRadio(
  page:     Page,
  field:    DetectedField,
  valueMap: Record<string, string>,
): Promise<{ filled: boolean; warning?: string }> {

  const targetValue = valueMap[field.category] ?? '';

  // EEO radio: find and click decline option
  if (isEeoField(field.category)) {
    for (const declineText of EEO_DECLINE_VALUES) {
      const selector = `input[type="radio"][value*="${declineText}"], label:has-text("${declineText}") input[type="radio"]`;
      const clicked = await humanClickLocator(page, selector);
      if (clicked) return { filled: true };
    }
  }

  // Find radio by value attribute or label text
  const selectors = [
    `input[type="radio"][value="${targetValue}"]`,
    `input[type="radio"][value="${targetValue.toLowerCase()}"]`,
    `label:has-text("${targetValue}") input[type="radio"]`,
  ];

  for (const sel of selectors) {
    const clicked = await humanClickLocator(page, sel);
    if (clicked) return { filled: true };
  }

  // Try Yes/No pattern
  if (/yes|true/i.test(targetValue)) {
    const clicked = await humanClickLocator(page, 'input[type="radio"][value="yes"], input[type="radio"][value="Yes"]');
    if (clicked) return { filled: true };
  }

  if (!field.isRequired) return { filled: false };
  return { filled: false, warning: `Could not select radio: ${field.label} = ${targetValue}` };
}

// ─────────────────────────────────────────────────────────────
// CHECKBOX
// ─────────────────────────────────────────────────────────────
async function fillCheckbox(
  page:     Page,
  field:    DetectedField,
  valueMap: Record<string, string>,
): Promise<{ filled: boolean; warning?: string }> {

  const targetValue = valueMap[field.category] ?? 'Yes';
  const shouldCheck = /yes|true|agree|accept/i.test(targetValue);

  // Terms & conditions: always accept
  if (/terms|agree|consent|accept|privacy/i.test(field.label)) {
    await humanCheckbox(page, field.selector, true);
    return { filled: true };
  }

  // EEO: uncheck
  if (isEeoField(field.category)) {
    await humanCheckbox(page, field.selector, false);
    return { filled: true };
  }

  await humanCheckbox(page, field.selector, shouldCheck);
  return { filled: true };
}

// ─────────────────────────────────────────────────────────────
// DATE INPUT
// ─────────────────────────────────────────────────────────────
async function fillDateInput(
  page:     Page,
  field:    DetectedField,
  valueMap: Record<string, string>,
): Promise<{ filled: boolean; warning?: string }> {

  // Calculate start date (today + notice period)
  const today     = new Date();
  const noticeDays = parseNoticePeriodDays(valueMap['notice_period'] ?? '14 days');
  const startDate = new Date(today.getTime() + noticeDays * 86400 * 1000);
  const formatted = startDate.toISOString().split('T')[0]!; // YYYY-MM-DD

  await humanType(page, field.selector, formatted, { clearFirst: true });
  return { filled: true };
}

function parseNoticePeriodDays(notice: string): number {
  if (/immediately|asap|now/i.test(notice))  return 0;
  if (/1\s*week|one\s*week/i.test(notice))   return 7;
  if (/2\s*week|two\s*week/i.test(notice))   return 14;
  if (/3\s*week|three\s*week/i.test(notice)) return 21;
  if (/1\s*month|four\s*week/i.test(notice)) return 30;
  return 14; // default 2 weeks
}

// ─────────────────────────────────────────────────────────────
// FILL ALL FIELDS on current step
// ─────────────────────────────────────────────────────────────
export async function fillAllFields(
  page:      Page,
  fields:    DetectedField[],
  candidate: CandidateFormData,
): Promise<{ filled: number; failed: number; warnings: string[] }> {

  let filled = 0;
  let failed = 0;
  const warnings: string[] = [];

  // Sort: required fields first, then by position (top → bottom)
  const sorted = [...fields].sort((a, b) => {
    if (a.isRequired && !b.isRequired) return -1;
    if (!a.isRequired && b.isRequired) return 1;
    return 0;
  });

  for (const field of sorted) {
    if (field.fieldType === 'file') continue; // Handled by fileUploader

    const result = await fillField(page, field, candidate);

    if (result.filled) {
      filled++;
      // Natural inter-field pause
      await sleep(200 + Math.random() * 500);
    } else if (result.warning) {
      failed++;
      warnings.push(result.warning);
      logger.warn('Field not filled', { label: field.label, warning: result.warning });
    }
  }

  return { filled, failed, warnings };
}

// ─────────────────────────────────────────────────────────────
// CLAUDE HAIKU — Custom question answering
// ─────────────────────────────────────────────────────────────
async function answerCustomQuestion(
  field:     DetectedField,
  candidate: CandidateFormData,
): Promise<string> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) return '';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: `You are helping ${candidate.fullName} fill out a job application.
Answer in first person, concisely (1-3 sentences max).
Do not include preamble. Just the answer text.
Candidate background: ${candidate.currentTitle ?? 'Software Engineer'} with ${candidate.yearsExperience ?? 5} years experience.`,
        messages: [{
          role:    'user',
          content: `Question: "${field.label}"\n\nAnswer briefly:`,
        }],
      }),
    });

    if (!response.ok) return '';
    const data = await response.json() as { content: Array<{ type: string; text: string }> };
    return data.content.find(c => c.type === 'text')?.text?.trim() ?? '';
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function isEeoField(category: string): boolean {
  return ['gender', 'ethnicity', 'veteran', 'disability'].includes(category);
}

/** Find the best matching option via case-insensitive substring */
function findBestOption(options: string[], targets: string[]): string | null {
  for (const target of targets) {
    // Exact match
    const exact = options.find(o => o.toLowerCase() === target.toLowerCase());
    if (exact) return exact;
    // Substring match
    const sub = options.find(o =>
      o.toLowerCase().includes(target.toLowerCase()) ||
      target.toLowerCase().includes(o.toLowerCase())
    );
    if (sub) return sub;
  }
  return null;
}
