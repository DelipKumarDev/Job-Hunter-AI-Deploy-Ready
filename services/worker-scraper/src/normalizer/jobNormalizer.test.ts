// ============================================================
// Job Normaliser — Unit Tests
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  parseSalary, parsePostedDate, parseJobType,
  parseRemoteType, parseExperienceLevel, parseLocation,
  computeContentHash, cleanText, normalise,
} from '../normalizer/jobNormalizer.js';
import type { RawJob } from '../types/scraperTypes.js';

// ── Salary ────────────────────────────────────────────────────
describe('parseSalary', () => {
  it('parses USD range with k suffix', () => {
    const s = parseSalary('$120k–$150k/yr');
    expect(s.min).toBe(120_000);
    expect(s.max).toBe(150_000);
    expect(s.currency).toBe('USD');
    expect(s.period).toBe('annual');
  });

  it('parses INR LPA range', () => {
    const s = parseSalary('₹15–20 LPA');
    expect(s.min).toBe(1_500_000);
    expect(s.max).toBe(2_000_000);
    expect(s.currency).toBe('INR');
  });

  it('parses GBP annual', () => {
    const s = parseSalary('£50,000/yr');
    expect(s.min).toBe(50_000);
    expect(s.currency).toBe('GBP');
  });

  it('converts hourly to annual', () => {
    const s = parseSalary('$45/hr');
    expect(s.min).toBe(45 * 2080);
    expect(s.period).toBe('annual');
  });

  it('handles null gracefully', () => {
    const s = parseSalary(null);
    expect(s.min).toBeNull();
    expect(s.max).toBeNull();
    expect(s.currency).toBeNull();
  });

  it('marks estimated salary', () => {
    const s = parseSalary('Estimated $90k–$110k');
    expect(s.is_estimated).toBe(true);
  });

  it('returns unknown period for non-numeric', () => {
    const s = parseSalary('Competitive');
    expect(s.min).toBeNull();
  });

  it('parses EUR with € symbol', () => {
    const s = parseSalary('€80k–€100k');
    expect(s.currency).toBe('EUR');
    expect(s.min).toBe(80_000);
  });

  it('parses single value (no range)', () => {
    const s = parseSalary('$95,000');
    expect(s.min).toBe(95_000);
    expect(s.max).toBeNull();
  });
});

// ── Date parsing ──────────────────────────────────────────────
describe('parsePostedDate', () => {
  it('returns null for null input', () => {
    expect(parsePostedDate(null)).toBeNull();
  });

  it('parses "today"', () => {
    const d = parsePostedDate('today');
    expect(d).not.toBeNull();
    expect(d!.toDateString()).toBe(new Date().toDateString());
  });

  it('parses "3 days ago"', () => {
    const d = parsePostedDate('3 days ago')!;
    const expected = new Date();
    expected.setDate(expected.getDate() - 3);
    expect(d.toDateString()).toBe(expected.toDateString());
  });

  it('parses "2 weeks ago"', () => {
    const d = parsePostedDate('2 weeks ago')!;
    const expected = new Date();
    expected.setDate(expected.getDate() - 14);
    expect(d.toDateString()).toBe(expected.toDateString());
  });

  it('parses "1 month ago"', () => {
    const d = parsePostedDate('1 month ago')!;
    expect(d).not.toBeNull();
    // Should be ~30 days ago
    const diff = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
    expect(diff).toBeGreaterThanOrEqual(28);
    expect(diff).toBeLessThanOrEqual(32);
  });

  it('parses ISO date string', () => {
    const d = parsePostedDate('2024-03-15')!;
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(2); // March = 2 (0-indexed)
    expect(d.getDate()).toBe(15);
  });

  it('parses "yesterday"', () => {
    const d = parsePostedDate('yesterday')!;
    const expected = new Date();
    expected.setDate(expected.getDate() - 1);
    expect(d.toDateString()).toBe(expected.toDateString());
  });
});

// ── Job type ──────────────────────────────────────────────────
describe('parseJobType', () => {
  it('detects full-time', () => {
    expect(parseJobType('Full-time')).toBe('full_time');
    expect(parseJobType('Permanent')).toBe('full_time');
  });

  it('detects contract', () => {
    expect(parseJobType('Contract')).toBe('contract');
    expect(parseJobType('Contractor Role')).toBe('contract');
  });

  it('detects internship', () => {
    expect(parseJobType('Intern')).toBe('internship');
    expect(parseJobType('Summer Internship')).toBe('internship');
  });

  it('returns unknown for null', () => {
    expect(parseJobType(null)).toBe('unknown');
  });
});

// ── Remote type ───────────────────────────────────────────────
describe('parseRemoteType', () => {
  it('detects remote', () => {
    expect(parseRemoteType('Remote', null)).toBe('remote');
    expect(parseRemoteType(null, 'Remote, USA')).toBe('remote');
  });

  it('detects hybrid', () => {
    expect(parseRemoteType('Hybrid', 'London')).toBe('hybrid');
  });

  it('detects onsite from location', () => {
    expect(parseRemoteType(null, 'New York, NY')).toBe('onsite');
  });

  it('returns unknown when no signal', () => {
    expect(parseRemoteType(null, null)).toBe('unknown');
  });
});

