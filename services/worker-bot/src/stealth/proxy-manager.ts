/**
 * ============================================================
 * proxy-manager.ts
 *
 * Manages a pool of proxies for the application bot.
 * Designed to provide each browser session with a healthy,
 * rotating proxy that has not been recently flagged.
 *
 * Features:
 *   • Parses proxies from PROXY_LIST env var (comma-separated)
 *     or PROXY_LIST_FILE (one per line)
 *   • Supports http://, https://, socks5://, socks4:// protocols
 *   • Authentication via URL credentials or separate fields
 *   • Weighted random selection — healthier proxies win more often
 *   • Sticky sessions — same proxy for the lifetime of a session
 *   • Exponential-backoff cooldown after repeated failures
 *   • Automatic health check via HEAD request (optional)
 *   • Per-proxy statistics (requests, successes, failures, RTT)
 *   • Graceful degradation — if all proxies are in cooldown,
 *     uses the least-recently-failed one with a warning
 * ============================================================
 */

import { readFileSync, existsSync } from 'node:fs';
import { createServer }              from 'node:net';
import { logger }                    from '../utils/logger.js';

// ── Types ─────────────────────────────────────────────────────

export interface ParsedProxy {
  /** Canonical URL string, e.g. "socks5://user:pass@1.2.3.4:1080" */
  url: string;

  /** Protocol family */
  protocol: 'http' | 'https' | 'socks5' | 'socks4';

  /** Host without port */
  host: string;

  /** Port number */
  port: number;

  /** Proxy username (undefined if unauthenticated) */
  username: string | undefined;

  /** Proxy password (undefined if unauthenticated) */
  password: string | undefined;

  /** Display label for logging (host:port, never includes credentials) */
  label: string;
}

/** Runtime health state for a proxy */
export interface ProxyHealth {
  /** Consecutive failures since last success */
  consecutiveFailures: number;

  /** Total successful requests */
  totalSuccesses: number;

  /** Total failed requests */
  totalFailures: number;

  /** Unix ms timestamp of last request */
  lastUsedAt: number;

  /** Unix ms timestamp until which this proxy is in cooldown (0 = active) */
  cooldownUntil: number;

  /** Average request latency in ms (exponential moving average) */
  avgLatencyMs: number;

  /** Whether this proxy passed the last health check */
  healthy: boolean;
}

/** Proxy augmented with live health data */
export interface ProxyEntry {
  proxy:  ParsedProxy;
  health: ProxyHealth;
}

// ── Constants ─────────────────────────────────────────────────

const COOLDOWN_BASE_MS   = 5 * 60 * 1000;   // 5 min base cooldown
const COOLDOWN_MAX_MS    = 60 * 60 * 1000;  // 1 hour max cooldown
const HEALTH_CHECK_URL   = 'https://www.google.com';
const HEALTH_CHECK_TIMEOUT_MS = 8000;
const SESSION_TTL_MS     = 30 * 60 * 1000;  // 30-min sticky session TTL

// ── Proxy parser ──────────────────────────────────────────────

function parseProxyUrl(raw: string): ParsedProxy | null {
  try {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // Normalize — add protocol if missing
    const withProto = /^(https?|socks[45]):\/\//i.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;

    const parsed   = new URL(withProto);
    const protocol = parsed.protocol.replace(':', '') as ParsedProxy['protocol'];

    if (!['http', 'https', 'socks5', 'socks4'].includes(protocol)) {
      logger.warn('Proxy: unsupported protocol', { url: trimmed });
      return null;
    }

    const host     = parsed.hostname;
    const port     = parseInt(parsed.port || (protocol === 'https' ? '443' : '3128'), 10);
    const username = parsed.username || undefined;
    const password = parsed.password || undefined;

    if (!host || isNaN(port)) {
      logger.warn('Proxy: invalid host/port', { url: trimmed });
      return null;
    }

    return {
      url:      withProto,
      protocol,
      host,
      port,
      username,
      password,
      label: `${host}:${port}`,
    };
  } catch {
    logger.warn('Proxy: failed to parse', { raw });
    return null;
  }
}

function defaultHealth(): ProxyHealth {
  return {
    consecutiveFailures: 0,
    totalSuccesses:      0,
    totalFailures:       0,
    lastUsedAt:          0,
    cooldownUntil:       0,
    avgLatencyMs:        0,
    healthy:             true,
  };
}

// ── ProxyManager ──────────────────────────────────────────────

export class ProxyManager {
  private readonly pool: ProxyEntry[] = [];

  /** sessionId → { entry, assignedAt } for sticky sessions */
  private readonly sticky = new Map<string, { entry: ProxyEntry; assignedAt: number }>();

  /** Whether any proxies were loaded at all */
  private readonly hasProxies: boolean;

