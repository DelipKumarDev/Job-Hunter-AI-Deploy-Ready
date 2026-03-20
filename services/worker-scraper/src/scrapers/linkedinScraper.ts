// ============================================================
// LinkedIn Jobs Scraper
// Scrapes linkedin.com/jobs/search using Playwright.
// Extracts job cards from listing page then visits each
// detail page to get full description, salary, and requirements.
//
// Strategy:
//  1. Build search URL with keywords, location, date filter
//  2. Scroll through listing page (25 jobs per page)
//  3. Click each card → extract full detail
//  4. Paginate until maxResults reached
// ============================================================

import type { Page } from 'playwright';
import type { RawJob, ScraperConfig, JobScraper } from '../types/scraperTypes.js';
import { createBrowserSession, closeBrowserSession } from '../browser/browserPool.js';
import { sleep, pageDelay, scrollDelay, clickDelay, randomDelay } from '../utils/delay.js';
import { logger } from '../utils/logger.js';

const BASE_URL = 'https://www.linkedin.com/jobs/search';

export class LinkedInScraper implements JobScraper {
  readonly platform    = 'linkedin' as const;
  readonly displayName = 'LinkedIn Jobs';
  readonly baseDelay   = 2500;

  async *scrape(config: ScraperConfig): AsyncGenerator<RawJob> {
    const session = await createBrowserSession(`linkedin_${config.userId}_${Date.now()}`);
    let totalYielded = 0;

    try {
      for (const keyword of config.keywords) {
        for (const location of config.locations) {
          if (totalYielded >= config.maxResultsPerPlatform) break;

          const url = buildSearchUrl(keyword, location, config);
          logger.info('LinkedIn: searching', { keyword, location, url });

          await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await pageDelay();

          // Scroll to load jobs (LinkedIn lazy-loads)
          await scrollListingPage(session.page);

          // Extract job card data (title, company, link, location, posted)
          const cards = await extractJobCards(session.page);
          logger.info(`LinkedIn: found ${cards.length} cards`, { keyword, location });

          for (const card of cards) {
            if (totalYielded >= config.maxResultsPerPlatform) break;
            if (!card.apply_link || !card.job_title || !card.company) continue;
            if (isExcluded(card.company, config.excludedCompanies)) continue;

            // Visit detail page for full description
            const detail = await scrapeJobDetail(session.page, card.apply_link);
            await randomDelay(1500, 3000);

            const raw: RawJob = {
              job_title:       card.job_title,
              company:         card.company,
              apply_link:      card.apply_link,
              platform:        'linkedin',
              scraped_at:      new Date().toISOString(),
              location:        detail.location ?? card.location,
              salary_raw:      detail.salary_raw ?? null,
              description:     detail.description ?? null,
              requirements:    null,
              posted_date_raw: card.posted_date_raw,
              job_type_raw:    detail.job_type_raw ?? null,
              remote_raw:      detail.remote_raw ?? card.location,
              experience_raw:  detail.experience_raw ?? null,
              source_job_id:   extractLinkedInJobId(card.apply_link),
              company_logo_url: card.company_logo_url,
            };

            yield raw;
            totalYielded++;
          }

          // Paginate — LinkedIn uses ?start=N
          let start = 25;
          while (totalYielded < config.maxResultsPerPlatform) {
            const paginatedUrl = `${url}&start=${start}`;
            await session.page.goto(paginatedUrl, { waitUntil: 'domcontentloaded' });
            await pageDelay();
            await scrollListingPage(session.page);

            const moreCards = await extractJobCards(session.page);
            if (moreCards.length === 0) break;

            for (const card of moreCards) {
              if (totalYielded >= config.maxResultsPerPlatform) break;
              if (!card.apply_link || !card.job_title || !card.company) continue;
              if (isExcluded(card.company, config.excludedCompanies)) continue;

              const detail = await scrapeJobDetail(session.page, card.apply_link);
              await randomDelay(1500, 3000);

              yield {
                job_title:       card.job_title,
                company:         card.company,
                apply_link:      card.apply_link,
                platform:        'linkedin',
                scraped_at:      new Date().toISOString(),
                location:        detail.location ?? card.location,
                salary_raw:      detail.salary_raw,
                description:     detail.description,
                requirements:    null,
                posted_date_raw: card.posted_date_raw,
                job_type_raw:    detail.job_type_raw,
                remote_raw:      detail.remote_raw ?? card.location,
                experience_raw:  detail.experience_raw,
                source_job_id:   extractLinkedInJobId(card.apply_link),
                company_logo_url: card.company_logo_url,
              };
              totalYielded++;
            }
            start += 25;
          }
        }
      }
    } catch (err) {
      logger.error('LinkedIn scraper error', { error: String(err) });
    } finally {
      await closeBrowserSession(session);
    }
  }
}

// ── Build search URL ──────────────────────────────────────────
function buildSearchUrl(keyword: string, location: string, config: ScraperConfig): string {
  const params = new URLSearchParams({
    keywords:  keyword,
    location:  location,
    f_TPR:     'r604800',  // Posted in last 7 days
    f_JT:      'F',        // Full-time (default)
    sortBy:    'DD',       // Most recent first
  });

  if (config.remoteOnly) params.set('f_WT', '2'); // Remote filter
  return `${BASE_URL}?${params}`;
}

