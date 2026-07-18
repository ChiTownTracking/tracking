import { z } from 'zod';

// Schema only — parsing happens at the bottom of orsClient.ts, where the real
// singleton is built (same pattern as quartixEnv.ts/redisEnv.ts). Server-only
// key: deliberately NOT NEXT_PUBLIC_-prefixed, it must never reach the browser.
export const orsEnvSchema = z.object({
  ORS_API_KEY: z.string().min(1),
});