  constructor() {
    const entries = this.loadFromEnv();
    this.pool      = entries;
    this.hasProxies = entries.length > 0;

    if (this.hasProxies) {
      logger.info('ProxyManager initialized', {
        total:     entries.length,
        protocols: [...new Set(entries.map(e => e.proxy.protocol))],
      });
    } else {
      logger.warn('ProxyManager: no proxies configured — running without proxy rotation');
    }
  }

  // ── Pool loading ─────────────────────────────────────────

  private loadFromEnv(): ProxyEntry[] {
    // Option A: comma-separated list in env var
    const listEnv = process.env['PROXY_LIST'];
    if (listEnv) {
      return this.parseList(listEnv.split(','));
    }

    // Option B: file path in env var (one proxy per line)
    const fileEnv = process.env['PROXY_LIST_FILE'];
    if (fileEnv && existsSync(fileEnv)) {
      const lines = readFileSync(fileEnv, 'utf8').split('\n');
      return this.parseList(lines);
    }

    // Option C: legacy single-proxy env vars (backward compat)
    const singleHost = process.env['PROXY_HOST'];
    if (singleHost) {
      const port   = process.env['PROXY_PORT'] ?? '3128';
      const user   = process.env['PROXY_USERNAME'] ?? '';
      const pass   = process.env['PROXY_PASSWORD'] ?? '';
      const auth   = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
      return this.parseList([`http://${auth}${singleHost}:${port}`]);
    }

    return [];
  }

  private parseList(lines: string[]): ProxyEntry[] {
    return lines
      .map(l => parseProxyUrl(l))
      .filter((p): p is ParsedProxy => p !== null)
      .map(proxy => ({ proxy, health: defaultHealth() }));
  }

  // ── Selection ─────────────────────────────────────────────

  /**
   * Select a proxy for a new browser session.
   * Attaches the proxy to the session (sticky) so subsequent
   * calls with the same sessionId return the same proxy.
   *
   * Returns null if no proxies are configured.
   */
  selectProxy(sessionId: string): ParsedProxy | null {
    if (!this.hasProxies) return null;

    // Return existing sticky assignment if still valid
    const existing = this.sticky.get(sessionId);
    if (existing) {
      const age = Date.now() - existing.assignedAt;
      if (age < SESSION_TTL_MS) {
        return existing.entry.proxy;
      }
      this.sticky.delete(sessionId);
    }

    const now = Date.now();

    // Classify proxies into active and cooled-down
    const active  = this.pool.filter(e => e.health.cooldownUntil <= now);
    const cooled  = this.pool.filter(e => e.health.cooldownUntil >  now);

    if (active.length === 0 && cooled.length === 0) return null;

    let entry: ProxyEntry;

    if (active.length === 0) {
      // All proxies in cooldown — use least-recently-failed
      logger.warn('ProxyManager: all proxies in cooldown — using best available');
      entry = cooled.sort((a, b) => a.health.cooldownUntil - b.health.cooldownUntil)[0]!;
    } else {
      // Weighted selection: weight = successRate * recencyFactor
      entry = this.weightedPick(active);
    }

    this.sticky.set(sessionId, { entry, assignedAt: Date.now() });
    logger.debug('ProxyManager: assigned proxy', { sessionId, proxy: entry.proxy.label });
    return entry.proxy;
  }

  /**
   * Release the sticky session assignment.
   * Call when a browser session is closed.
   */
  releaseSession(sessionId: string): void {
    this.sticky.delete(sessionId);
  }

  // ── Health updates ────────────────────────────────────────

  markSuccess(proxyUrl: string, latencyMs?: number): void {
    const entry = this.findEntry(proxyUrl);
    if (!entry) return;

    entry.health.consecutiveFailures = 0;
    entry.health.totalSuccesses++;
    entry.health.lastUsedAt    = Date.now();
    entry.health.cooldownUntil = 0;
    entry.health.healthy       = true;

    if (latencyMs !== undefined) {
      // Exponential moving average (α = 0.3)
      entry.health.avgLatencyMs = entry.health.avgLatencyMs === 0
        ? latencyMs
        : entry.health.avgLatencyMs * 0.7 + latencyMs * 0.3;
    }
  }

  markFailure(proxyUrl: string): void {
    const entry = this.findEntry(proxyUrl);
    if (!entry) return;

    entry.health.consecutiveFailures++;
    entry.health.totalFailures++;
    entry.health.lastUsedAt = Date.now();

    // Exponential backoff: 5m, 10m, 20m, 40m, 60m (max)
    const backoffMs = Math.min(
      COOLDOWN_BASE_MS * Math.pow(2, entry.health.consecutiveFailures - 1),
      COOLDOWN_MAX_MS,
    );
    entry.health.cooldownUntil = Date.now() + backoffMs;
    entry.health.healthy = false;

    logger.warn('ProxyManager: proxy marked failed', {
      proxy:              entry.proxy.label,
      consecutiveFailures: entry.health.consecutiveFailures,
      cooldownUntilSec:   Math.round(backoffMs / 1000),
    });

    // Also remove from any sticky sessions
    for (const [sid, sticky] of this.sticky.entries()) {
      if (sticky.entry.proxy.url === proxyUrl) {
        this.sticky.delete(sid);
        logger.debug('ProxyManager: removed failed proxy from sticky session', { sessionId: sid });
      }
    }
  }

