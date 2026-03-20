// ============================================================
// Job Normaliser
// Converts every scraper's RawJob into the canonical
// NormalisedJob — the single JSON format used everywhere.
//
// Covers:
//   Salary  → USD/INR/GBP, k/L/lakh, hourly→annual
//   Dates   → "3 days ago", "2 weeks ago", ISO dates
//   Remote  → remote/hybrid/onsite from text
//   Level   → entry/mid/senior from title + years text
//   Location→ city / country extraction
//   Hash    → SHA-256 of title+company+url for dedup
// ============================================================

import { createHash } from 'crypto';
import type { RawJob, NormalisedJob, JobType, RemoteType, ExperienceLevel } from '../types/scraperTypes.js';

// ── Salary parser ─────────────────────────────────────────────
export function parseSalary(raw: string | null): NormalisedJob['salary'] {
  const blank: NormalisedJob['salary'] = {
    raw, min: null, max: null, currency: null, period: 'unknown', is_estimated: false,
  };
  if (!raw) return blank;

  const t = raw.toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ');

  // Currency detection
  let currency = 'USD';
  if (/£|gbp/.test(t))                               currency = 'GBP';
  else if (/€|eur/.test(t))                          currency = 'EUR';
  else if (/₹|inr|\blpa\b|\blakh\b|\bcrore\b/.test(t)) currency = 'INR';
  else if (/cad|\$\s*ca/.test(t))                    currency = 'CAD';
  else if (/aud|\$\s*au/.test(t))                    currency = 'AUD';
  else if (/sgd/.test(t))                            currency = 'SGD';

  // Period detection
  let period: NormalisedJob['salary']['period'] = 'annual';
  if (/\/\s*hr|per hour|hourly/.test(t))             period = 'hourly';
  else if (/\/\s*mo|per month|monthly/.test(t))      period = 'monthly';

  // Extract numbers — handles: "120k", "1.5L", "15 lakh", "80,000", "$45/hr"
  const nums: number[] = [];
  const numRx = /(\d+(?:\.\d+)?)\s*(k|l\b|lpa|lakh|cr|crore)?/gi;
  let m: RegExpExecArray | null;
  while ((m = numRx.exec(t)) !== null) {
    const val  = parseFloat(m[1]!);
    const unit = (m[2] ?? '').toLowerCase().replace('.', '');
    let n = val;
    if (unit === 'k')                          n = val * 1_000;
    else if (['l','lpa','lakh'].includes(unit))n = val * 100_000;
    else if (['cr','crore'].includes(unit))    n = val * 10_000_000;
    if (n >= 1_000 && n <= 20_000_000) nums.push(n);
  }

  if (!nums.length) return blank;
  nums.sort((a, b) => a - b);

  // hourly → annual  (assuming 2080 hrs/yr)
  const toAnnual = (v: number) => period === 'hourly' ? v * 2080 : v;

  return {
    raw,
    min:          toAnnual(nums[0]!),
    max:          nums.length > 1 ? toAnnual(nums[nums.length - 1]!) : null,
    currency,
    period:       period === 'hourly' ? 'annual' : period,
    is_estimated: /estimat|approx|up to/i.test(raw),
  };
}

// ── Date parser ───────────────────────────────────────────────
export function parsePostedDate(raw: string | null): Date | null {
  if (!raw) return null;
  const t   = raw.toLowerCase().trim();
  const now  = new Date();
  const ago  = (days: number) => { const d = new Date(now); d.setDate(d.getDate() - days); return d; };

  if (/just now|today|less than.+hour/.test(t)) return now;

  const hrsM  = t.match(/(\d+)\s*hour/);  if (hrsM)  return ago(parseFloat(hrsM[1]!) / 24);
  const daysM = t.match(/(\d+)\s*day/);   if (daysM) return ago(parseInt(daysM[1]!));
  const wksM  = t.match(/(\d+)\s*week/);  if (wksM)  return ago(parseInt(wksM[1]!) * 7);
  const mosM  = t.match(/(\d+)\s*month/); if (mosM)  return ago(parseInt(mosM[1]!) * 30);
  if (/yesterday/.test(t))               return ago(1);

  // ISO / natural date
  const isoM = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoM) return new Date(`${isoM[1]}-${isoM[2]}-${isoM[3]}`);

  try { const d = new Date(raw); if (!isNaN(d.getTime())) return d; } catch { /* ignore */ }
  return null;
}

