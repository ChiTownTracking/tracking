import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatRelativeTime,
  getStatusLabel,
  isVehicleLive,
} from '@/lib/vehicleStatus';

// Fixed "now", chosen mid-day UTC so the >7d date formatting lands on the
// same calendar day regardless of the machine's timezone.
const NOW = new Date('2026-06-11T18:00:00Z');

function secondsAgo(s: number): string {
  return new Date(NOW.getTime() - s * 1000).toISOString();
}

describe('vehicleStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isVehicleLive', () => {
    it('is true just under the 2-minute boundary', () => {
      expect(isVehicleLive(secondsAgo(119))).toBe(true);
    });

    it('is false just over the 2-minute boundary', () => {
      expect(isVehicleLive(secondsAgo(121))).toBe(false);
    });
  });

  describe('formatRelativeTime', () => {
    it('formats seconds under a minute', () => {
      expect(formatRelativeTime(secondsAgo(59))).toBe('59s ago');
    });

    it('rolls into minutes past 60s', () => {
      expect(formatRelativeTime(secondsAgo(61))).toBe('1m ago');
    });

    it('formats minutes under an hour', () => {
      expect(formatRelativeTime(secondsAgo(59 * 60))).toBe('59m ago');
    });

    it('rolls into hours past 60min', () => {
      expect(formatRelativeTime(secondsAgo(61 * 60))).toBe('1h ago');
    });

    it('formats hours under a day', () => {
      expect(formatRelativeTime(secondsAgo(23 * 3600))).toBe('23h ago');
    });

    it('rolls into days past 24h', () => {
      expect(formatRelativeTime(secondsAgo(25 * 3600))).toBe('1d ago');
    });

    it('formats days under a week', () => {
      expect(formatRelativeTime(secondsAgo(6 * 86400))).toBe('6d ago');
    });

    it('switches to a real date past 7 days instead of a large number', () => {
      expect(formatRelativeTime(secondsAgo(8 * 86400))).toBe('on Jun 3, 2026');
    });

    it('guards negative diffs (clock skew) with "just now"', () => {
      expect(formatRelativeTime(secondsAgo(-30))).toBe('just now');
    });
  });

  describe('getStatusLabel', () => {
    it('returns "En route" for a fresh position with speed > 2', () => {
      expect(getStatusLabel(28, secondsAgo(30))).toBe('En route');
    });

    it('returns "Stopped" for a fresh position with speed <= 2', () => {
      expect(getStatusLabel(0, secondsAgo(30))).toBe('Stopped');
      expect(getStatusLabel(2, secondsAgo(30))).toBe('Stopped');
    });

    it('returns "No recent signal" past 24h even when speed is high', () => {
      expect(getStatusLabel(45, secondsAgo(25 * 3600))).toBe('No recent signal');
    });
  });
});
