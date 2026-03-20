/**
 * ============================================================
 * rate-limiter.ts
 *
 * Per-portal sliding-window rate limiter for the application bot.
 * Ensures the bot never exceeds a job portal's tolerated request
 * rate, which is one of the strongest signals used to identify
 * automated traffic.
 *
 * Design:
 *   • Per-domain token bucket with configurable refill rate
 *   • Jitter on waits (±20%) prevents regularity-based detection
 *   • Adaptive backoff on 429 responses
 *   • Per-operation delay profiles (navigation vs. click vs. submit)
 *   • Cooldown tracking when a portal signals rate limiting
 * ============================================================
 */

import { logger } from '../utils/logger.js';
import { sleep }  from '../humanizer/humanBehavior.js';

// ── Types ─────────────────────────────────────────────────────

export type OperationType =
  | 'navigate'       // Page loads / URL changes
  | 'click'          // Button / link clicks
  | 'form-advance'   // Moving to next form step
  | 'search'         // Search/listing page loads
  | 'api-call';      // XHR / fetch requests

export interface PortalConfig {
  /** Minimum ms between navigate requests */
  navigateMinMs: number;

  /** Minimum ms between click operations */
  clickMinMs: number;

  /** Minimum ms between form-advance operations */
  formAdvanceMinMs: number;

  /** Maximum requests per rolling 60-second window */
  maxRequestsPer60s: number;

  /** Extra ms pause after detecting a form submission */
  postSubmitMs: number;

  /** Whether this portal uses aggressive bot detection */
  highSecurity: boolean;
}

// ── Portal configurations ─────────────────────────────────────
// Values are deliberately conservative — staying well under
// the portal's actual limits provides headroom to avoid triggers.

const PORTAL_CONFIGS: Record<string, PortalConfig> = {
  // LinkedIn — known aggressive detection (ThreatMetrix)
  'linkedin.com': {
    navigateMinMs:    4_000,
    clickMinMs:       1_200,
    formAdvanceMinMs: 3_000,
    maxRequestsPer60s: 8,
    postSubmitMs:     6_000,
    highSecurity:     true,
  },

  // Indeed — moderate detection
  'indeed.com': {
    navigateMinMs:    2_500,
    clickMinMs:       800,
    formAdvanceMinMs: 2_000,
    maxRequestsPer60s: 15,
    postSubmitMs:     4_000,
    highSecurity:     false,
  },

  // Workday — strict, uses Akamai Bot Manager
  'myworkdayjobs.com': {
    navigateMinMs:    3_500,
    clickMinMs:       1_000,
    formAdvanceMinMs: 2_500,
    maxRequestsPer60s: 10,
    postSubmitMs:     5_000,
    highSecurity:     true,
  },
  'wd3.myworkdayjobs.com': {
    navigateMinMs:    3_500,
    clickMinMs:       1_000,
    formAdvanceMinMs: 2_500,
    maxRequestsPer60s: 10,
    postSubmitMs:     5_000,
    highSecurity:     true,
  },

  // Greenhouse — relatively lenient
  'greenhouse.io': {
    navigateMinMs:    1_500,
    clickMinMs:       500,
    formAdvanceMinMs: 1_200,
    maxRequestsPer60s: 25,
    postSubmitMs:     2_000,
    highSecurity:     false,
  },

  // Lever — lenient
  'lever.co': {
    navigateMinMs:    1_500,
    clickMinMs:       500,
    formAdvanceMinMs: 1_200,
    maxRequestsPer60s: 25,
    postSubmitMs:     2_000,
    highSecurity:     false,
  },

  // Ashby — lenient
  'ashbyhq.com': {
    navigateMinMs:    1_200,
    clickMinMs:       400,
    formAdvanceMinMs: 1_000,
    maxRequestsPer60s: 30,
    postSubmitMs:     2_000,
    highSecurity:     false,
  },

  // SmartRecruiters
  'smartrecruiters.com': {
    navigateMinMs:    2_000,
    clickMinMs:       600,
    formAdvanceMinMs: 1_500,
    maxRequestsPer60s: 20,
    postSubmitMs:     3_000,
    highSecurity:     false,
  },

  // Taleo (Oracle) — older, stricter
  'taleo.net': {
    navigateMinMs:    3_000,
    clickMinMs:       900,
    formAdvanceMinMs: 2_500,
    maxRequestsPer60s: 12,
    postSubmitMs:     4_500,
    highSecurity:     true,
  },

  // Naukri.com
  'naukri.com': {
    navigateMinMs:    2_000,
    clickMinMs:       700,
    formAdvanceMinMs: 1_800,
    maxRequestsPer60s: 18,
    postSubmitMs:     3_500,
    highSecurity:     false,
  },

  // Wellfound (AngelList)
  'wellfound.com': {
    navigateMinMs:    1_800,
    clickMinMs:       600,
    formAdvanceMinMs: 1_400,
    maxRequestsPer60s: 20,
    postSubmitMs:     3_000,
    highSecurity:     false,
  },
};

