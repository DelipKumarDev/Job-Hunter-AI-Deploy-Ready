// ============================================================
// Stealth Browser
// Hardened Playwright Chromium with 10 anti-detection layers:
//
//  1. Randomised user agent (desktop, non-headless profile)
//  2. Viewport + screen resolution fingerprint
//  3. Locale / timezone per-session
//  4. WebDriver property overridden to undefined
//  5. navigator.plugins faked (real browser has plugins)
//  6. navigator.languages set to locale-consistent array
//  7. Chrome runtime object injected (headless lacks it)
//  8. Canvas 2D noise (subpixel variation)
//  9. AudioContext noise
// 10. WebGL renderer spoofed to real GPU string
// ============================================================

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import UserAgent from 'user-agents';
import { logger } from '../utils/logger.js';

export interface StealthSession {
  browser:   Browser;
  context:   BrowserContext;
  page:      Page;
  sessionId: string;
  userAgent: string;
}

const VIEWPORTS = [
  { width: 1920, height: 1080, screen: { width: 1920, height: 1080 } },
  { width: 1440, height: 900,  screen: { width: 1440, height: 900  } },
  { width: 1366, height: 768,  screen: { width: 1366, height: 768  } },
  { width: 1536, height: 864,  screen: { width: 1536, height: 864  } },
  { width: 1280, height: 800,  screen: { width: 1280, height: 800  } },
];

const TIMEZONE_LOCALE = [
  { tz: 'America/New_York',    locale: 'en-US', lang: ['en-US', 'en'] },
  { tz: 'America/Chicago',     locale: 'en-US', lang: ['en-US', 'en'] },
  { tz: 'America/Los_Angeles', locale: 'en-US', lang: ['en-US', 'en'] },
  { tz: 'Europe/London',       locale: 'en-GB', lang: ['en-GB', 'en'] },
  { tz: 'Asia/Kolkata',        locale: 'en-IN', lang: ['en-IN', 'en'] },
  { tz: 'Asia/Singapore',      locale: 'en-SG', lang: ['en-SG', 'en'] },
];