// ── Job type parser ───────────────────────────────────────────
export function parseJobType(raw: string | null): JobType {
  if (!raw) return 'unknown';
  const t = raw.toLowerCase();
  if (/full.?time|permanent/.test(t)) return 'full_time';
  if (/part.?time/.test(t))           return 'part_time';
  if (/contract|contractor/.test(t))  return 'contract';
  if (/intern/.test(t))               return 'internship';
  if (/freelance|gig/.test(t))        return 'freelance';
  return 'unknown';
}

// ── Remote type parser ────────────────────────────────────────
export function parseRemoteType(remoteRaw: string | null, location: string | null): RemoteType {
  const t = `${remoteRaw ?? ''} ${location ?? ''}`.toLowerCase();
  if (/\bhybrid\b/.test(t))                                     return 'hybrid';
  if (/\bremote\b/.test(t) && !/office only|onsite/.test(t))   return 'remote';
  if (/\bonsite\b|in.person|office only/.test(t))               return 'onsite';
  if (location && !/remote/i.test(location) && location.length > 3) return 'onsite';
  return 'unknown';
}

// ── Experience level ──────────────────────────────────────────
export function parseExperienceLevel(raw: string | null, title: string): ExperienceLevel {
  const t = `${raw ?? ''} ${title}`.toLowerCase();
  if (/\b(cto|ceo|chief|president|evp)\b/.test(t))              return 'executive';
  if (/\b(vp|director|head of|principal|staff)\b/.test(t))      return 'lead';
  if (/\b(senior|sr\.?|lead)\b/.test(t))                        return 'senior';
  if (/\b(junior|jr\.?|associate|entry.?level|new.?grad|graduate|intern)\b/.test(t)) return 'entry';

  // Parse year ranges: "3-5 years", "5+ years"
  const rangeM = t.match(/(\d+)\s*[-–to]+\s*(\d+)\s*year/);
  if (rangeM) {
    const min = parseInt(rangeM[1]!);
    return min >= 8 ? 'senior' : min >= 4 ? 'mid' : 'entry';
  }
  const plusM = t.match(/(\d+)\+\s*year/);
  if (plusM) {
    const yr = parseInt(plusM[1]!);
    return yr >= 8 ? 'senior' : yr >= 4 ? 'mid' : 'entry';
  }
  return 'mid';
}

// ── Location parser ───────────────────────────────────────────
export function parseLocation(raw: string | null): { city: string | null; country: string | null } {
  if (!raw) return { city: null, country: null };
  const t = raw.trim();
  if (/^(remote|anywhere|worldwide|global)$/i.test(t)) return { city: null, country: null };

  const parts = t.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { city: parts[0]!, country: parts[parts.length - 1]! };
  return { city: t, country: null };
}

// ── Content hash ──────────────────────────────────────────────
export function computeContentHash(raw: RawJob): string {
  let url = raw.apply_link;
  try {
    const u = new URL(url);
    ['utm_source','utm_medium','utm_campaign','ref','refId','trk','trackingId'].forEach(p => u.searchParams.delete(p));
    url = u.toString();
  } catch { /* keep raw */ }

  const content = [
    raw.job_title.toLowerCase().trim(),
    raw.company.toLowerCase().trim(),
    url.toLowerCase().split('?')[0]!, // strip query string for hash
  ].join('||');

  return createHash('sha256').update(content).digest('hex');
}

// ── Strip HTML / normalise text ───────────────────────────────
export function cleanText(text: string | null, maxLen = 8000): string | null {
  if (!text) return null;
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, maxLen) || null;
}

// ── MAIN NORMALISE ────────────────────────────────────────────
export function normalise(raw: RawJob): NormalisedJob {
  const { city, country } = parseLocation(raw.location);

  return {
    job_title:        raw.job_title.trim(),
    company:          raw.company.trim(),
    platform:         raw.platform,
    source_job_id:    raw.source_job_id,
    content_hash:     computeContentHash(raw),

    location:         raw.location,
    city,
    country,
    remote_type:      parseRemoteType(raw.remote_raw, raw.location),

    description:      cleanText(raw.description),
    requirements:     cleanText(raw.requirements),
    job_type:         parseJobType(raw.job_type_raw),
    experience_level: parseExperienceLevel(raw.experience_raw, raw.job_title),

    salary: parseSalary(raw.salary_raw),

    apply_link:       raw.apply_link,
    company_logo_url: raw.company_logo_url,

    posted_at:  parsePostedDate(raw.posted_date_raw),
    scraped_at: new Date(raw.scraped_at),
    is_active:  true,
  };
}
