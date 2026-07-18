import { Ratelimit } from '@upstash/ratelimit';
import { getRedis } from './redisClient';

export interface RateLimitCheck {
  allowed: boolean;
  retryAfterMs?: number;
}

// Minimal surface dashboardGate and the routes depend on; tests inject fakes
// implementing this instead of standing up a real Upstash client.
export interface RateLimiter {
  check(key: string): Promise<RateLimitCheck>;
}

// Redis-backed limiter (Upstash sliding window) so limits hold across
// serverless instances, unlike the old per-process in-memory Map. Reuses the
// same lazy Redis client as trackingTokens — one connection, one set of creds;
// laziness keeps this module importable (and buildable) without Redis env vars.
export class RedisRateLimiter implements RateLimiter {
  private ratelimit: Ratelimit | null = null;

  constructor(
    private maxAttempts: number,
    private windowSeconds: number,
    private prefix: string,
  ) {}

  private getRatelimit(): Ratelimit {
    if (!this.ratelimit) {
      this.ratelimit = new Ratelimit({
        redis: getRedis(),
        limiter: Ratelimit.slidingWindow(
          this.maxAttempts,
          `${this.windowSeconds} s`,
        ),
        prefix: this.prefix,
      });
    }
    return this.ratelimit;
  }

  async check(key: string): Promise<RateLimitCheck> {
    const { success, reset } = await this.getRatelimit().limit(key);
    if (success) {
      return { allowed: true };
    }
    return { allowed: false, retryAfterMs: Math.max(0, reset - Date.now()) };
  }
}

// Real singleton for the dashboard front door: 5 attempts per 60 seconds
// per key. The class stays exported so tests can build isolated instances.
export const dashboardLoginLimiter = new RedisRateLimiter(
  5,
  60,
  'ratelimit:dashboard-login',
);
