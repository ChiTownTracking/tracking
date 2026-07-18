import { z } from 'zod';

// Schema only — parsing happens at the bottom of googleMapsClient.ts, where
// the real singleton is built (same pattern as orsEnv.ts/quartixEnv.ts).
// Server-only key: deliberately NOT NEXT_PUBLIC_-prefixed, it must never
// reach the browser.
export const googleMapsEnvSchema = z.object({
  GOOGLE_MAPS_API_KEY: z.string().min(1),
});