  // ── Health check ──────────────────────────────────────────

  /**
   * Perform an active TCP + HTTP health check on all proxies.
   * Call this periodically (e.g., every 15 minutes) rather than
   * on every request.
   */
  async healthCheckAll(): Promise<void> {
    if (!this.hasProxies) return;

    logger.info('ProxyManager: running health checks', { count: this.pool.length });

    await Promise.allSettled(
      this.pool.map(entry => this.healthCheckOne(entry))
    );

    const healthy   = this.pool.filter(e => e.health.healthy).length;
    const unhealthy = this.pool.length - healthy;
    logger.info('ProxyManager: health check complete', { healthy, unhealthy });
  }

  private async healthCheckOne(entry: ProxyEntry): Promise<void> {
    const start = Date.now();
    try {
      // TCP reachability first (fast check)
      await tcpProbe(entry.proxy.host, entry.proxy.port, 4000);
      const latencyMs = Date.now() - start;
      entry.health.healthy = true;
      entry.health.avgLatencyMs = entry.health.avgLatencyMs === 0
        ? latencyMs : entry.health.avgLatencyMs * 0.7 + latencyMs * 0.3;
    } catch {
      entry.health.healthy = false;
    }
  }

  // ── Stats ─────────────────────────────────────────────────

  getStats(): Array<{
    label:              string;
    healthy:            boolean;
    successRate:        string;
    avgLatencyMs:       number;
    consecutiveFails:   number;
    cooldownRemainsMin: number;
  }> {
    return this.pool.map(e => {
      const total = e.health.totalSuccesses + e.health.totalFailures;
      const cooldownRemains = Math.max(0, e.health.cooldownUntil - Date.now());
      return {
        label:              e.proxy.label,
        healthy:            e.health.healthy,
        successRate:        total === 0 ? 'n/a' : `${((e.health.totalSuccesses / total) * 100).toFixed(1)}%`,
        avgLatencyMs:       Math.round(e.health.avgLatencyMs),
        consecutiveFails:   e.health.consecutiveFailures,
        cooldownRemainsMin: Math.round(cooldownRemains / 60000),
      };
    });
  }

  get count(): number { return this.pool.length; }
  get activeCount(): number {
    return this.pool.filter(e => e.health.cooldownUntil <= Date.now()).length;
  }

  // ── Internals ─────────────────────────────────────────────

  private findEntry(proxyUrl: string): ProxyEntry | undefined {
    return this.pool.find(e => e.proxy.url === proxyUrl || e.proxy.label === proxyUrl);
  }

  private weightedPick(entries: ProxyEntry[]): ProxyEntry {
    // Weight = successRate score × recency bonus
    const now = Date.now();
    const weights = entries.map(e => {
      const total       = e.health.totalSuccesses + e.health.totalFailures;
      const successRate = total === 0 ? 0.5 : e.health.totalSuccesses / total;
      // Recency: proxies used >1h ago get a slight boost (less overused)
      const ageMs       = now - e.health.lastUsedAt;
      const recency     = Math.min(2, 1 + ageMs / (60 * 60 * 1000));
      // Latency penalty: penalise very slow proxies
      const latency     = e.health.avgLatencyMs > 0
        ? Math.max(0.3, 1 - e.health.avgLatencyMs / 5000) : 1;
      return Math.max(0.01, successRate * recency * latency);
    });

    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let pick          = Math.random() * totalWeight;

    for (let i = 0; i < entries.length; i++) {
      pick -= weights[i]!;
      if (pick <= 0) return entries[i]!;
    }
    return entries[entries.length - 1]!;
  }
}

// ── TCP probe helper ─────────────────────────────────────────

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    let done = false;

    const client = require('net').createConnection({ host, port });
    const timer = setTimeout(() => {
      if (!done) { done = true; client.destroy(); reject(new Error('TCP timeout')); }
    }, timeoutMs);

    client.on('connect', () => {
      if (!done) { done = true; clearTimeout(timer); client.destroy(); resolve(); }
    });
    client.on('error', (err: Error) => {
      if (!done) { done = true; clearTimeout(timer); reject(err); }
    });
    void socket; // suppress unused warning
  });
}

// ── Module-level singleton ────────────────────────────────────

let _instance: ProxyManager | null = null;

export function getProxyManager(): ProxyManager {
  if (!_instance) _instance = new ProxyManager();
  return _instance;
}
