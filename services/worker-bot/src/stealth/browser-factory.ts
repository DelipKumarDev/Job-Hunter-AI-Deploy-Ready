/**
 * ============================================================
 * browser-factory.ts
 *
 * Single assembly point for all browser sessions.
 * Replaces createStealthSession() from the old stealthBrowser.ts.
 *
 * Stack (bottom → top):
 *  1. playwright-extra chromium — Playwright with plugin support
 *  2. puppeteer-extra-plugin-stealth — automated evasions
 *     (webdriver flag, chrome runtime, permissions, plugins…)
 *  3. FingerprintProfile from bot-stealth.ts — cohesive identity
 *     (UA, GPU, viewport, timezone, battery, ClientRects…)
 *  4. ProxyManager — rotating residential/datacenter proxies
 *  5. Resource filtering — blocks media/fonts to reduce footprint
 *
 * Usage:
 *   const factory = BrowserFactory.getInstance();
 *   const session = await factory.createSession(sessionId);
 *   // … use session.page …
 *   await factory.closeSession(session);
 * ============================================================
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import { logger } from '../utils/logger.js';
import {
  type FingerprintProfile,
  randomProfile,
  generateStealthScript,
  buildContextHeaders,
  spoofGeolocation,
} from './bot-stealth.js';
import { getProxyManager } from './proxy-manager.js';

// ── Types ─────────────────────────────────────────────────────

export interface BotSession {
  /** Stable identifier across the lifetime of the session */
  sessionId:   string;

  browser:     Browser;
  context:     BrowserContext;
  page:        Page;

  /** The fingerprint profile in use (for logging, never sent to page) */
  profile:     FingerprintProfile;

  /** Proxy label (host:port) or 'direct' */
  proxyLabel:  string;

  /** ms timestamp when session was created */
  createdAt:   number;
}

// ── Stealth plugin loader (safe dynamic import) ───────────────
// playwright-extra and the stealth plugin are loaded lazily so
// that import errors are caught and surfaced at session-creation
// time rather than module load time.

let _chromium: typeof import('playwright').chromium | null = null;

async function loadStealthChromium(): Promise<typeof import('playwright').chromium> {
  if (_chromium) return _chromium;

  try {
    // Attempt playwright-extra (preferred — supports plugins)
    const playwrightExtra = await import('playwright-extra');
    const StealthPlugin   = (await import('puppeteer-extra-plugin-stealth')).default;

    const chromiumExtra = playwrightExtra.chromium;
    chromiumExtra.use(StealthPlugin());

    _chromium = chromiumExtra as unknown as typeof import('playwright').chromium;
    logger.info('BrowserFactory: using playwright-extra with stealth plugin');

  } catch (err) {
    // Fallback to plain playwright if playwright-extra is not installed
    logger.warn('BrowserFactory: playwright-extra not available, falling back to plain playwright', {
      hint: 'Run: npm install playwright-extra puppeteer-extra-plugin-stealth',
      error: (err as Error).message,
    });
    const playwright = await import('playwright');
    _chromium        = playwright.chromium;
  }

  return _chromium!;
}

// ── BrowserFactory ────────────────────────────────────────────

export class BrowserFactory {
  private static _instance: BrowserFactory | null = null;

  /** Currently open sessions — used for shutdown/cleanup */
  private readonly activeSessions = new Map<string, BotSession>();

  private constructor() {}

  static getInstance(): BrowserFactory {
    if (!BrowserFactory._instance) {
      BrowserFactory._instance = new BrowserFactory();
    }
    return BrowserFactory._instance;
  }

  // ── Session lifecycle ──────────────────────────────────────

