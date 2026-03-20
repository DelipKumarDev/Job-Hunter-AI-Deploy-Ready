/**
 * ============================================================
 * stealth/index.ts — barrel export for all stealth modules
 * ============================================================
 */

// ── Fingerprint profiles + script generation ──────────────────
export {
  type FingerprintProfile,
  FINGERPRINT_PROFILES,
  randomProfile,
  profileForTimezone,
  generateStealthScript,
  buildContextHeaders,
  spoofGeolocation,
} from './bot-stealth.js';

// ── Proxy rotation ────────────────────────────────────────────
export {
  type ParsedProxy,
  type ProxyHealth,
  type ProxyEntry,
  ProxyManager,
  getProxyManager,
} from './proxy-manager.js';

// ── Browser factory ───────────────────────────────────────────
export {
  type BotSession,
  type StealthSession,
  BrowserFactory,
  createStealthSession,
  closeStealthSession,
} from './browser-factory.js';

// ── Captcha detection ─────────────────────────────────────────
export {
  type CaptchaVendor,
  type CaptchaDetection,
  CaptchaDetectedError,
  detectCaptcha,
  assertNoCaptcha,
  waitForCaptchaResolution,
} from './captcha-detector.js';

// ── Rate limiting ─────────────────────────────────────────────
export {
  type OperationType,
  type PortalConfig,
  RateLimiter,
  getRateLimiter,
} from './rate-limiter.js';
