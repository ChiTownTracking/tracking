import { createHash, timingSafeEqual } from 'node:crypto';

// Hash both inputs before comparing: crypto.timingSafeEqual THROWS on
// different-length buffers, which would both crash on mismatched-length
// input and leak length information. sha256 digests are always 32 bytes,
// so the comparison is safe for any pair of strings.
export function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
