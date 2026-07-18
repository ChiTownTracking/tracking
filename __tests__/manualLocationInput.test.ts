import { describe, expect, it } from 'vitest';
import { parseManualLocation } from '@/lib/manualLocationInput';

describe('parseManualLocation', () => {
  describe('raw lat, lng pairs', () => {
    it('parses the exact Google Maps copy format', () => {
      expect(parseManualLocation('41.878988, -87.639732')).toEqual({
        lat: 41.878988,
        lng: -87.639732,
      });
    });

    it('parses without a space after the comma', () => {
      expect(parseManualLocation('41.878988,-87.639732')).toEqual({
        lat: 41.878988,
        lng: -87.639732,
      });
    });

    it('parses with surrounding parens and extra whitespace', () => {
      expect(parseManualLocation('  (41.878988, -87.639732)  ')).toEqual({
        lat: 41.878988,
        lng: -87.639732,
      });
    });

    it('parses integer coordinates', () => {
      expect(parseManualLocation('42, -88')).toEqual({ lat: 42, lng: -88 });
    });

    it('rejects an out-of-range latitude', () => {
      expect(parseManualLocation('90.1, -87.6')).toBeNull();
      expect(parseManualLocation('-91, -87.6')).toBeNull();
    });

    it('rejects an out-of-range longitude', () => {
      expect(parseManualLocation('41.8, 180.5')).toBeNull();
      expect(parseManualLocation('41.8, -181')).toBeNull();
    });
  });

  describe('Plus Codes', () => {
    // Ground-truth values probed directly from the open-location-code
    // reference implementation, not computed by hand.
    it('decodes a full Plus Code with no reference point', () => {
      const result = parseManualLocation('86HJV9H6+H4');
      expect(result).not.toBeNull();
      expect(result?.lat).toBeCloseTo(41.8789375, 6);
      expect(result?.lng).toBeCloseTo(-87.6396875, 6);
    });

    it('decodes a short Plus Code against the fixed Chicago reference', () => {
      const result = parseManualLocation('V9H6+52');
      expect(result).not.toBeNull();
      expect(result?.lat).toBeCloseTo(41.8779375, 6);
      expect(result?.lng).toBeCloseTo(-87.6399375, 6);
    });

    it('strips trailing locality text after a short Plus Code', () => {
      const bare = parseManualLocation('V9H6+52');
      expect(parseManualLocation('V9H6+52 Chicago, Illinois')).toEqual(bare);
      expect(parseManualLocation('V9H6+52, Chicago')).toEqual(bare);
    });
  });

  describe('everything else', () => {
    it.each([
      ['plain words', 'Union Station'],
      ['empty string', ''],
      ['whitespace only', '   '],
      ['a lone number', '41.8789'],
      ['an invalid code shape', 'V9H6-52'],
      ['random symbols', '@@@@'],
    ])('returns null (never throws) for %s', (_label, input) => {
      expect(parseManualLocation(input)).toBeNull();
    });
  });
});
