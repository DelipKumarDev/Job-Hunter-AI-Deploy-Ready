// ============================================================
// Naukri.com Scraper
// India's largest job board. Scrapes naukri.com/jobs-listings
// Naukri renders job cards server-side — faster than SPA scrapers.
// Extracts full salary (CTC in LPA), skills, experience range.
//
// Strategy:
//  1. GET search URL (SSR HTML — no JS needed for listing)
//  2. Parse job cards with Cheerio-style selectors
//  3. Visit detail page for description + requirements
//  4. Handle pagination via &start=N
// ============================================================

import type { Page } from 'playwright';
import type { RawJob, ScraperConfig, JobScraper } from '../types/scraperTypes.js';
import { createBrowserSession, closeBrowserSession } from '../browser/browserPool.js';
import { pageDelay, randomDelay, scrollDelay } from '../utils/delay.js';
import { logger } from '../utils/logger.js';

const BASE_URL = 'https://www.naukri.com';

export class NaukriScraper implements JobScraper {
  readonly platform    = 'naukri' as const;
  readonly displayName = 'Naukri';
  readonly baseDelay   = 2000;

  async *scrape(config: ScraperConfig): AsyncGenerator<RawJob> {
    const session = await createBrowserSession(`naukri_${config.userId}_${Date.now()}`);
    let totalYielded = 0;

    try {
      for (const keyword of config.keywords) {
        for (const location of config.locations) {
          if (totalYielded >= config.maxResultsPerPlatform) break;

          const url = buildNaukriUrl(keyword, location);
          logger.info('Naukri: searching', { keyword, location, url });

          await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await pageDelay();

          // Scroll down to load all cards
          for (let i = 0; i < 5; i++) {
            await session.page.mouse.wheel(0, 800);
            await scrollDelay();
          }

          const cards = await extractNaukriCards(session.page);
          logger.info(`Naukri: found ${cards.length} cards`);

          for (const card of cards) {
            if (totalYielded >= config.maxResultsPerPlatform) break;
            if (!card.job_title || !card.company || !card.apply_link) continue;
            if (isExcluded(card.company, config.excludedCompanies)) continue;

            // Visit detail page for full description
            const detail = await scrapeNaukriDetail(session.page, card.apply_link);
            await randomDelay(2000, 4000);

            yield {
              job_title:       card.job_title,
              company:         card.company,
              apply_link:      card.apply_link,
              platform:        'naukri',
              scraped_at:      new Date().toISOString(),
              location:        card.location,
              salary_raw:      card.salary_raw,
              description:     detail.description,
              requirements:    detail.key_skills,
              posted_date_raw: card.posted_date_raw,
              job_type_raw:    null,
              remote_raw:      card.remote_raw,
              experience_raw:  card.experience_raw,
              source_job_id:   card.job_id,
              company_logo_url: card.company_logo_url,
            };
            totalYielded++;
          }

          // Paginate — Naukri uses &start=N (20 per page)
          let page = 2;
          while (totalYielded < config.maxResultsPerPlatform) {
            const nextUrl = `${url}&start=${(page - 1) * 20}`;
            await session.page.goto(nextUrl, { waitUntil: 'domcontentloaded' });
            await pageDelay();

            const moreCards = await extractNaukriCards(session.page);
            if (moreCards.length === 0) break;

            for (const card of moreCards) {
              if (totalYielded >= config.maxResultsPerPlatform) break;
              if (!card.job_title || !card.company || !card.apply_link) continue;
              if (isExcluded(card.company, config.excludedCompanies)) continue;

              const detail = await scrapeNaukriDetail(session.page, card.apply_link);
              await randomDelay(2000, 4000);

              yield {
                job_title:       card.job_title,
                company:         card.company,
                apply_link:      card.apply_link,
                platform:        'naukri',
                scraped_at:      new Date().toISOString(),
                location:        card.location,
                salary_raw:      card.salary_raw,
                description:     detail.description,
                requirements:    detail.key_skills,
                posted_date_raw: card.posted_date_raw,
                job_type_raw:    null,
                remote_raw:      card.remote_raw,
                experience_raw:  card.experience_raw,
                source_job_id:   card.job_id,
                company_logo_url: card.company_logo_url,
              };
              totalYielded++;
            }
            page++;
          }
        }
      }
    } catch (err) {
      logger.error('Naukri scraper error', { error: String(err) });
    } finally {
      await closeBrowserSession(session);
    }
  }
}

