import { describe, expect, it } from 'vitest';
import { timingSafeStringEqual } from '@/lib/timingSafeCompare';

describe('timingSafeStringEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeStringEqual('s3cret-pass', 's3cret-pass')).toBe(true);
  });

  it('returns false for different same-length strings', () => {
    expect(timingSafeStringEqual('aaaaaa', 'aaaaab')).toBe(false);
  });

  // The case that motivates hashing first: raw crypto.timingSafeEqual THROWS
  // on different-length inputs instead of returning false.
  it('returns false for different-length strings without throwing', () => {
    expect(() => timingSafeStringEqual('short', 'much-longer-string')).not.toThrow();
    expect(timingSafeStringEqual('short', 'much-longer-string')).toBe(false);
  });
});
