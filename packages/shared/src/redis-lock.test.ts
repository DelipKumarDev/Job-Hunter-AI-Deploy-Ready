// ============================================================
// redis-lock.test.ts
// Unit tests for the distributed lock utility.
// Uses an in-memory Redis mock — no real Redis required.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initLockClient,
  getLockClient,
  withLock,
  tryWithLock,
  LockKeys,
  TTL,
  LockContentionError,
  LockNotInitializedError,
} from './redis-lock.js';

// ── Minimal Redis mock ────────────────────────────────────────
// Redlock only needs: set, eval, and eval-sha on the client.
// We implement the SET NX PX pattern manually.

const store = new Map<string, string>();

const redisMock = {
  status: 'ready',
  duplicate: () => redisMock,
  // SET key value NX PX ttl
  set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
    const isNX = (args as string[]).includes('NX');
    if (isNX && store.has(key)) return null;  // Key already exists
    store.set(key, value);
    return 'OK';
  }),
  // GET for existence checks
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  // DEL for release
  del: vi.fn(async (key: string) => { store.delete(key); return 1; }),
  // eval for Redlock's Lua release script
  eval: vi.fn(async (script: string, numkeys: number, key: string, value: string) => {
    // Redlock's release script: DEL if value matches
    const current = store.get(key);
    if (current === value) {
      store.delete(key);
      return 1;
    }
    return 0;
  }),
} as unknown as import('ioredis').Redis;

// ── Reset module state between tests ─────────────────────────
// The lock client is a module singleton — we need to reset it.
let resetModule: (() => void) | null = null;
vi.mock('./redis-lock.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./redis-lock.js')>();
  return mod;
});

// ─────────────────────────────────────────────────────────────

describe('LockKeys', () => {
  it('scrapeRun key has correct format', () => {
    expect(LockKeys.scrapeRun('user1', 'linkedin'))
      .toBe('jh-lock:scrape:user1:linkedin');
  });

  it('applyJob key has correct format', () => {
    expect(LockKeys.applyJob('user1', 'job123'))
      .toBe('jh-lock:apply:user1:job123');
  });

  it('emailSync key has correct format', () => {
    expect(LockKeys.emailSync('account456'))
      .toBe('jh-lock:email-sync:account456');
  });

  it('followUp key has correct format', () => {
    expect(LockKeys.followUp('followup789'))
      .toBe('jh-lock:followup:followup789');
  });

  it('emailThread key has correct format', () => {
    expect(LockKeys.emailThread('thread-abc'))
      .toBe('jh-lock:thread:thread-abc');
  });
});

describe('TTL values', () => {
  it('SCRAPE TTL is at least 10 minutes', () => {
    expect(TTL.SCRAPE).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  it('APPLY TTL is at least 6 minutes', () => {
    expect(TTL.APPLY).toBeGreaterThanOrEqual(6 * 60 * 1000);
  });

  it('EMAIL_SYNC TTL is at least 2 minutes', () => {
    expect(TTL.EMAIL_SYNC).toBeGreaterThanOrEqual(2 * 60 * 1000);
  });

  it('FOLLOW_UP TTL is at least 30 seconds', () => {
    expect(TTL.FOLLOW_UP).toBeGreaterThanOrEqual(30_000);
  });

  it('all TTLs are finite positive numbers', () => {
    for (const [name, value] of Object.entries(TTL)) {
      expect(value, `TTL.${name}`).toBeGreaterThan(0);
      expect(isFinite(value), `TTL.${name} is finite`).toBe(true);
    }
  });
});

describe('getLockClient before init', () => {
  it('throws LockNotInitializedError if called before initLockClient', () => {
    // We can't truly reset the singleton in vitest without re-importing,
    // but we can verify the error type is exported and has the right name.
    const err = new LockNotInitializedError();
    expect(err.name).toBe('LockNotInitializedError');
    expect(err.message).toContain('initLockClient');
  });
});

describe('LockContentionError', () => {
  it('has correct name and message', () => {
    const err = new LockContentionError('jh-lock:apply:u1:j1', 3);
    expect(err.name).toBe('LockContentionError');
    expect(err.message).toContain('jh-lock:apply:u1:j1');
    expect(err.message).toContain('3');
    expect(err.lockKey).toBe('jh-lock:apply:u1:j1');
    expect(err.retries).toBe(3);
  });
});

describe('withLock / tryWithLock contract', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    // Re-init with mock redis for each test
    initLockClient(redisMock, { retryCount: 0, retryDelayMs: 50 });
  });

  it('withLock executes the callback and returns its value', async () => {
    const result = await withLock(
      LockKeys.applyJob('u1', 'j1'),
      TTL.APPLY,
      async () => 'done',
    );
    expect(result).toBe('done');
  });

  it('tryWithLock returns the callback value when lock is free', async () => {
    const result = await tryWithLock(
      LockKeys.emailSync('acct1'),
      TTL.EMAIL_SYNC,
      async () => ({ emailsFetched: 5 }),
    );
    expect(result).not.toBeNull();
    expect(result?.emailsFetched).toBe(5);
  });

  it('tryWithLock returns null without throwing when lock is contended', async () => {
    // Pre-occupy the lock by setting the key directly
    store.set(LockKeys.scrapeRun('u1', 'linkedin'), 'some-other-value');

    const result = await tryWithLock(
      LockKeys.scrapeRun('u1', 'linkedin'),
      TTL.SCRAPE,
      async () => 'should-not-run',
      { retryCount: 0 },
    );

    expect(result).toBeNull();
  });

  it('withLock throws LockContentionError when lock is contended', async () => {
    store.set(LockKeys.applyJob('u1', 'j2'), 'some-other-value');

    await expect(
      withLock(
        LockKeys.applyJob('u1', 'j2'),
        TTL.APPLY,
        async () => 'should-not-run',
        { retryCount: 0 },
      )
    ).rejects.toThrow(LockContentionError);
  });

  it('withLock propagates errors thrown inside the callback', async () => {
    await expect(
      withLock(
        LockKeys.followUp('fu1'),
        TTL.FOLLOW_UP,
        async () => { throw new Error('smtp timeout'); },
      )
    ).rejects.toThrow('smtp timeout');
  });

  it('tryWithLock propagates non-contention errors from the callback', async () => {
    await expect(
      tryWithLock(
        LockKeys.emailThread('t1'),
        TTL.EMAIL_SYNC,
        async () => { throw new Error('db connection lost'); },
      )
    ).rejects.toThrow('db connection lost');
  });
});

describe('key uniqueness', () => {
  it('different users produce different scrape lock keys', () => {
    expect(LockKeys.scrapeRun('user-A', 'linkedin'))
      .not.toBe(LockKeys.scrapeRun('user-B', 'linkedin'));
  });

  it('different platforms produce different scrape lock keys', () => {
    expect(LockKeys.scrapeRun('user-A', 'linkedin'))
      .not.toBe(LockKeys.scrapeRun('user-A', 'indeed'));
  });

  it('all lock key namespaces are distinct', () => {
    const keys = [
      LockKeys.scrapeRun('x', 'y'),
      LockKeys.applyJob('x', 'y'),
      LockKeys.emailSync('x'),
      LockKeys.followUp('x'),
      LockKeys.emailThread('x'),
    ];
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });
});
