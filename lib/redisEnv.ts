import { z } from 'zod';

// Schema only — parsed lazily in trackingTokens.ts on first real use, same
// pattern as every other env module in this project.
export const redisEnvSchema = z.object({
  UPSTASH_REDIS_REST_URL: z.string().min(1),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
});
