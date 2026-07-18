import { z } from 'zod';

// Fails loudly and immediately when required keys are missing or malformed —
// no fallback, no silent default. Swallowing a bad/missing env var here is
// the exact anti-pattern this rebuild exists to avoid.
export function parseEnv<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  source: Record<string, string | undefined> = process.env,
): z.infer<z.ZodObject<T>> {
  return schema.parse(source);
}