/** Default config for unknown portals */
const DEFAULT_CONFIG: PortalConfig = {
  navigateMinMs:    2_000,
  clickMinMs:       600,
  formAdvanceMinMs: 1_500,
  maxRequestsPer60s: 20,
  postSubmitMs:     3_000,
  highSecurity:     false,
};

// ── Sliding window state ──────────────────────────────────────

interface DomainState {
  /** Timestamps of recent requests (rolling 60s window) */
  requestTimestamps: number[];

  /** When a forced cooldown ends (0 = no cooldown) */
  cooldownUntil: number;

  /** Timestamp of last request for per-operation throttle */
  lastNavigateAt: number;
  lastClickAt:    number;
  lastFormAt:     number;

  /** Total requests made to this domain */
  totalRequests: number;

  /** Times we were rate-limited */
  rateLimitHits: number;
}

function defaultState(): DomainState {
  return {
    requestTimestamps: [],
    cooldownUntil:     0,
    lastNavigateAt:    0,
    lastClickAt:       0,
    lastFormAt:        0,
    totalRequests:     0,
    rateLimitHits:     0,
  };
}

// ── RateLimiter ───────────────────────────────────────────────

export class RateLimiter {
  private readonly state = new Map<string, DomainState>();

  /**
   * Wait the appropriate amount of time before performing an
   * operation against the given URL's domain.
   *
   * Always awaits this before any page interaction.
   */
  async wait(url: string, operation: OperationType = 'navigate'): Promise<void> {
    const domain = extractDomain(url);
    const config = this.getConfig(domain);
    const state  = this.getState(domain);
    const now    = Date.now();

    // ── 1. Respect active cooldown ────────────────────────────
    if (state.cooldownUntil > now) {
      const remainsMs = state.cooldownUntil - now;
      logger.info('RateLimiter: domain in cooldown', {
        domain,
        remainsMs,
        remainsSec: Math.round(remainsMs / 1000),
      });
      await sleep(remainsMs + jitter(1000));
    }

    // ── 2. Sliding window: max requests per 60s ───────────────
    const windowMs = 60_000;
    const cutoff   = now - windowMs;
    state.requestTimestamps = state.requestTimestamps.filter(t => t > cutoff);

    if (state.requestTimestamps.length >= config.maxRequestsPer60s) {
      // Calculate when the oldest request in the window will age out
      const oldestInWindow = state.requestTimestamps[0]!;
      const waitMs         = oldestInWindow + windowMs - now + jitter(500);
      if (waitMs > 0) {
        logger.debug('RateLimiter: sliding window throttle', {
          domain,
          windowFull: state.requestTimestamps.length,
          waitMs:     Math.round(waitMs),
        });
        await sleep(waitMs);
      }
    }

    // ── 3. Per-operation minimum spacing ─────────────────────
    const operationWait = this.operationWait(operation, config, state, now);
    if (operationWait > 0) {
      await sleep(operationWait + jitter(operationWait * 0.2));
    }

    // ── 4. High-security portals: extra random pause ──────────
    if (config.highSecurity && Math.random() < 0.15) {
      const extraMs = gauss(800, 300);
      logger.debug('RateLimiter: high-security extra pause', { domain, extraMs: Math.round(extraMs) });
      await sleep(extraMs);
    }

    // Record the request
    state.requestTimestamps.push(Date.now());
    state.totalRequests++;
    this.updateLastOp(operation, state);
  }

