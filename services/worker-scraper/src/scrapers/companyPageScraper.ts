// ============================================================
// Company Career Page Scraper
// Scrapes company-specific career pages.
// Supports 6 major ATS platforms + generic HTML fallback.
//
// Supported ATS:
//  • Greenhouse  — boards.greenhouse.io
//  • Lever       — jobs.lever.co
//  • Workday     — myworkdayjobs.com
//  • Ashby       — jobs.ashbyhq.com
//  • SmartRecruiters — jobs.smartrecruiters.com
//  • BambooHR    — company.bamboohr.com/jobs
//  • Generic     — HTML scraping with heuristic selectors
// ============================================================

import type { Page } from 'playwright';
import type { RawJob, ScraperConfig, JobScraper, JobPlatform } from '../types/scraperTypes.js';
import { createBrowserSession, closeBrowserSession } from '../browser/browserPool.js';
import { pageDelay, randomDelay, scrollDelay } from '../utils/delay.js';
import { logger } from '../utils/logger.js';

// Company career page definitions
export interface CompanyCareerPage {
  company:   string;
  url:       string;
  ats:       'greenhouse' | 'lever' | 'workday' | 'ashby' | 'smartrecruiters' | 'bamboohr' | 'generic';
  logoUrl?:  string;
}

export class CompanyPageScraper implements JobScraper {
  readonly platform    = 'company_page' as const;
  readonly displayName = 'Company Career Pages';
  readonly baseDelay   = 2000;

  constructor(private readonly pages: CompanyCareerPage[]) {}

