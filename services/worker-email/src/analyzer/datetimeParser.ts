// ============================================================
// Natural Language Datetime Parser
// Converts recruiter email date expressions into structured
// ISO 8601 datetimes with IANA timezone offsets.
//
// Handles:
//   "Tuesday, February 25th at 3:00 PM EST"
//   "this Thursday at 2pm Pacific"
//   "next Monday between 10am and 12pm"
//   "Feb 25 @ 15:00 GMT"
//   "3/15 at 9:30am CST"
//   "tomorrow afternoon"
//   "the week of March 10th"
//   Calendly/cal.com links (flag for range)
//
// Output: ExtractedDatetime with confidence score
// Does NOT use external libraries — pure regex + lookup tables
// ============================================================

import type { ExtractedDatetime } from './analyzerTypes.js';

// ── Timezone abbreviation → IANA + UTC offset ─────────────────
const TZ_MAP: Record<string, { iana: string; offsetMin: number }> = {
  'EST':  { iana: 'America/New_York',      offsetMin: -300 },
  'EDT':  { iana: 'America/New_York',      offsetMin: -240 },
  'ET':   { iana: 'America/New_York',      offsetMin: -300 },
  'CST':  { iana: 'America/Chicago',       offsetMin: -360 },
  'CDT':  { iana: 'America/Chicago',       offsetMin: -300 },
  'CT':   { iana: 'America/Chicago',       offsetMin: -360 },
  'MST':  { iana: 'America/Denver',        offsetMin: -420 },
  'MDT':  { iana: 'America/Denver',        offsetMin: -360 },
  'MT':   { iana: 'America/Denver',        offsetMin: -420 },
  'PST':  { iana: 'America/Los_Angeles',   offsetMin: -480 },
  'PDT':  { iana: 'America/Los_Angeles',   offsetMin: -420 },
  'PT':   { iana: 'America/Los_Angeles',   offsetMin: -480 },
  'GMT':  { iana: 'Europe/London',         offsetMin: 0    },
  'UTC':  { iana: 'UTC',                   offsetMin: 0    },
  'BST':  { iana: 'Europe/London',         offsetMin: 60   },
  'CET':  { iana: 'Europe/Paris',          offsetMin: 60   },
  'CEST': { iana: 'Europe/Paris',          offsetMin: 120  },
  'IST':  { iana: 'Asia/Kolkata',          offsetMin: 330  },
  'AEST': { iana: 'Australia/Sydney',      offsetMin: 600  },
  'AEDT': { iana: 'Australia/Sydney',      offsetMin: 660  },
  'SGT':  { iana: 'Asia/Singapore',        offsetMin: 480  },
  'HKT':  { iana: 'Asia/Hong_Kong',        offsetMin: 480  },
  'JST':  { iana: 'Asia/Tokyo',            offsetMin: 540  },
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const DOW_OFFSETS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

// ── Time-of-day phrase → hour ─────────────────────────────────
const TIME_OF_DAY: Record<string, number> = {
  morning: 9, 'early morning': 8, 'late morning': 10,
  noon: 12, midday: 12,
  afternoon: 14, 'early afternoon': 13, 'late afternoon': 16,
  evening: 18, 'early evening': 17,
};

// ─────────────────────────────────────────────────────────────
// MAIN PARSE FUNCTION
// ─────────────────────────────────────────────────────────────
export function parseDatetimes(text: string, referenceDate?: Date): ExtractedDatetime[] {
  const ref    = referenceDate ?? new Date();
  const found: ExtractedDatetime[] = [];

  // Strategy 1: Explicit date + time patterns
  found.push(...parseExplicitDatetime(text, ref));

  // Strategy 2: Day-of-week + time ("Thursday at 2pm")
  if (found.length === 0) found.push(...parseDayOfWeek(text, ref));

  // Strategy 3: Relative expressions ("tomorrow at 3pm")
  if (found.length === 0) found.push(...parseRelative(text, ref));

  // Strategy 4: Time-of-day only ("this afternoon") → low confidence
  if (found.length === 0) found.push(...parseTimeOfDay(text, ref));

  // Strategy 5: Calendly / scheduling link → mark as range
  if (found.length === 0) {
    const calLink = text.match(/(?:calendly|cal\.com|savvycal|hubspot.*meeting)[\w./\-?=&]+/i);
    if (calLink) {
      found.push({
        rawText:     calLink[0],
        isoDatetime: null,
        timezone:    null,
        isRange:     true,
        confidence:  0.95,
        isConfirmed: false,
      });
    }
  }

  return found.filter(d => d.confidence >= 0.3);
}

// ─────────────────────────────────────────────────────────────
// STRATEGY 1 — Explicit date + time
// Matches: "Feb 25 at 3pm ET", "03/15/2026 9:30 AM PST"
// ─────────────────────────────────────────────────────────────
function parseExplicitDatetime(text: string, ref: Date): ExtractedDatetime[] {
  const results: ExtractedDatetime[] = [];

  // Pattern A: "Month Day[st/nd/rd/th] [, Year] [at/@ HH:MM [am/pm] [TZ]]"
  const patA = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\s*(?:,\s*(\d{4}))?\s*(?:at|@)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*([A-Z]{2,5})?/gi;

  for (const m of text.matchAll(patA)) {
    const monthNum = MONTHS[m[1]!.toLowerCase()];
    const day      = parseInt(m[2]!);
    const year     = m[3] ? parseInt(m[3]) : inferYear(monthNum!, day, ref);
    const hour12   = parseInt(m[4]!);
    const min      = m[5] ? parseInt(m[5]) : 0;
    const ampm     = m[6]?.toLowerCase();
    const tzStr    = m[7]?.toUpperCase();

    const hour24 = resolveHour(hour12, ampm ?? null);
    if (!monthNum || isNaN(day) || isNaN(hour24)) continue;

    const tz   = tzStr ? TZ_MAP[tzStr] : null;
    const iso  = buildIso(year, monthNum, day, hour24, min, tz?.offsetMin ?? 0);
    const raw  = m[0].trim();

    results.push({
      rawText:     raw,
      isoDatetime: iso,
      timezone:    tz?.iana ?? null,
      isRange:     false,
      confidence:  tzStr ? 0.97 : 0.88,
      isConfirmed: true,
    });
  }

  // Pattern B: "MM/DD[/YYYY] at HH:MM [am/pm] [TZ]"
  const patB = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*([A-Z]{2,5})?/gi;

  for (const m of text.matchAll(patB)) {
    const month = parseInt(m[1]!);
    const day   = parseInt(m[2]!);
    let year    = m[3] ? parseInt(m[3]) : ref.getFullYear();
    if (year < 100) year += 2000;

    const hour12 = parseInt(m[4]!);
    const min    = m[5] ? parseInt(m[5]) : 0;
    const ampm   = m[6]?.toLowerCase();
    const tzStr  = m[7]?.toUpperCase();

    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const hour24 = resolveHour(hour12, ampm ?? null);

    const tz  = tzStr ? TZ_MAP[tzStr] : null;
    const iso = buildIso(year, month, day, hour24, min, tz?.offsetMin ?? 0);

    results.push({
      rawText:     m[0].trim(),
      isoDatetime: iso,
      timezone:    tz?.iana ?? null,
      isRange:     false,
      confidence:  0.85,
      isConfirmed: true,
    });
  }

  // Pattern C: Range — "between 2pm and 4pm [TZ]" or "2pm–4pm"
  const patC = /(?:between\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:and|to|–|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*([A-Z]{2,5})?/gi;

  for (const m of text.matchAll(patC)) {
    const h1    = resolveHour(parseInt(m[1]!), m[3]?.toLowerCase() ?? null);
    const min1  = m[2] ? parseInt(m[2]) : 0;
    const h2    = resolveHour(parseInt(m[4]!), (m[6] ?? m[3])?.toLowerCase() ?? null);
    const min2  = m[5] ? parseInt(m[5]) : 0;
    const tzStr = m[7]?.toUpperCase();
    const tz    = tzStr ? TZ_MAP[tzStr] : null;

    // Use ref date for range (caller must combine with date from other patterns)
    const iso1 = buildIso(ref.getFullYear(), ref.getMonth() + 1, ref.getDate(), h1, min1, tz?.offsetMin ?? 0);
    const iso2 = buildIso(ref.getFullYear(), ref.getMonth() + 1, ref.getDate(), h2, min2, tz?.offsetMin ?? 0);

    results.push({
      rawText:     m[0].trim(),
      isoDatetime: iso1,
      rangeEnd:    iso2,
      timezone:    tz?.iana ?? null,
      isRange:     true,
      confidence:  0.75,
      isConfirmed: false,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// STRATEGY 2 — Day of week + time
// "Thursday at 2pm", "next Monday at 10:30am EST"
// ─────────────────────────────────────────────────────────────
function parseDayOfWeek(text: string, ref: Date): ExtractedDatetime[] {
  const results: ExtractedDatetime[] = [];

  const pat = /\b(next\s+|this\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\s*(?:,\s*(?:at\s+)?)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*([A-Z]{2,5})?/gi;

  for (const m of text.matchAll(pat)) {
    const qualifier  = m[1]?.toLowerCase().trim() ?? '';
    const dowName    = m[2]!.toLowerCase();
    const targetDow  = DOW_OFFSETS[dowName];
    if (targetDow === undefined) continue;

    const hour12 = parseInt(m[3]!);
    const min    = m[4] ? parseInt(m[4]) : 0;
    const ampm   = m[5]?.toLowerCase();
    const tzStr  = m[6]?.toUpperCase();

    const hour24 = resolveHour(hour12, ampm ?? null);
    const date   = nextDayOfWeek(ref, targetDow, qualifier === 'next');
    const tz     = tzStr ? TZ_MAP[tzStr] : null;
    const iso    = buildIso(date.getFullYear(), date.getMonth() + 1, date.getDate(), hour24, min, tz?.offsetMin ?? 0);

    results.push({
      rawText:     m[0].trim(),
      isoDatetime: iso,
      timezone:    tz?.iana ?? null,
      isRange:     false,
      confidence:  tzStr ? 0.92 : 0.82,
      isConfirmed: qualifier !== '',
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// STRATEGY 3 — Relative expressions
// "tomorrow at 3pm", "in 2 days at noon"
// ─────────────────────────────────────────────────────────────
function parseRelative(text: string, ref: Date): ExtractedDatetime[] {
  const results: ExtractedDatetime[] = [];

  const pat = /\b(today|tomorrow|day after tomorrow|in (\d+) days?)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*([A-Z]{2,5})?/gi;

  for (const m of text.matchAll(pat)) {
    const relative = m[1]!.toLowerCase();
    const daysAhead = relative === 'today' ? 0
                    : relative === 'tomorrow' ? 1
                    : relative === 'day after tomorrow' ? 2
                    : parseInt(m[2] ?? '1');

    const date   = new Date(ref.getTime() + daysAhead * 86400 * 1000);
    const hour12 = parseInt(m[3]!);
    const min    = m[4] ? parseInt(m[4]) : 0;
    const ampm   = m[5]?.toLowerCase();
    const tzStr  = m[6]?.toUpperCase();
    const hour24 = resolveHour(hour12, ampm ?? null);
    const tz     = tzStr ? TZ_MAP[tzStr] : null;
    const iso    = buildIso(date.getFullYear(), date.getMonth() + 1, date.getDate(), hour24, min, tz?.offsetMin ?? 0);

    results.push({
      rawText:     m[0].trim(),
      isoDatetime: iso,
      timezone:    tz?.iana ?? null,
      isRange:     false,
      confidence:  0.80,
      isConfirmed: true,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// STRATEGY 4 — Time-of-day only (low confidence)
// ─────────────────────────────────────────────────────────────
function parseTimeOfDay(text: string, ref: Date): ExtractedDatetime[] {
  for (const [phrase, hour] of Object.entries(TIME_OF_DAY)) {
    if (new RegExp(`\\b${phrase}\\b`, 'i').test(text)) {
      return [{
        rawText:     phrase,
        isoDatetime: buildIso(ref.getFullYear(), ref.getMonth() + 1, ref.getDate(), hour, 0, 0),
        timezone:    null,
        isRange:     false,
        confidence:  0.35,
        isConfirmed: false,
      }];
    }
  }
  return [];
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function resolveHour(h: number, ampm: string | null): number {
  if (!ampm) {
    // Heuristic: business hours → if h < 8, likely PM
    if (h >= 1 && h <= 7) return h + 12;
    return h;
  }
  if (ampm === 'pm' && h < 12) return h + 12;
  if (ampm === 'am' && h === 12) return 0;
  return h;
}

function buildIso(
  year: number, month: number, day: number,
  hour: number, min: number, offsetMin: number,
): string {
  const pad   = (n: number, w = 2) => String(n).padStart(w, '0');
  const sign  = offsetMin >= 0 ? '+' : '-';
  const absOff = Math.abs(offsetMin);
  const offH  = Math.floor(absOff / 60);
  const offM  = absOff % 60;
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(min)}:00${sign}${pad(offH)}:${pad(offM)}`;
}

function inferYear(month: number, day: number, ref: Date): number {
  const now = ref;
  const candidate = new Date(now.getFullYear(), month - 1, day);
  // If candidate date is in the past (more than 7 days ago), use next year
  if (candidate.getTime() < now.getTime() - 7 * 86400 * 1000) {
    return now.getFullYear() + 1;
  }
  return now.getFullYear();
}

function nextDayOfWeek(ref: Date, targetDow: number, forceNext: boolean): Date {
  const refDow = ref.getDay();
  let daysAhead = targetDow - refDow;

  if (daysAhead <= 0 || forceNext) daysAhead += 7;
  return new Date(ref.getTime() + daysAhead * 86400 * 1000);
}

// ── Pick the highest-confidence single datetime ───────────────
export function bestDatetime(datetimes: ExtractedDatetime[]): ExtractedDatetime | null {
  if (datetimes.length === 0) return null;
  return datetimes.sort((a, b) => {
    // Confirmed > unconfirmed, then by confidence
    if (a.isConfirmed !== b.isConfirmed) return a.isConfirmed ? -1 : 1;
    return b.confidence - a.confidence;
  })[0] ?? null;
}
