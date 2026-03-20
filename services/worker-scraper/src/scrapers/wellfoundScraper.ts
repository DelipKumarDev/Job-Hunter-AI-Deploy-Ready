// ============================================================
// Wellfound (AngelList Talent) Scraper
// Scrapes wellfound.com/jobs — startup and tech-focused jobs.
// Wellfound is a React SPA — requires full browser rendering.
// Known for equity/salary transparency.
//
// Strategy:
//  1. Login not required for browsing (limited results)
//  2. Extract job cards from /jobs search page
//  3. Each card links to a detail page with full info
//  4. Infinite scroll pagination (load more on scroll)
// ============================================================

import type { Page } from 'playwright';
import type { RawJob, ScraperConfig, JobScraper } from '../types/scraperTypes.js';
import { createBrowserSession, closeBrowserSession } from '../browser/browserPool.js';
import { sleep, pageDelay, scrollDelay, randomDelay } from '../utils/delay.js';
import { logger } from '../utils/logger.js';

const BASE_URL = 'https://wellfound.com';

export class WellfoundScraper implements JobScraper {
  readonly platform    = 'wellfound' as const;
  readonly displayName = 'Wellfound (AngelList)';
  readonly baseDelay   = 2500;

  async *scrape(config: ScraperConfig): AsyncGenerator<RawJob> {
    const session = await createBrowserSession(`wellfound_${config.userId}_${Date.now()}`);
    let totalYielded = 0;

    try {
      for (const keyword of config.keywords) {
        if (totalYielded >= config.maxResultsPerPlatform) break;

        const url = buildWellfoundUrl(keyword, config);
        logger.info('Wellfound: searching', { keyword, url });

        await session.page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        await pageDelay();

        // Collect job links via infinite scroll
        const jobLinks = await collectJobLinks(session.page, config.maxResultsPerPlatform - totalYielded);
        logger.info(`Wellfound: found ${jobLinks.length} job links`);

        for (const link of jobLinks) {
          if (totalYielded >= config.maxResultsPerPlatform) break;

          const detail = await scrapeWellfoundDetail(session.page, link);
          if (!detail) continue;
          if (isExcluded(detail.company, config.excludedCompanies)) continue;

          await randomDelay(2000, 4000);

          yield {
            job_title:       detail.job_title,
            company:         detail.company,
            apply_link:      link,
            platform:        'wellfound',
            scraped_at:      new Date().toISOString(),
            location:        detail.location,
            salary_raw:      detail.salary_raw,
            description:     detail.description,
            requirements:    null,
            posted_date_raw: detail.posted_date_raw,
            job_type_raw:    detail.job_type_raw,
            remote_raw:      detail.remote_raw,
            experience_raw:  detail.experience_raw,
            source_job_id:   extractWellfoundId(link),
            company_logo_url: detail.company_logo_url,
          };
          totalYielded++;
        }
      }
    } catch (err) {
      logger.error('Wellfound scraper error', { error: String(err) });
    } finally {
      await closeBrowserSession(session);
    }
  }
}

// ── URL builder ───────────────────────────────────────────────
function buildWellfoundUrl(keyword: string, config: ScraperConfig): string {
  const params = new URLSearchParams({ q: keyword });
  if (config.remoteOnly) params.set('remote', 'true');
  return `${BASE_URL}/jobs?${params}`;
}