  async *scrape(config: ScraperConfig): AsyncGenerator<RawJob> {
    const session = await createBrowserSession(`careers_${config.userId}_${Date.now()}`);
    let totalYielded = 0;

    try {
      for (const careerPage of this.pages) {
        if (totalYielded >= config.maxResultsPerPlatform) break;

        logger.info('CompanyPage: scraping', { company: careerPage.company, ats: careerPage.ats });

        try {
          const jobs = await scrapeByAts(session.page, careerPage, config);

          for (const job of jobs) {
            if (totalYielded >= config.maxResultsPerPlatform) break;
            yield job;
            totalYielded++;
            await randomDelay(1500, 3000);
          }
        } catch (err) {
          logger.warn('CompanyPage: failed for company', {
            company: careerPage.company, error: String(err),
          });
        }
      }
    } finally {
      await closeBrowserSession(session);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// ATS DISPATCHER
// ─────────────────────────────────────────────────────────────
async function scrapeByAts(
  page: Page,
  careerPage: CompanyCareerPage,
  config: ScraperConfig,
): Promise<RawJob[]> {
  switch (careerPage.ats) {
    case 'greenhouse':     return scrapeGreenhouse(page, careerPage, config);
    case 'lever':          return scrapeLever(page, careerPage, config);
    case 'workday':        return scrapeWorkday(page, careerPage, config);
    case 'ashby':          return scrapeAshby(page, careerPage, config);
    case 'smartrecruiters':return scrapeSmartRecruiters(page, careerPage, config);
    case 'bamboohr':       return scrapeBambooHR(page, careerPage, config);
    default:               return scrapeGeneric(page, careerPage, config);
  }
}

// ─────────────────────────────────────────────────────────────
// GREENHOUSE SCRAPER
// boards.greenhouse.io/company — JSON API available
// ─────────────────────────────────────────────────────────────
async function scrapeGreenhouse(
  page: Page,
  careerPage: CompanyCareerPage,
  config: ScraperConfig,
): Promise<RawJob[]> {
  // Extract company slug from URL
  const slug = careerPage.url.split('/').filter(Boolean).pop() ?? '';
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;

  try {
    const response = await page.evaluate(async (url: string) => {
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
      return r.ok ? r.json() : null;
    }, apiUrl) as { jobs?: Array<{
      id: number; title: string; location: { name: string };
      updated_at: string; content: string; absolute_url: string;
    }> } | null;

    if (!response?.jobs) {
      // Fallback to HTML scraping
      return scrapeGreenhouseHtml(page, careerPage, config);
    }

    return matchingJobs(response.jobs, config).map(job => ({
      job_title:       job.title,
      company:         careerPage.company,
      apply_link:      job.absolute_url,
      platform:        'greenhouse' as JobPlatform,
      scraped_at:      new Date().toISOString(),
      location:        job.location?.name ?? null,
      salary_raw:      null,
      description:     job.content ?? null,
      requirements:    null,
      posted_date_raw: job.updated_at ?? null,
      job_type_raw:    'Full-time',
      remote_raw:      job.location?.name ?? null,
      experience_raw:  null,
      source_job_id:   String(job.id),
      company_logo_url: careerPage.logoUrl ?? null,
    }));
  } catch {
    return scrapeGreenhouseHtml(page, careerPage, config);
  }
}

async function scrapeGreenhouseHtml(
  page: Page, careerPage: CompanyCareerPage, config: ScraperConfig,
): Promise<RawJob[]> {
  await page.goto(careerPage.url, { waitUntil: 'domcontentloaded' });
  await pageDelay();

  return page.evaluate((company: string, logoUrl: string | undefined, _config: unknown) => {
    const jobs: {
      job_title: string; company: string; apply_link: string; platform: string;
      scraped_at: string; location: string | null; salary_raw: null; description: null;
      requirements: null; posted_date_raw: null; job_type_raw: string; remote_raw: null;
      experience_raw: null; source_job_id: null; company_logo_url: string | null;
    }[] = [];

    document.querySelectorAll('.opening').forEach(item => {
      const titleEl = item.querySelector('.title, a');
      const locEl   = item.querySelector('.location');
      const href    = (titleEl as HTMLAnchorElement)?.href ?? '';

      if (titleEl?.textContent?.trim() && href) {
        jobs.push({
          job_title:       titleEl.textContent!.trim(),
          company,
          apply_link:      href,
          platform:        'greenhouse',
          scraped_at:      new Date().toISOString(),
          location:        locEl?.textContent?.trim() ?? null,
          salary_raw:      null, description: null, requirements: null,
          posted_date_raw: null, job_type_raw: 'Full-time', remote_raw: null,
          experience_raw: null, source_job_id: null,
          company_logo_url: logoUrl ?? null,
        });
      }
    });
    return jobs;
  }, careerPage.company, careerPage.logoUrl, config) as Promise<RawJob[]>;
}

// ─────────────────────────────────────────────────────────────
// LEVER SCRAPER
// jobs.lever.co/company — JSON API available
// ─────────────────────────────────────────────────────────────
async function scrapeLever(
  page: Page,
  careerPage: CompanyCareerPage,
  config: ScraperConfig,
): Promise<RawJob[]> {
  const slug = careerPage.url.split('/').filter(Boolean).pop() ?? '';
  const apiUrl = `https://api.lever.co/v0/postings/${slug}?mode=json&limit=250`;

  try {
    const postings = await page.evaluate(async (url: string) => {
      const r = await fetch(url);
      return r.ok ? r.json() : null;
    }, apiUrl) as Array<{
      id: string; text: string; categories: { location: string; team: string; commitment: string; workplaceType: string };
      createdAt: number; hostedUrl: string; descriptionPlain: string; additionalPlain: string;
    }> | null;

    if (!postings) return [];

    return matchingJobs(postings.map(p => ({ title: p.text, location: { name: p.categories.location } })), config)
      .map((_, i) => {
        const p = postings[i]!;
        return {
          job_title:       p.text,
          company:         careerPage.company,
          apply_link:      p.hostedUrl,
          platform:        'lever' as JobPlatform,
          scraped_at:      new Date().toISOString(),
          location:        p.categories.location ?? null,
          salary_raw:      null,
          description:     p.descriptionPlain ?? null,
          requirements:    p.additionalPlain ?? null,
          posted_date_raw: p.createdAt ? new Date(p.createdAt).toISOString() : null,
          job_type_raw:    p.categories.commitment ?? null,
          remote_raw:      p.categories.workplaceType ?? p.categories.location ?? null,
          experience_raw:  null,
          source_job_id:   p.id,
          company_logo_url: careerPage.logoUrl ?? null,
        };
      });
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// WORKDAY SCRAPER  (HTML — no public API)
// ─────────────────────────────────────────────────────────────
async function scrapeWorkday(
  page: Page,
  careerPage: CompanyCareerPage,
  config: ScraperConfig,
): Promise<RawJob[]> {
  await page.goto(careerPage.url, { waitUntil: 'networkidle', timeout: 30000 });
  await pageDelay();

  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 800);
    await scrollDelay();
  }

  return page.evaluate((company: string, logoUrl: string | undefined) => {
    const jobs: RawJob[] = [];
    const items = document.querySelectorAll(
      '[data-automation-id="jobTitle"], .gwt-InlineHyperlink, [class*="job-posting"]'
    );

    items.forEach(item => {
      const title = item.textContent?.trim() ?? '';
      const href  = (item as HTMLAnchorElement).href ?? item.closest('a')?.href ?? '';
      if (!title || !href) return;

      jobs.push({
        job_title:  title,
        company,
        apply_link: href,
        platform:   'workday' as JobPlatform,
        scraped_at: new Date().toISOString(),
        location:   null, salary_raw: null, description: null, requirements: null,
        posted_date_raw: null, job_type_raw: null, remote_raw: null,
        experience_raw: null, source_job_id: null,
        company_logo_url: logoUrl ?? null,
      } as RawJob);
    });
    return jobs;
  }, careerPage.company, careerPage.logoUrl) as Promise<RawJob[]>;
}

// ─────────────────────────────────────────────────────────────
// ASHBY SCRAPER (JSON API)
// ─────────────────────────────────────────────────────────────
async function scrapeAshby(
  page: Page,
  careerPage: CompanyCareerPage,
  config: ScraperConfig,
): Promise<RawJob[]> {
  const slug = careerPage.url.split('/').filter(Boolean).pop() ?? '';
  const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${slug}`;

  try {
    const data = await page.evaluate(async (url: string) => {
      const r = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
      return r.ok ? r.json() : null;
    }, apiUrl) as { jobs?: Array<{
      id: string; title: string; locationName: string; employmentType: string;
      publishedDate: string; jobUrl: string; descriptionHtml: string;
      isRemote: boolean; compensation?: { minValue: number; maxValue: number; currency: string };
    }> } | null;

    if (!data?.jobs) return [];

    return matchingJobs(
      data.jobs.map(j => ({ title: j.title, location: { name: j.locationName } })),
      config,
    ).map((_, i) => {
      const j = data.jobs![i]!;
      const salary = j.compensation
        ? `${j.compensation.currency} ${j.compensation.minValue}–${j.compensation.maxValue}`
        : null;

      return {
        job_title:       j.title,
        company:         careerPage.company,
        apply_link:      j.jobUrl,
        platform:        'ashby' as JobPlatform,
        scraped_at:      new Date().toISOString(),
        location:        j.locationName ?? null,
        salary_raw:      salary,
        description:     j.descriptionHtml ?? null,
        requirements:    null,
        posted_date_raw: j.publishedDate ?? null,
        job_type_raw:    j.employmentType ?? null,
        remote_raw:      j.isRemote ? 'Remote' : j.locationName ?? null,
        experience_raw:  null,
        source_job_id:   j.id,
        company_logo_url: careerPage.logoUrl ?? null,
      };
    });
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// SMARTRECRUITERS SCRAPER (API)
// ─────────────────────────────────────────────────────────────
async function scrapeSmartRecruiters(
  page: Page, careerPage: CompanyCareerPage, config: ScraperConfig,
): Promise<RawJob[]> {
  const slug = careerPage.url.split('/').filter(Boolean).pop() ?? '';
  const apiUrl = `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`;

  try {
    const data = await page.evaluate(async (url: string) => {
      const r = await fetch(url);
      return r.ok ? r.json() : null;
    }, apiUrl) as { content?: Array<{
      id: string; name: string; location: { city: string; country: string; remote: boolean };
      typeOfEmployment: { label: string }; releasedDate: string; ref: string;
    }> } | null;

    if (!data?.content) return [];

    return matchingJobs(
      data.content.map(j => ({ title: j.name, location: { name: j.location.city } })),
      config,
    ).map((_, i) => {
      const j = data.content![i]!;
      return {
        job_title:       j.name,
        company:         careerPage.company,
        apply_link:      j.ref,
        platform:        'smartrecruiters' as JobPlatform,
        scraped_at:      new Date().toISOString(),
        location:        [j.location.city, j.location.country].filter(Boolean).join(', '),
        salary_raw:      null,
        description:     null,
        requirements:    null,
        posted_date_raw: j.releasedDate ?? null,
        job_type_raw:    j.typeOfEmployment?.label ?? null,
        remote_raw:      j.location.remote ? 'Remote' : null,
        experience_raw:  null,
        source_job_id:   j.id,
        company_logo_url: careerPage.logoUrl ?? null,
      };
    });
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// BAMBOOHR SCRAPER (API)
// ─────────────────────────────────────────────────────────────
async function scrapeBambooHR(
  page: Page, careerPage: CompanyCareerPage, config: ScraperConfig,
): Promise<RawJob[]> {
  const slug = careerPage.url.split('/').filter(Boolean).find(p => !['jobs','careers'].includes(p)) ?? '';
  const apiUrl = `https://${slug}.bamboohr.com/jobs/embed2/json`;

  try {
    const data = await page.evaluate(async (url: string) => {
      const r = await fetch(url);
      return r.ok ? r.json() : null;
    }, apiUrl) as { result?: Array<{
      id: string; jobOpeningName: string; location: { city: string; state: string; country: string };
      employmentStatusLabel: string; datePosted: string; applicationUrl: string;
    }> } | null;

    if (!data?.result) return [];

    return matchingJobs(
      data.result.map(j => ({ title: j.jobOpeningName, location: { name: j.location.city } })),
      config,
    ).map((_, i) => {
      const j = data.result![i]!;
      const loc = [j.location.city, j.location.state, j.location.country].filter(Boolean).join(', ');
      return {
        job_title:       j.jobOpeningName,
        company:         careerPage.company,
        apply_link:      j.applicationUrl,
        platform:        'bamboohr' as JobPlatform,
        scraped_at:      new Date().toISOString(),
        location:        loc || null,
        salary_raw:      null,
        description:     null,
        requirements:    null,
        posted_date_raw: j.datePosted ?? null,
        job_type_raw:    j.employmentStatusLabel ?? null,
        remote_raw:      null,
        experience_raw:  null,
        source_job_id:   j.id,
        company_logo_url: careerPage.logoUrl ?? null,
      };
    });
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// GENERIC CAREER PAGE SCRAPER
// HTML heuristics for companies not on major ATS
// ─────────────────────────────────────────────────────────────
async function scrapeGeneric(
  page: Page, careerPage: CompanyCareerPage, config: ScraperConfig,
): Promise<RawJob[]> {
  await page.goto(careerPage.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await pageDelay();

  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 700);
    await scrollDelay();
  }

  return page.evaluate((company: string, baseUrl: string, logoUrl: string | undefined) => {
    const jobs: RawJob[] = [];

    // Generic job card selectors ranked by specificity
    const cardSelectors = [
      '[class*="job-posting"] a', '[class*="position"] a', '[class*="career"] a',
      '[class*="opening"] a', 'tr.job a', 'li.job a',
      'a[href*="/jobs/"], a[href*="/careers/"], a[href*="/positions/"]',
    ];

    const seen = new Set<string>();

    for (const sel of cardSelectors) {
      document.querySelectorAll(sel).forEach(el => {
        const a = (el.tagName === 'A' ? el : el.closest('a')) as HTMLAnchorElement | null;
        if (!a?.href) return;

        const href  = a.href.startsWith('http') ? a.href : `${baseUrl}${a.href}`;
        const title = a.textContent?.trim() ?? el.textContent?.trim() ?? '';

        if (!title || title.length < 3 || seen.has(href)) return;
        seen.add(href);

        // Try to find location near this link
        const parent   = a.closest('tr, li, [class*="job"], [class*="position"], [class*="opening"]');
        const locationEl = parent?.querySelector('[class*="location"], [class*="city"], [class*="where"]');

        jobs.push({
          job_title:  title,
          company,
          apply_link: href,
          platform:   'company_page' as JobPlatform,
          scraped_at: new Date().toISOString(),
          location:   locationEl?.textContent?.trim() ?? null,
          salary_raw: null, description: null, requirements: null,
          posted_date_raw: null, job_type_raw: null, remote_raw: null,
          experience_raw: null, source_job_id: null,
          company_logo_url: logoUrl ?? null,
        } as RawJob);
      });
      if (jobs.length > 0) break;
    }

    return jobs;
  }, careerPage.company, new URL(careerPage.url).origin, careerPage.logoUrl) as Promise<RawJob[]>;
}

// ── Filter jobs matching search config ────────────────────────
function matchingJobs<T extends { title: string; location?: { name: string } }>(
  jobs: T[],
  config: ScraperConfig,
): T[] {
  if (config.keywords.length === 0) return jobs;

  return jobs.filter(job => {
    const titleLower = job.title.toLowerCase();
    const locLower   = (job.location?.name ?? '').toLowerCase();

    // Match any keyword
    const keywordMatch = config.keywords.some(kw =>
      titleLower.includes(kw.toLowerCase()) ||
      kw.toLowerCase().split(' ').some(word => titleLower.includes(word))
    );

    // Location filter (only if not remote-only)
    const locationMatch = config.remoteOnly
      ? locLower.includes('remote') || locLower === ''
      : config.locations.length === 0 ||
        config.locations.some(loc =>
          locLower.includes(loc.toLowerCase()) || /remote/i.test(locLower)
        );

    return keywordMatch && locationMatch;
  });
}
