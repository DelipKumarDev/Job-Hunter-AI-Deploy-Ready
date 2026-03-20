// ============================================================
// Stealth Browser Pool
// Manages Playwright Chromium instances with full
// anti-detection hardening. All scrapers share this pool.
// ============================================================

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import UserAgent from 'user-agents';
import { logger } from '../utils/logger.js';

export interface BrowserSession {
  browser:   Browser;
  context:   BrowserContext;
  page:      Page;
  sessionId: string;
}

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900  },
  { width: 1366, height: 768  },
  { width: 1280, height: 800  },
];

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Los_Angeles',
  'Europe/London', 'Asia/Kolkata', 'Asia/Singapore', 'Australia/Sydney',
];

const LOCALES = ['en-US', 'en-GB', 'en-IN', 'en-AU', 'en-CA'];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]!; }

// ── Create a stealth session ──────────────────────────────────
export async function createBrowserSession(sessionId: string): Promise<BrowserSession> {
  const ua       = new UserAgent({ deviceCategory: 'desktop' });
  const viewport = pick(VIEWPORTS);
  const timezone = pick(TIMEZONES);
  const locale   = pick(LOCALES);
  const headless = process.env['PLAYWRIGHT_HEADLESS'] !== 'false';

  const browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-blink-features=AutomationControlled',
      `--window-size=${viewport.width},${viewport.height}`,
      '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    ],
  });

  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    userAgent:         ua.toString(),
    viewport,
    locale,
    timezoneId:        timezone,
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders:  {
      'Accept-Language':           `${locale},en;q=0.9`,
      'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Sec-Ch-Ua-Mobile':          '?0',
      'Sec-Fetch-Dest':            'document',
      'Sec-Fetch-Mode':            'navigate',
      'Sec-Fetch-Site':            'none',
      'Upgrade-Insecure-Requests': '1',
    },
  };

  // Residential proxy per scraper session
  const proxyHost = process.env['PROXY_HOST'];
  if (proxyHost) {
    contextOptions.proxy = {
      server:   `http://${proxyHost}:${process.env['PROXY_PORT'] ?? '3128'}`,
      username: process.env['PROXY_USERNAME'],
      password: process.env['PROXY_PASSWORD'],
    };
  }

  const context = await browser.newContext(contextOptions);

  // Anti-detection init scripts
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver',  { get: () => undefined });
    Object.defineProperty(navigator, 'plugins',    { get: () => [1, 2, 3, 4] });
    Object.defineProperty(navigator, 'languages',  { get: () => ['en-US', 'en'] });
    (window as unknown as Record<string, unknown>)['chrome'] = { runtime: {} };
    // Canvas fingerprint noise
    const origFill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) {
      return origFill.call(this, text, x + (Math.random() * 0.1 - 0.05), y + (Math.random() * 0.1 - 0.05), ...rest);
    };
  });

  // Block media/fonts to speed up scraping
  await context.route('**/*', route => {
    const type = route.request().resourceType();
    if (['media', 'font', 'websocket'].includes(type)) return route.abort();
    return route.continue();
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('dialog', d => d.dismiss().catch(() => null));

  logger.debug('Browser session created', { sessionId, viewport, timezone });
  return { browser, context, page, sessionId };
}

export async function closeBrowserSession(session: BrowserSession): Promise<void> {
  try { await session.browser.close(); } catch { /* already closed */ }
  logger.debug('Browser session closed', { sessionId: session.sessionId });
}
