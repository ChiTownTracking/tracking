import { z } from 'zod';
import { parseEnv } from './env';

export const dashboardAuthEnvSchema = z.object({
  DASHBOARD_USER: z.string().min(1),
  DASHBOARD_PASS: z.string().min(1),
});

// Parsed lazily on call (same reasoning as quartixClient's singleton and
// appEnv.ts): importable in tests and at build time without the env vars
// present; missing credentials still fail loudly on first actual use.
export function getDashboardCredentials(): {
  username: string;
  password: string;
} {
  const env = parseEnv(dashboardAuthEnvSchema, process.env);
  return { username: env.DASHBOARD_USER, password: env.DASHBOARD_PASS };
}
