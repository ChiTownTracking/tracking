import { afterEach, describe, expect, it, vi } from 'vitest';

describe('getRedis', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('fails loudly when Redis env vars are missing — no silent fallback', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    vi.resetModules();

    const { getRedis } = await import('@/lib/redisClient');
    expect(() => getRedis()).toThrow();
  });
});