// ── Scroll listing page to load all cards ────────────────────
async function scrollListingPage(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 600);
    await scrollDelay();
  }
  // Wait for job cards to appear
  await page.waitForSelector(
    '.job-search-card, .jobs-search__results-list li, [data-job-id]',
    { timeout: 8000 }
  ).catch(() => null);
}

// ── Extract job cards from listing page ───────────────────────
interface JobCard {
  job_title:       string;
  company:         string;
  location:        string | null;
  apply_link:      string;
  posted_date_raw: string | null;
  company_logo_url: string | null;
}

async function extractJobCards(page: Page): Promise<JobCard[]> {
  return page.evaluate(() => {
    const cards: {
      job_title: string; company: string; location: string | null;
      apply_link: string; posted_date_raw: string | null; company_logo_url: string | null;
    }[] = [];

    const selectors = [
      '.job-search-card',
      '.jobs-search__results-list li',
      '[data-job-id]',
      '.base-card',
    ];

    let items: NodeListOf<Element> | null = null;
    for (const sel of selectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) { items = found; break; }
    }
    if (!items) return cards;

    items.forEach(item => {
      const titleEl = item.querySelector(
        '.base-search-card__title, .job-card-list__title, h3.base-card__title, a.base-card__full-link'
      );
      const companyEl = item.querySelector(
        '.base-search-card__subtitle, .job-card-container__primary-description, h4'
      );
      const locationEl = item.querySelector(
        '.job-search-card__location, .job-card-container__metadata-item'
      );
      const linkEl = item.querySelector('a.base-card__full-link, a[data-tracking-id]');
      const timeEl = item.querySelector('time, .job-search-card__listdate');
      const logoEl = item.querySelector('img.artdeco-entity-image, img.job-search-card__company-image');

      const href = (linkEl as HTMLAnchorElement)?.href ?? '';
      if (!href || !titleEl?.textContent?.trim()) return;

      cards.push({
        job_title:       titleEl.textContent!.trim(),
        company:         companyEl?.textContent?.trim() ?? '',
        location:        locationEl?.textContent?.trim() ?? null,
        apply_link:      href.split('?')[0]!,
        posted_date_raw: timeEl?.getAttribute('datetime') ?? timeEl?.textContent?.trim() ?? null,
        company_logo_url:(logoEl as HTMLImageElement)?.src ?? null,
      });
    });

    return cards;
  });
}

// ── Visit job detail page ─────────────────────────────────────
interface JobDetail {
  description:    string | null;
  salary_raw:     string | null;
  job_type_raw:   string | null;
  remote_raw:     string | null;
  experience_raw: string | null;
  location:       string | null;
}

async function scrapeJobDetail(page: Page, url: string): Promise<JobDetail> {
  const blank: JobDetail = {
    description: null, salary_raw: null, job_type_raw: null,
    remote_raw: null, experience_raw: null, location: null,
  };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await clickDelay();

    // Expand "Show more" if present
    const showMore = page.locator('.show-more-less-html__button, button:has-text("Show more")').first();
    if (await showMore.isVisible({ timeout: 2000 }).catch(() => false)) {
      await showMore.click();
      await sleep(500);
    }

    return await page.evaluate(() => {
      const descEl = document.querySelector(
        '.description__text, .job-description, .show-more-less-html__markup'
      );
      const salaryEl = document.querySelector(
        '.salary-main-rail__compensation-text, .compensation__salary, [data-testid="job-salary"]'
      );
      const criteriaItems = document.querySelectorAll(
        '.description__job-criteria-item, .job-criteria-item'
      );

      let job_type_raw: string | null = null;
      let experience_raw: string | null = null;
      let remote_raw: string | null = null;

      criteriaItems.forEach(item => {
        const label = item.querySelector('h3')?.textContent?.toLowerCase() ?? '';
        const val   = item.querySelector('span')?.textContent?.trim() ?? '';
        if (/employment type/i.test(label)) job_type_raw   = val;
        if (/seniority level/i.test(label)) experience_raw = val;
        if (/work type|remote|location/i.test(label)) remote_raw = val;
      });

      const locationEl = document.querySelector(
        '.topcard__flavor--bullet, .job-details-jobs-unified-top-card__bullet'
      );

      return {
        description:    descEl?.innerHTML ?? null,
        salary_raw:     salaryEl?.textContent?.trim() ?? null,
        job_type_raw,
        experience_raw,
        remote_raw,
        location:       locationEl?.textContent?.trim() ?? null,
      };
    });
  } catch {
    return blank;
  }
}

function extractLinkedInJobId(url: string): string | null {
  const m = url.match(/\/view\/(\d+)/);
  return m?.[1] ?? null;
}

function isExcluded(company: string, excluded: string[]): boolean {
  return excluded.some(e => company.toLowerCase().includes(e.toLowerCase()));
}