// Real GPU strings for WebGL spoofing
const GPU_STRINGS = [
  'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]!; }

const STEALTH_INIT = (gpuRenderer: string, languages: string[]) => `
// 1. Override webdriver
Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });

// 2. Fake plugins (real browsers have plugins)
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const arr = [
      { name: 'Chrome PDF Plugin',    filename: 'internal-pdf-viewer',  description: 'Portable Document Format', length: 1 },
      { name: 'Chrome PDF Viewer',    filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
      { name: 'Native Client',        filename: 'internal-nacl-plugin',  description: '', length: 2 },
    ];
    arr.refresh = () => {};
    arr.item    = (i) => arr[i];
    arr.namedItem = (n) => arr.find(p => p.name === n) || null;
    Object.setPrototypeOf(arr, PluginArray.prototype);
    return arr;
  },
  configurable: true,
});

// 3. Languages
Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(languages)}, configurable: true });

// 4. Chrome object
if (!window.chrome) {
  window.chrome = {
    app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
    runtime: { OnInstalledReason: {}, OnRestartRequiredReason: {}, PlatformArch: {}, PlatformNaclArch: {}, PlatformOs: {}, RequestUpdateCheckStatus: {} },
    csi: () => {},
    loadTimes: () => ({ commitLoadTime: Date.now()/1000-2, connectionInfo: 'h2', finishDocumentLoadTime: 0, finishLoadTime: 0, firstPaintAfterLoadTime: 0, firstPaintTime: Date.now()/1000-1, navigationType: 'Other', npnNegotiatedProtocol: 'h2', requestTime: Date.now()/1000-3, startLoadTime: Date.now()/1000-3, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true }),
  };
}

// 5. Permissions API
const origQuery = window.navigator.permissions?.query;
if (origQuery) {
  window.navigator.permissions.query = (params) =>
    params.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission, onchange: null })
      : origQuery.call(window.navigator.permissions, params);
}

// 6. Canvas fingerprint noise
const origFill = CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText = function(t, x, y, ...rest) {
  return origFill.call(this, t, x + (Math.random() * 0.1 - 0.05), y + (Math.random() * 0.1 - 0.05), ...rest);
};
const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function(type) {
  const ctx = this.getContext('2d');
  if (ctx) {
    const img = ctx.getImageData(0, 0, this.width, this.height);
    for (let i = 0; i < img.data.length; i += 100) {
      img.data[i] = (img.data[i] + Math.floor(Math.random() * 3 - 1));
    }
    ctx.putImageData(img, 0, 0);
  }
  return origToDataURL.apply(this, arguments);
};

// 7. WebGL renderer spoof
const origGetParam = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(param) {
  if (param === 37445) return 'Intel Inc.';
  if (param === 37446) return ${JSON.stringify(gpuRenderer)};
  return origGetParam.call(this, param);
};

// 8. AudioContext fingerprint noise
const origGetChannelData = AudioBuffer.prototype.getChannelData;
AudioBuffer.prototype.getChannelData = function(channel) {
  const data = origGetChannelData.call(this, channel);
  for (let i = 0; i < data.length; i += 100) {
    data[i] += (Math.random() * 0.0001 - 0.00005);
  }
  return data;
};

// 9. Object.defineProperty override detection
const origDefine = Object.defineProperty;
Object.defineProperty = function(obj, prop, desc) {
  if (prop === 'webdriver' && obj === navigator) return obj;
  return origDefine.call(this, obj, prop, desc);
};

// 10. Hide automation flags
delete window._phantom;
delete window.callPhantom;
delete window.__nightmare;
delete window.domAutomation;
delete window.domAutomationController;
`;

// ─────────────────────────────────────────────────────────────
// CREATE SESSION
// ─────────────────────────────────────────────────────────────
export async function createStealthSession(sessionId: string): Promise<StealthSession> {
  const ua       = new UserAgent({ deviceCategory: 'desktop' });
  const uaStr    = ua.toString();
  const vp       = pick(VIEWPORTS);
  const tzLoc    = pick(TIMEZONE_LOCALE);
  const gpu      = pick(GPU_STRINGS);
  const headless = process.env['PLAYWRIGHT_HEADLESS'] !== 'false';

  const browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      `--window-size=${vp.width},${vp.height}`,
      '--disable-extensions-except=',
      '--disable-default-apps',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const contextOpts: Parameters<typeof browser.newContext>[0] = {
    userAgent:         uaStr,
    viewport:          { width: vp.width, height: vp.height },
    screen:            vp.screen,
    locale:            tzLoc.locale,
    timezoneId:        tzLoc.tz,
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'Accept-Language':           tzLoc.lang.join(',') + ';q=0.9',
      'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest':            'document',
      'Sec-Fetch-Mode':            'navigate',
      'Sec-Fetch-Site':            'none',
      'Sec-Fetch-User':            '?1',
    },
    colorScheme: 'light',
    hasTouch:    false,
    isMobile:    false,
  };

  // Residential proxy
  const proxyHost = process.env['PROXY_HOST'];
  if (proxyHost) {
    contextOpts.proxy = {
      server:   `http://${proxyHost}:${process.env['PROXY_PORT'] ?? '3128'}`,
      username: process.env['PROXY_USERNAME'],
      password: process.env['PROXY_PASSWORD'],
    };
  }

  const context = await browser.newContext(contextOpts);

  // Inject all stealth scripts into every new page
  await context.addInitScript(STEALTH_INIT(gpu, tzLoc.lang));

  // Block media + fonts (speed), allow everything else
  await context.route('**/*', route => {
    const type = route.request().resourceType();
    if (['media', 'font', 'websocket'].includes(type)) return route.abort();
    return route.continue();
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('dialog', d => d.dismiss().catch(() => null));

  // Mask headless in extra properties
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
  });

  logger.info('Stealth session created', {
    sessionId,
    viewport: `${vp.width}x${vp.height}`,
    timezone: tzLoc.tz,
    locale:   tzLoc.locale,
  });

  return { browser, context, page, sessionId, userAgent: uaStr };
}

export async function closeStealthSession(session: StealthSession): Promise<void> {
  try {
    await session.context.close();
    await session.browser.close();
  } catch { /* already closed */ }
  logger.debug('Stealth session closed', { sessionId: session.sessionId });
}