// ── Experience level ──────────────────────────────────────────
describe('parseExperienceLevel', () => {
  it('detects senior from title', () => {
    expect(parseExperienceLevel(null, 'Senior Software Engineer')).toBe('senior');
  });

  it('detects junior from title', () => {
    expect(parseExperienceLevel(null, 'Junior Frontend Developer')).toBe('entry');
  });

  it('detects executive from title', () => {
    expect(parseExperienceLevel(null, 'VP of Engineering')).toBe('executive');
  });

  it('detects lead from title', () => {
    expect(parseExperienceLevel(null, 'Principal Engineer')).toBe('lead');
  });

  it('infers mid from year range 3-5', () => {
    expect(parseExperienceLevel('3-5 years experience', 'Software Engineer')).toBe('mid');
  });

  it('infers senior from year range 8+', () => {
    expect(parseExperienceLevel('8+ years required', 'Engineer')).toBe('senior');
  });

  it('defaults to mid without signals', () => {
    expect(parseExperienceLevel(null, 'Software Engineer')).toBe('mid');
  });
});

// ── Location parser ───────────────────────────────────────────
describe('parseLocation', () => {
  it('parses city, country', () => {
    const { city, country } = parseLocation('Bangalore, India');
    expect(city).toBe('Bangalore');
    expect(country).toBe('India');
  });

  it('parses city, state, country', () => {
    const { city, country } = parseLocation('Austin, TX, United States');
    expect(city).toBe('Austin');
    expect(country).toBe('United States');
  });

  it('returns null for Remote', () => {
    const { city, country } = parseLocation('Remote');
    expect(city).toBeNull();
    expect(country).toBeNull();
  });

  it('handles null', () => {
    const { city, country } = parseLocation(null);
    expect(city).toBeNull();
    expect(country).toBeNull();
  });
});

// ── Content hash ──────────────────────────────────────────────
describe('computeContentHash', () => {
  const makeRaw = (overrides: Partial<RawJob>): RawJob => ({
    job_title: 'Senior Engineer', company: 'Acme Corp',
    apply_link: 'https://jobs.example.com/123',
    platform: 'linkedin', scraped_at: new Date().toISOString(),
    location: null, salary_raw: null, description: null, requirements: null,
    posted_date_raw: null, job_type_raw: null, remote_raw: null,
    experience_raw: null, source_job_id: null, company_logo_url: null,
    ...overrides,
  });

  it('produces 64-char hex hash', () => {
    const hash = computeContentHash(makeRaw({}));
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('same inputs → same hash (deterministic)', () => {
    const raw = makeRaw({});
    expect(computeContentHash(raw)).toBe(computeContentHash(raw));
  });

  it('strips UTM params before hashing', () => {
    const withUtm    = makeRaw({ apply_link: 'https://jobs.example.com/123?utm_source=linkedin&utm_medium=social' });
    const withoutUtm = makeRaw({ apply_link: 'https://jobs.example.com/123' });
    expect(computeContentHash(withUtm)).toBe(computeContentHash(withoutUtm));
  });

  it('different title → different hash', () => {
    const a = computeContentHash(makeRaw({ job_title: 'Senior Engineer' }));
    const b = computeContentHash(makeRaw({ job_title: 'Junior Engineer' }));
    expect(a).not.toBe(b);
  });
});

// ── cleanText ─────────────────────────────────────────────────
describe('cleanText', () => {
  it('strips HTML tags', () => {
    expect(cleanText('<p>Hello <strong>world</strong></p>')).toBe('Hello world');
  });

  it('decodes HTML entities', () => {
    expect(cleanText('React &amp; TypeScript')).toBe('React & TypeScript');
  });

  it('collapses whitespace', () => {
    expect(cleanText('foo   bar\n\tbaz')).toBe('foo bar baz');
  });

  it('returns null for null input', () => {
    expect(cleanText(null)).toBeNull();
  });

  it('truncates at maxLen', () => {
    const longText = 'a'.repeat(9000);
    const result = cleanText(longText, 8000);
    expect(result!.length).toBe(8000);
  });
});

// ── Full normalise pipeline ───────────────────────────────────
describe('normalise', () => {
  const raw: RawJob = {
    job_title:       'Senior React Developer',
    company:         'Stripe',
    apply_link:      'https://boards.greenhouse.io/stripe/jobs/123?ref=linkedin',
    platform:        'greenhouse',
    scraped_at:      new Date().toISOString(),
    location:        'Remote, USA',
    salary_raw:      '$140k–$180k/yr',
    description:     '<p>Build great products</p>',
    requirements:    'React, TypeScript, 5+ years',
    posted_date_raw: '2 days ago',
    job_type_raw:    'Full-time',
    remote_raw:      'Remote',
    experience_raw:  '5+ years required',
    source_job_id:   '123',
    company_logo_url: 'https://logo.clearbit.com/stripe.com',
  };

  const job = normalise(raw);

  it('preserves required fields', () => {
    expect(job.job_title).toBe('Senior React Developer');
    expect(job.company).toBe('Stripe');
    expect(job.platform).toBe('greenhouse');
    expect(job.apply_link).toBe('https://boards.greenhouse.io/stripe/jobs/123?ref=linkedin');
  });

  it('parses salary correctly', () => {
    expect(job.salary.min).toBe(140_000);
    expect(job.salary.max).toBe(180_000);
    expect(job.salary.currency).toBe('USD');
  });

  it('strips HTML from description', () => {
    expect(job.description).toBe('Build great products');
  });

  it('detects remote type', () => {
    expect(job.remote_type).toBe('remote');
  });

  it('detects experience level', () => {
    expect(job.experience_level).toBe('senior');
  });

  it('detects job type', () => {
    expect(job.job_type).toBe('full_time');
  });

  it('populates content hash', () => {
    expect(job.content_hash).toHaveLength(64);
  });

  it('sets is_active true', () => {
    expect(job.is_active).toBe(true);
  });

  it('parses posted_at date', () => {
    expect(job.posted_at).not.toBeNull();
    expect(job.posted_at instanceof Date).toBe(true);
  });
});