// ── URL builder ───────────────────────────────────────────────
function buildNaukriUrl(keyword: string, location: string): string {
  // Naukri uses slug-style URLs: /keyword-jobs-in-location
  const slug = keyword.toLowerCase().replace(/\s+/g, '-');
  const loc  = location.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z-]/g, '');
  const isRemote = /remote/i.test(location);

  if (isRemote) {
    return `${BASE_URL}/${slug}-jobs?jobAge=7`;
  }
  return `${BASE_URL}/${slug}-jobs-in-${loc}?jobAge=7`;
}

// ── Job card extraction ───────────────────────────────────────
interface NaukriCard {
  job_title:       string;
  company:         string;
  location:        string | null;
  apply_link:      string;
  salary_raw:      string | null;
  posted_date_raw: string | null;
  experience_raw:  string | null;
  remote_raw:      string | null;
  job_id:          string | null;
  company_logo_url: string | null;
}

async function extractNaukriCards(page: Page): Promise<NaukriCard[]> {
  return page.evaluate((base) => {
    const results: {
      job_title: string; company: string; location: string | null;
      apply_link: string; salary_raw: string | null; posted_date_raw: string | null;
      experience_raw: string | null; remote_raw: string | null;
      job_id: string | null; company_logo_url: string | null;
    }[] = [];

    // Naukri's job card selectors (they change often — multiple fallbacks)
    const cards = document.querySelectorAll(
      'article.jobTuple, .jobTupleHeader, .cust-job-tuple, [class*="srp-jobtuple"]'
    );

    cards.forEach(card => {
      const titleEl    = card.querySelector('a.title, .jobTuple-header a, h2 a, [class*="jobTitle"] a');
      const companyEl  = card.querySelector('a.subTitle, .comp-name, [class*="companyName"]');
      const locationEl = card.querySelector('.locWdth, .location, [class*="location"]');
      const salaryEl   = card.querySelector('.salary, [class*="salary"], .placeHolderSalary');
      const expEl      = card.querySelector('.experience, [class*="experience"]');
      const dateEl     = card.querySelector('.fr-desig, .job-post-day, [class*="postDate"]');
      const logoEl     = card.querySelector('img.logoImage, img[class*="logo"]');

      const href      = (titleEl as HTMLAnchorElement)?.href ?? '';
      const titleText = titleEl?.textContent?.trim() ?? '';
      const compText  = companyEl?.textContent?.trim() ?? '';

      if (!titleText || !href) return;

      // Extract Naukri job ID from URL (/job-listings-...-JID_xxx)
      const jobIdMatch = href.match(/JID_(\d+)/) ?? href.match(/[?&]src=(\d+)/);
      const locText    = locationEl?.textContent?.trim() ?? null;

      results.push({
        job_title:       titleText,
        company:         compText,
        location:        locText,
        apply_link:      href.startsWith('http') ? href : `${base}${href}`,
        salary_raw:      salaryEl?.textContent?.trim() ?? null,
        posted_date_raw: dateEl?.textContent?.trim() ?? null,
        experience_raw:  expEl?.textContent?.trim() ?? null,
        remote_raw:      locText?.toLowerCase().includes('remote') ? locText : null,
        job_id:          jobIdMatch?.[1] ?? null,
        company_logo_url:(logoEl as HTMLImageElement)?.src ?? null,
      });
    });

    return results;
  }, BASE_URL);
}

// ── Detail page scraper ───────────────────────────────────────
interface NaukriDetail {
  description: string | null;
  key_skills:  string | null;
}

async function scrapeNaukriDetail(page: Page, url: string): Promise<NaukriDetail> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await pageDelay();

    return await page.evaluate(() => {
      const descEl = document.querySelector(
        '.dang-inner-html, [class*="description"], .jd-desc, #job-description'
      );
      const skillsEl = document.querySelector(
        '.key-skill, [class*="keySkills"], [class*="skills"]'
      );

      return {
        description: descEl?.innerHTML ?? null,
        key_skills:  skillsEl?.textContent?.trim() ?? null,
      };
    });
  } catch {
    return { description: null, key_skills: null };
  }
}

function isExcluded(company: string, excluded: string[]): boolean {
  return excluded.some(e => company.toLowerCase().includes(e.toLowerCase()));
}
