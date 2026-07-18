import { z } from 'zod';

// Schema only — parsing happens at the bottom of quartixClient.ts, where the
// real singleton is built. Keeping parseEnv out of this module means tests can
// import Quartix code without real env vars existing.
export const quartixEnvSchema = z.object({
  QUARTIX_BASE_URL: z.string().min(1),
  QUARTIX_CUSTOMER_ID: z.string().min(1),
  QUARTIX_USERNAME: z.string().min(1),
  QUARTIX_PASSWORD: z.string().min(1),
  QUARTIX_APPLICATION: z.string().min(1),
});
