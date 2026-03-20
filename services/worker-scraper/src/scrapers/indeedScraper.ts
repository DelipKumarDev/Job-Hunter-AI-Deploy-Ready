// ============================================================
// Indeed Jobs Scraper
// Scrapes indeed.com/jobs with keyword + location search.
// Indeed has strong bot detection — uses stealth browser,
// conservative delays, and page randomisation.
//
// Strategy:
//  1. Search URL with q (keyword) + l (location)
//  2. Extract job cards from listing (employer, title, salary)
//  3. Click each card → full description from detail pane
//  4. Paginate via ?start=N (10 per page)
// ============================================================

import type { Page } from 'playwright';
import type { RawJob, ScraperConfig, JobScraper } from '../types/scraperTypes.js';
import { createBrowserSession, closeBrowserSession } from '../browser/browserPool.js';
import { sleep, pageDelay, randomDelay, scrollDelay } from '../utils/delay.js';
import { logger } from '../utils/logger.js';

const BASE_URL = 'https://www.indeed.com/jobs';

export class IndeedScraper implements JobScraper {
  readonly platform    = 'indeed' as const;
  readonly displayName = 'Indeed';
  readonly baseDelay   = 3000;

  async *scrape(config: ScraperConfig): AsyncGenerator<RawJob> {
    const session = await createBrowserSession(`indeed_${config.userId}_${Date.now()}`);
    let totalYielded = 0;

    try {
      for (const keyword of config.keywords) {
        for (const location of config.locations) {
          if (totalYielded >= config.maxResultsPerPlatform) break;

          // Navigate to search with human-like wait
          const url = buildIndeedUrl(keyword, location, config);
          logger.info('Indeed: searching', { keyword, location });

          await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await pageDelay();

          // Handle CAPTCHA / verification pages
          if (await isCaptchaPage(session.page)) {
            logger.warn('Indeed: CAPTCHA detected, skipping');
            break;
          }

          let start = 0;
          while (totalYielded < config.maxResultsPerPlatform) {
            if (start > 0) {
              const paginatedUrl = `${url}&start=${start}`;
              await session.page.goto(paginatedUrl, { waitUntil: 'domcontentloaded' });
              await pageDelay();
            }

            const cards = await extractIndeedCards(session.page);
            if (cards.length === 0) break;

            for (const card of cards) {
              if (totalYielded >= config.maxResultsPerPlatform) break;
              if (isExcluded(card.company, config.excludedCompanies)) continue;

              // Click card to load description in detail pane
              const description = await loadIndeedDescription(session.page, card.element_id);
              await randomDelay(1500, 3500);

              yield {
                job_title:       card.job_title,
                company:         card.company,
                apply_link:      card.apply_link,
                platform:        'indeed',
                scraped_at:      new Date().toISOString(),
                location:        card.location,
                salary_raw:      card.salary_raw,
                description,
                requirements:    null,
                posted_date_raw: card.posted_date_raw,
                job_type_raw:    card.job_type_raw,
                remote_raw:      card.remote_raw,
                experience_raw:  null,
                source_job_id:   card.job_key,
                company_logo_url: card.company_logo_url,
              };
              totalYielded++;
            }

            // Check if next page exists
            const hasNext = await session.page.locator('a[data-testid="pagination-page-next"], a[aria-label="Next Page"]')
              .isVisible({ timeout: 2000 }).catch(() => false);
            if (!hasNext) break;
            start += 10;
          }
        }
      }
    } catch (err) {
      logger.error('Indeed scraper error', { error: String(err) });
    } finally {
      await closeBrowserSession(session);
    }
  }
}

// ── URL builder ───────────────────────────────────────────────
function buildIndeedUrl(keyword: string, location: string, config: ScraperConfig): string {
  const params = new URLSearchParams({
    q:       keyword,
    l:       config.remoteOnly ? 'Remote' : location,
    fromage: '7',      // Last 7 days
    sort:    'date',   // Newest first
  });
  if (config.remoteOnly) params.set('sc', '0kf:attr(DSQF7);');
  return `${BASE_URL}?${params}`;
}

