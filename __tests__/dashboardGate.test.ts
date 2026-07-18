import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateLoginAttempt } from '@/lib/dashboardGate';
import type { RateLimitCheck, RateLimiter } from '@/lib/rateLimiter';

const GOOD = { username: 'dispatch', password: 's3cret-pass' };
const BAD = { username: 'dispatch', password: 'wrong' };
const IP = '1.2.3.4';

// Injected stand-in for the Redis-backed limiter: scripted responses, plus a
// spy so tests can assert whether the budget was consulted at all.
function fakeLimiter(result: RateLimitCheck) {
  const check = vi.fn<RateLimiter['check']>().mockResolvedValue(result);
  return { limiter: { check } satisfies RateLimiter, check };
}

describe('evaluateLoginAttempt', () => {
  beforeEach(() => {
    vi.stubEnv('DASHBOARD_USER', 'dispatch');
    vi.stubEnv('DASHBOARD_PASS', 's3cret-pass');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns allowed for correct credentials', async () => {
    const { limiter } = fakeLimiter({ allowed: true });
    expect(await evaluateLoginAttempt(GOOD, IP, limiter)).toEqual({
      outcome: 'allowed',
    });
  });

  it('returns unauthorized for wrong credentials under the limit', async () => {
    const { limiter, check } = fakeLimiter({ allowed: true });
    expect(await evaluateLoginAttempt(BAD, IP, limiter)).toEqual({
      outcome: 'unauthorized',
    });
    expect(check).toHaveBeenCalledWith(IP);
  });

  it('returns rateLimited with retryAfterMs > 0 when the limiter blocks', async () => {
    const { limiter } = fakeLimiter({ allowed: false, retryAfterMs: 42_000 });

    const result = await evaluateLoginAttempt(BAD, IP, limiter);
    expect(result.outcome).toBe('rateLimited');
    if (result.outcome === 'rateLimited') {
      expect(result.retryAfterMs).toBeGreaterThan(0);
    }
  });

  // THE regression test, relocated from the old per-request proxy gate to the
  // login flow: correct credentials must short-circuit BEFORE the limiter, so
  // only failed attempts consume Redis budget — a correct login succeeds even
  // when that budget is already exhausted (e.g. by an attacker sharing the
  // office NAT's IP).
  it('never rate-limits a correct login, no matter how many rapid attempts', async () => {
    const { limiter, check } = fakeLimiter({
      allowed: false,
      retryAfterMs: 60_000,
    });

    for (let i = 0; i < 20; i++) {
      expect(await evaluateLoginAttempt(GOOD, IP, limiter)).toEqual({
        outcome: 'allowed',
      });
    }
    expect(check).not.toHaveBeenCalled();
  });

  it('allows a correct login immediately after a failed one, consuming budget only for the failure', async () => {
    const { limiter, check } = fakeLimiter({ allowed: true });

    expect(await evaluateLoginAttempt(BAD, IP, limiter)).toEqual({
      outcome: 'unauthorized',
    });
    expect(await evaluateLoginAttempt(GOOD, IP, limiter)).toEqual({
      outcome: 'allowed',
    });
    expect(check).toHaveBeenCalledTimes(1);
  });
});
