import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseEnv } from '@/lib/env';

describe('parseEnv', () => {
  const schema = z.object({ EXAMPLE_REQUIRED: z.string() });

  it('returns the parsed value when the required key is present', () => {
    expect(parseEnv(schema, { EXAMPLE_REQUIRED: 'value' })).toEqual({
      EXAMPLE_REQUIRED: 'value',
    });
  });

  it('throws when the required key is missing', () => {
    expect(() => parseEnv(schema, {})).toThrow();
  });
});
