import { z } from 'zod';
import { parseEnv } from './env';

// App-level config, deliberately separate from quartixEnv.ts — this is not a
// Quartix credential, it's which vehicles this app tracks.
export const appEnvSchema = z.object({
  QUARTIX_VEHICLE_IDS: z.string().min(1),
});

// Parsed lazily on call (same reasoning as the quartixClient singleton): this
// module must be importable in tests and at build time without the env var
// existing. Missing config still fails loudly on first use.
export function getTrackedVehicleIds(): string[] {
  const env = parseEnv(appEnvSchema, process.env);
  return env.QUARTIX_VEHICLE_IDS.split(',').map((id) => id.trim());
}