  /**
   * Create a fully hardened browser session.
   *
   * @param sessionId  Stable ID for proxy stickiness + logging
   * @param profileOverride  Force a specific fingerprint profile (optional)
   */
  async createSession(
    sessionId:       string,
    profileOverride?: FingerprintProfile,
  ): Promise<BotSession> {
    const chromium = await loadStealthChromium();
    const profile  = profileOverride ?? randomProfile();
    const proxy    = getProxyManager().selectProxy(sessionId);
    const headless = process.env['PLAYWRIGHT_HEADLESS'] !== 'false';

    // ── 1. Launch browser ────────────────────────────────────
    const browser = await chromium.launch({
      headless,
      args: this.buildLaunchArgs(profile),
      ignoreDefaultArgs: [
        '--enable-automation',
        '--enable-blink-features=IdleDetection',
      ],
      // executablePath is auto-resolved by Playwright
    });

    // ── 2. Build context options ─────────────────────────────
    const contextOptions: Parameters<typeof browser.newContext>[0] = {
      userAgent:          profile.userAgent,
      viewport:           profile.viewport,
      screen:             profile.screen,
      locale:             profile.locale,
      timezoneId:         profile.timezone,
      colorScheme:        'light',
      javaScriptEnabled:  true,
      ignoreHTTPSErrors:  false,
      hasTouch:           false,
      isMobile:           false,
      extraHTTPHeaders:   buildContextHeaders(profile),
    };

    // ── 3. Attach proxy if available ─────────────────────────
    let proxyLabel = 'direct';
    if (proxy) {
      contextOptions.proxy = {
        server:   `${proxy.protocol}://${proxy.host}:${proxy.port}`,
        username: proxy.username,
        password: proxy.password,
      };
      proxyLabel = proxy.label;
    }

    const context = await browser.newContext(contextOptions);

    // ── 4. Inject stealth scripts ─────────────────────────────
    // Layer 2: our extended fingerprint injection (battery, ClientRects, etc.)
    await context.addInitScript(generateStealthScript(profile));

    // Additional page-level overrides
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });
      Object.defineProperty(window,    'outerWidth',     { get: () => window.innerWidth,  configurable: true });
      Object.defineProperty(window,    'outerHeight',    { get: () => window.innerHeight + 88, configurable: true });
    });

    // ── 5. Geolocation ────────────────────────────────────────
    await spoofGeolocation(context, profile);

    // ── 6. Route filtering ────────────────────────────────────
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      // Block bandwidth hogs; allow images (job portals need them for captcha/layout)
      if (['media', 'font', 'websocket'].includes(type)) {
        return route.abort();
      }
      // Block telemetry / analytics that could fingerprint the session
      const url = route.request().url();
      if (this.isTrackingUrl(url)) {
        return route.abort();
      }
      return route.continue();
    });

    // ── 7. Open initial page ──────────────────────────────────
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(45_000);

    // Auto-dismiss unexpected dialogs
    page.on('dialog', async (dialog) => {
      logger.debug('BrowserFactory: dismissing dialog', {
        type: dialog.type(), message: dialog.message().substring(0, 80),
      });
      await dialog.dismiss().catch(() => null);
    });

    // Log console errors in debug mode only (never log content)
    page.on('pageerror', (err) => {
      logger.debug('BrowserFactory: page error', { message: err.message.substring(0, 120) });
    });

    const session: BotSession = {
      sessionId,
      browser,
      context,
      page,
      profile,
      proxyLabel,
      createdAt: Date.now(),
    };

    this.activeSessions.set(sessionId, session);

    logger.info('BrowserFactory: session created', {
      sessionId,
      profile:   profile.id,
      viewport:  `${profile.viewport.width}×${profile.viewport.height}`,
      timezone:  profile.timezone,
      proxy:     proxyLabel,
      headless,
    });

    return session;
  }

  /**
   * Close a session and release its proxy from sticky assignment.
   */
  async closeSession(session: BotSession): Promise<void> {
    try {
      await session.context.close();
    } catch { /* already closed */ }

    try {
      await session.browser.close();
    } catch { /* already closed */ }

    this.activeSessions.delete(session.sessionId);
    getProxyManager().releaseSession(session.sessionId);

    const ageMs = Date.now() - session.createdAt;
    logger.debug('BrowserFactory: session closed', {
      sessionId: session.sessionId,
      ageSec:    Math.round(ageMs / 1000),
    });
  }

  /**
   * Close all open sessions — call during graceful shutdown.
   */
  async closeAll(): Promise<void> {
    const sessions = [...this.activeSessions.values()];
    logger.info('BrowserFactory: closing all sessions', { count: sessions.length });
    await Promise.allSettled(sessions.map(s => this.closeSession(s)));
  }

  /**
   * Record proxy success/failure for health tracking.
   * Call from applicationBot.ts after page navigation.
   */
  markProxySuccess(session: BotSession, latencyMs?: number): void {
    if (session.proxyLabel !== 'direct') {
      getProxyManager().markSuccess(session.proxyLabel, latencyMs);
    }
  }

  markProxyFailure(session: BotSession): void {
    if (session.proxyLabel !== 'direct') {
      getProxyManager().markFailure(session.proxyLabel);
    }
  }

  // ── Stats ─────────────────────────────────────────────────

  get activeSessionCount(): number { return this.activeSessions.size; }

  // ── Internals ─────────────────────────────────────────────

  private buildLaunchArgs(profile: FingerprintProfile): string[] {
    return [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process,TranslateUI',
      '--disable-ipc-flooding-protection',
      `--window-size=${profile.viewport.width},${profile.viewport.height + 88}`,
      '--disable-extensions-except=',
      '--disable-default-apps',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
      '--disable-notifications',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      `--lang=${profile.locale}`,
      '--disable-sync',
      '--metrics-recording-only',
      '--no-report-upload',
    ];
  }

  private isTrackingUrl(url: string): boolean {
    const BLOCK_PATTERNS = [
      'google-analytics.com/collect',
      'analytics.google.com',
      'googletagmanager.com',
      'hotjar.com',
      'fullstory.com',
      'mixpanel.com',
      'segment.com/v1/t',
      'amplitude.com',
      'clarity.ms',
      'mouseflow.com',
      'logrocket.com',
      'sentry.io',        // Would fingerprint headless UA
      'datadome.co',
      'px.ads.linkedin.com',
    ];
    return BLOCK_PATTERNS.some(p => url.includes(p));
  }
}

// ── Backward-compatible exports ───────────────────────────────
// Maintains the same API as the old stealthBrowser.ts so that
// existing callers (applicationBot.ts) need minimal changes.

export type StealthSession = BotSession;

export async function createStealthSession(sessionId: string): Promise<BotSession> {
  return BrowserFactory.getInstance().createSession(sessionId);
}

export async function closeStealthSession(session: BotSession): Promise<void> {
  return BrowserFactory.getInstance().closeSession(session);
}
