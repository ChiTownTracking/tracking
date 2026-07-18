import { beforeEach, describe, expect, it, vi } from 'vitest';

const { limitMock, slidingWindowMock, ratelimitCtor } = vi.hoisted(() => ({
  limitMock: vi.fn(),
  slidingWindowMock: vi.fn((maxAttempts: number, window: string) => ({
    maxAttempts,
    window,
  })),
  ratelimitCtor: vi.fn(),
}));

// Fake @upstash/ratelimit: capture the config and script the limit() response
// per test. No fake timers — windowing is Upstash's job now, not ours; we only
// test that its responses are mapped and its config is correct.
vi.mock('@upstash/ratelimit', () => {
  class Ratelimit {
    static slidingWindow = slidingWindowMock;
    constructor(config: unknown) {
      ratelimitCtor(config);
    }
    limit(key: string) {
      return limitMock(key);
    }
  }
  return { Ratelimit };
});

vi.mock('@/lib/redisClient', () => ({
  getRedis: () => ({}),
}));

import { dashboardLoginLimiter, RedisRateLimiter } from '@/lib/rateLimiter';

function upstashResponse(success: boolean, reset = Date.now() + 60_000) {
  return { success, limit: 5, remaining: success ? 4 : 0, reset };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RedisRateLimiter', () => {
  it('is constructible without touching Redis — config is read lazily on first check', () => {
    new RedisRateLimiter(3, 60, 'ratelimit:test');
    expect(ratelimitCtor).not.toHaveBeenCalled();
  });

  it('configures a sliding window with the given attempts, window, and prefix', async () => {
    limitMock.mockResolvedValue(upstashResponse(true));
    const limiter = new RedisRateLimiter(3, 60, 'ratelimit:test');

    await limiter.check('1.2.3.4');

    expect(slidingWindowMock).toHaveBeenCalledWith(3, '60 s');
    expect(ratelimitCtor).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'ratelimit:test' }),
    );
    expect(limitMock).toHaveBeenCalledWith('1.2.3.4');
  });

  it('reuses one Ratelimit instance across checks', async () => {
    limitMock.mockResolvedValue(upstashResponse(true));
    const limiter = new RedisRateLimiter(3, 60, 'ratelimit:test');

    await limiter.check('1.2.3.4');
    await limiter.check('5.6.7.8');

    expect(ratelimitCtor).toHaveBeenCalledTimes(1);
    expect(limitMock).toHaveBeenNthCalledWith(2, '5.6.7.8');
  });

  it('returns allowed when Upstash reports success', async () => {
    limitMock.mockResolvedValue(upstashResponse(true));
    const limiter = new RedisRateLimiter(3, 60, 'ratelimit:test');

    expect(await limiter.check('1.2.3.4')).toEqual({ allowed: true });
  });

  it('returns blocked with retryAfterMs derived from the reported reset', async () => {
    limitMock.mockResolvedValue(upstashResponse(false, Date.now() + 5_000));
    const limiter = new RedisRateLimiter(3, 60, 'ratelimit:test');

    const result = await limiter.check('1.2.3.4');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(5_000);
  });

  it('clamps retryAfterMs to zero if the reported reset is already in the past', async () => {
    limitMock.mockResolvedValue(upstashResponse(false, Date.now() - 1_000));
    const limiter = new RedisRateLimiter(3, 60, 'ratelimit:test');

    expect(await limiter.check('1.2.3.4')).toEqual({
      allowed: false,
      retryAfterMs: 0,
    });
  });
});

describe('dashboardLoginLimiter', () => {
  it('keeps the staff login budget at 5 attempts per 60 seconds', async () => {
    limitMock.mockResolvedValue(upstashResponse(true));

    await dashboardLoginLimiter.check('1.2.3.4');

    expect(slidingWindowMock).toHaveBeenCalledWith(5, '60 s');
  });
});