// ── Collect job links via infinite scroll ─────────────────────
async function collectJobLinks(page: Page, limit: number): Promise<string[]> {
  const links = new Set<string>();
  let attempts = 0;
  const maxScrolls = Math.ceil(limit / 10) + 5;

  while (links.size < limit && attempts < maxScrolls) {
    // Extract current visible job links
    const newLinks = await page.evaluate((base: string) => {
      const anchors = document.querySelectorAll(
        'a[href*="/jobs/"], a[data-test="job-link"], [class*="jobCard"] a, [class*="startup-link"] a'
      );
      const found: string[] = [];
      anchors.forEach(a => {
        const href = (a as HTMLAnchorElement).href;
        if (href.includes('/jobs/') && !href.includes('/jobs/?') && href.startsWith(base)) {
          found.push(href.split('?')[0]!);
        }
      });
      return [...new Set(found)];
    }, BASE_URL);

    newLinks.forEach(l => links.add(l));

    // Scroll down to trigger lazy loading
    await page.mouse.wheel(0, 900);
    await scrollDelay();

    // Wait for new cards to appear
    await sleep(1000);
    attempts++;
  }

  return [...links].slice(0, limit);
}

// ── Job detail scraper ────────────────────────────────────────
interface WellfoundDetail {
  job_title:       string;
  company:         string;
  location:        string | null;
  salary_raw:      string | null;
  description:     string | null;
  posted_date_raw: string | null;
  job_type_raw:    string | null;
  remote_raw:      string | null;
  experience_raw:  string | null;
  company_logo_url: string | null;
}

async function scrapeWellfoundDetail(page: Page, url: string): Promise<WellfoundDetail | null> {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
    await pageDelay();

    return await page.evaluate(() => {
      // Title
      const titleEl = document.querySelector(
        'h1[class*="title"], h1[data-test="job-title"], [class*="JobHeader"] h1, h1'
      );
      // Company
      const companyEl = document.querySelector(
        '[class*="company-name"], [data-test="company-name"], [class*="startupName"]'
      );
      // Location
      const locationEl = document.querySelector(
        '[class*="location"], [data-test="location"], [class*="jobLocation"]'
      );
      // Salary — Wellfound shows equity + salary
      const salaryEl = document.querySelector(
        '[class*="compensation"], [class*="salary"], [data-test="salary"]'
      );
      // Description
      const descEl = document.querySelector(
        '[class*="description"], [class*="job-description"], [data-test="description"]'
      );
      // Job type / remote
      const metaItems = document.querySelectorAll(
        '[class*="meta"] span, [class*="jobTag"], [class*="badge"]'
      );

      let job_type_raw: string | null = null;
      let remote_raw: string | null = null;
      let experience_raw: string | null = null;

      metaItems.forEach(item => {
        const text = item.textContent?.trim().toLowerCase() ?? '';
        if (/full.?time|part.?time|contract/.test(text)) job_type_raw = item.textContent!.trim();
        if (/remote|hybrid/.test(text))                  remote_raw   = item.textContent!.trim();
        if (/\d+[-+]\s*year|\bsenior\b|\bjunior\b/.test(text)) experience_raw = item.textContent!.trim();
      });

      const logoEl = document.querySelector(
        'img[class*="logo"], img[alt*="logo"], [class*="companyLogo"] img'
      );
      const postedEl = document.querySelector(
        'time, [class*="posted"], [class*="date"], [data-test="posted-at"]'
      );

      const title   = titleEl?.textContent?.trim() ?? '';
      const company = companyEl?.textContent?.trim() ?? '';

      if (!title || !company) return null;

      return {
        job_title:       title,
        company,
        location:        locationEl?.textContent?.trim() ?? null,
        salary_raw:      salaryEl?.textContent?.trim() ?? null,
        description:     descEl?.innerHTML ?? null,
        posted_date_raw: postedEl?.getAttribute('datetime') ?? postedEl?.textContent?.trim() ?? null,
        job_type_raw,
        remote_raw,
        experience_raw,
        company_logo_url:(logoEl as HTMLImageElement)?.src ?? null,
      };
    });
  } catch {
    return null;
  }
}

function extractWellfoundId(url: string): string | null {
  const m = url.match(/\/jobs\/(\d+)/);
  return m?.[1] ?? null;
}

function isExcluded(company: string, excluded: string[]): boolean {
  return excluded.some(e => company.toLowerCase().includes(e.toLowerCase()));
}
