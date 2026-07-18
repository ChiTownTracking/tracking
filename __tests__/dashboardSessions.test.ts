import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSession,
  deleteSession,
  isValidSession,
} from '@/lib/dashboardSessions';

// In-memory stand-in for the shared Redis client, honoring the `ex` TTL
// option so the 12-hour server-side expiry is actually exercised.
vi.mock('@/lib/redisClient', () => {
  const store = new Map<string, { value: unknown; expiresAt: number | null }>();

  const client = {
    async set(key: string, value: unknown, opts?: { ex?: number }) {
      store.set(key, {
        value,
        expiresAt: opts?.ex !== undefined ? Date.now() + opts.ex * 1000 : null,
      });
    },
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async del(key: string) {
      store.delete(key);
    },
  };

  return {
    getRedis: () => client,
    __reset: () => store.clear(),
    __entries: () => [...store.entries()],
  };
});

type MockedRedisClient = {
  __reset: () => void;
  __entries: () => Array<
    [string, { value: unknown; expiresAt: number | null }]
  >;
};

describe('dashboardSessions', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const mocked = (await import(
      '@/lib/redisClient'
    )) as unknown as MockedRedisClient;
    mocked.__reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates an opaque UUID token that then validates', async () => {
    const token = await createSession();

    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(await isValidSession(token)).toBe(true);
  });

  it('generates a distinct token per session', async () => {
    expect(await createSession()).not.toBe(await createSession());
  });

  it('rejects a token that was never created', async () => {
    expect(await isValidSession(crypto.randomUUID())).toBe(false);
  });

  it('stores sessions with a 12-hour TTL and rejects them once it passes', async () => {
    const token = await createSession();

    const entries = (
      (await import('@/lib/redisClient')) as unknown as MockedRedisClient
    ).__entries();
    expect(entries).toHaveLength(1);
    expect(entries[0][1].expiresAt).toBe(Date.now() + 12 * 60 * 60 * 1000);

    vi.advanceTimersByTime(12 * 60 * 60 * 1000 - 1);
    expect(await isValidSession(token)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(await isValidSession(token)).toBe(false);
  });

  it('rejects a deleted session immediately', async () => {
    const token = await createSession();
    await deleteSession(token);

    expect(await isValidSession(token)).toBe(false);
  });

  it('deleting one session never touches another', async () => {
    const doomed = await createSession();
    const survivor = await createSession();

    await deleteSession(doomed);

    expect(await isValidSession(survivor)).toBe(true);
  });
});