  /**
   * Signal a 429 / rate-limit response from the portal.
   * Triggers adaptive backoff.
   */
  markRateLimited(url: string, retryAfterMs?: number): void {
    const domain = extractDomain(url);
    const state  = this.getState(domain);

    state.rateLimitHits++;

    // Exponential backoff: 2m, 4m, 8m, 16m (cap 30m)
    const backoffMs = retryAfterMs
      ?? Math.min(120_000 * Math.pow(2, state.rateLimitHits - 1), 1_800_000);

    state.cooldownUntil = Date.now() + backoffMs;

    logger.warn('RateLimiter: rate limit detected — entering cooldown', {
      domain,
      cooldownMin:      Math.round(backoffMs / 60_000),
      totalRateLimits:  state.rateLimitHits,
    });
  }

  /**
   * Wait the post-submission pause for a portal.
   * Call after successfully submitting an application.
   */
  async postSubmitPause(url: string): Promise<void> {
    const domain   = extractDomain(url);
    const config   = this.getConfig(domain);
    const pauseMs  = config.postSubmitMs + jitter(config.postSubmitMs * 0.3);
    logger.debug('RateLimiter: post-submit pause', { domain, pauseMs: Math.round(pauseMs) });
    await sleep(pauseMs);
  }

  /** Check if we can make a request right now (non-blocking) */
  canProceed(url: string): boolean {
    const domain = extractDomain(url);
    const state  = this.getState(domain);
    const config = this.getConfig(domain);
    const now    = Date.now();

    if (state.cooldownUntil > now) return false;

    const cutoff  = now - 60_000;
    const recentCount = state.requestTimestamps.filter(t => t > cutoff).length;
    return recentCount < config.maxRequestsPer60s;
  }

  /** Stats for all tracked domains */
  getStats(): Array<{
    domain:           string;
    totalRequests:    number;
    rateLimitHits:    number;
    inCooldown:       boolean;
    cooldownRemainSec: number;
  }> {
    const now = Date.now();
    return [...this.state.entries()].map(([domain, state]) => ({
      domain,
      totalRequests:    state.totalRequests,
      rateLimitHits:    state.rateLimitHits,
      inCooldown:       state.cooldownUntil > now,
      cooldownRemainSec: Math.max(0, Math.round((state.cooldownUntil - now) / 1000)),
    }));
  }

  // ── Internals ─────────────────────────────────────────────

  private getConfig(domain: string): PortalConfig {
    // Try exact match first, then partial match
    if (PORTAL_CONFIGS[domain]) return PORTAL_CONFIGS[domain]!;

    const partialKey = Object.keys(PORTAL_CONFIGS).find(k => domain.endsWith(k));
    return partialKey ? PORTAL_CONFIGS[partialKey]! : DEFAULT_CONFIG;
  }

  private getState(domain: string): DomainState {
    if (!this.state.has(domain)) this.state.set(domain, defaultState());
    return this.state.get(domain)!;
  }

  private operationWait(
    op:     OperationType,
    config: PortalConfig,
    state:  DomainState,
    now:    number,
  ): number {
    switch (op) {
      case 'navigate': {
        const elapsed = now - state.lastNavigateAt;
        return Math.max(0, config.navigateMinMs - elapsed);
      }
      case 'click': {
        const elapsed = now - state.lastClickAt;
        return Math.max(0, config.clickMinMs - elapsed);
      }
      case 'form-advance': {
        const elapsed = now - state.lastFormAt;
        return Math.max(0, config.formAdvanceMinMs - elapsed);
      }
      default:
        return 0;
    }
  }

  private updateLastOp(op: OperationType, state: DomainState): void {
    const now = Date.now();
    if (op === 'navigate')     state.lastNavigateAt = now;
    if (op === 'click')        state.lastClickAt    = now;
    if (op === 'form-advance') state.lastFormAt      = now;
  }
}

// ── Helpers ───────────────────────────────────────────────────

function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    // Strip www. prefix
    return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
  } catch {
    return url;
  }
}

function jitter(base: number): number {
  return Math.floor(Math.random() * base * 0.4 - base * 0.2);
}

function gauss(mean: number, stdDev: number): number {
  const u1 = Math.max(1e-10, Math.random());
  const u2 = Math.random();
  const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0, mean + z * stdDev);
}

// ── Module-level singleton ────────────────────────────────────

let _instance: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter {
  if (!_instance) _instance = new RateLimiter();
  return _instance;
}
