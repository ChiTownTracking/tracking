import { Redis } from '@upstash/redis';
import { parseEnv } from './env';
import { redisEnvSchema } from './redisEnv';

// Lazily-initialized client, same pattern as the quartixClient singleton:
// importable (and buildable) without Redis env vars; missing config fails
// loudly via parseEnv on first real use. No local-file fallback of any kind.
// Shared by trackingTokens and rateLimiter — one connection, one set of creds.
let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    parseEnv(redisEnvSchema, process.env);
    redis = Redis.fromEnv();
  }
  return redis;
}