// ── Job card extraction ───────────────────────────────────────
interface IndeedCard {
  job_title:       string;
  company:         string;
  location:        string | null;
  apply_link:      string;
  salary_raw:      string | null;
  posted_date_raw: string | null;
  job_type_raw:    string | null;
  remote_raw:      string | null;
  job_key:         string | null;
  company_logo_url: string | null;
  element_id:      string;         // For clicking the detail pane
}

async function extractIndeedCards(page: Page): Promise<IndeedCard[]> {
  return page.evaluate(() => {
    const results: {
      job_title: string; company: string; location: string | null;
      apply_link: string; salary_raw: string | null; posted_date_raw: string | null;
      job_type_raw: string | null; remote_raw: string | null;
      job_key: string | null; company_logo_url: string | null; element_id: string;
    }[] = [];

    const cards = document.querySelectorAll(
      '[data-jk], .job_seen_beacon, .result, [class*="jobCard"]'
    );

    cards.forEach(card => {
      const titleEl   = card.querySelector('h2 a span, [data-testid="jobTitle"] span, .jobTitle span');
      const companyEl = card.querySelector('[data-testid="company-name"], .companyName, .company');
      const locationEl= card.querySelector('[data-testid="text-location"], .companyLocation, .location');
      const salaryEl  = card.querySelector('[data-testid="attribute_snippet_testid"], .salary-snippet, .estimated-salary');
      const dateEl    = card.querySelector('[data-testid="myJobsStateDate"], .date, .result-link-bar-container .date');
      const logoEl    = card.querySelector('img[class*="company"]');
      const linkEl    = card.querySelector('a[id^="job_"], a[data-jk]') ?? card.querySelector('h2 a');

      const jobKey     = card.getAttribute('data-jk') ?? card.getAttribute('data-jobkey');
      const href       = (linkEl as HTMLAnchorElement)?.href ?? '';
      const titleText  = titleEl?.textContent?.trim() ?? '';
      const compText   = companyEl?.textContent?.trim() ?? '';

      if (!titleText || !compText || !href) return;

      // Detect remote from location text
      const locText = locationEl?.textContent?.trim() ?? null;
      const remote  = locText?.toLowerCase().includes('remote') ? locText : null;

      // Detect job type from salary/metadata
      const salaryText = salaryEl?.textContent?.trim() ?? null;
      const jobType = card.querySelector('[data-testid="attribute_snippet_testid"]')?.textContent?.includes('Full-time')
        ? 'Full-time' : null;

      results.push({
        job_title:       titleText,
        company:         compText,
        location:        locText,
        apply_link:      href.startsWith('http') ? href : `https://www.indeed.com${href}`,
        salary_raw:      salaryText,
        posted_date_raw: dateEl?.textContent?.trim() ?? null,
        job_type_raw:    jobType,
        remote_raw:      remote,
        job_key:         jobKey,
        company_logo_url:(logoEl as HTMLImageElement)?.src ?? null,
        element_id:      jobKey ?? '',
      });
    });

    return results;
  });
}

// ── Load description from detail pane ────────────────────────
async function loadIndeedDescription(page: Page, jobKey: string): Promise<string | null> {
  try {
    if (!jobKey) return null;

    // Click the job card to load detail pane
    const card = page.locator(`[data-jk="${jobKey}"]`).first();
    if (await card.isVisible({ timeout: 2000 })) {
      await card.click();
      await sleep(1500);
    }

    return await page.evaluate(() => {
      const descEl = document.querySelector(
        '#jobDescriptionText, .jobsearch-JobComponent-description, [data-testid="jobDescriptionText"]'
      );
      return descEl?.innerHTML ?? null;
    });
  } catch {
    return null;
  }
}

async function isCaptchaPage(page: Page): Promise<boolean> {
  const title = await page.title();
  return /captcha|verify|robot|human/i.test(title);
}

function isExcluded(company: string, excluded: string[]): boolean {
  return excluded.some(e => company.toLowerCase().includes(e.toLowerCase()));
}
