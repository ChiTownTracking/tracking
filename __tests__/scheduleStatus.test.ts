import { describe, expect, it } from 'vitest';
import { getTripStatus } from '@/lib/scheduleStatus';

// Chicago is UTC-5 (CDT) in July: 19:30:00Z === 14:30:00 Chicago wall clock.
// Schedule under test: departs 14:30, runs 3600s → ends 15:30 Chicago.
const DEPARTURE = '14:30';
const DURATION = 3600;

function utc(iso: string): Date {
  return new Date(iso);
}

describe('getTripStatus', () => {
  it('is in-progress exactly at the scheduled time (boundary, not upcoming)', () => {
    expect(
      getTripStatus(DEPARTURE, DURATION, utc('2026-07-16T19:30:00Z')),
    ).toBe('in-progress');
  });

  it('is upcoming one second before the scheduled time', () => {
    expect(
      getTripStatus(DEPARTURE, DURATION, utc('2026-07-16T19:29:59Z')),
    ).toBe('upcoming');
  });

  it('is in-progress one second after the scheduled time', () => {
    expect(
      getTripStatus(DEPARTURE, DURATION, utc('2026-07-16T19:30:01Z')),
    ).toBe('in-progress');
  });

  it('is completed exactly at scheduled time + duration (boundary, not in-progress)', () => {
    expect(
      getTripStatus(DEPARTURE, DURATION, utc('2026-07-16T20:30:00Z')),
    ).toBe('completed');
  });

  it('is in-progress one second before the end boundary', () => {
    expect(
      getTripStatus(DEPARTURE, DURATION, utc('2026-07-16T20:29:59Z')),
    ).toBe('in-progress');
  });

  it('is completed one second after the end boundary', () => {
    expect(
      getTripStatus(DEPARTURE, DURATION, utc('2026-07-16T20:30:01Z')),
    ).toBe('completed');
  });

  it('is upcoming comfortably before departure', () => {
    // 15:00Z → 10:00 Chicago.
    expect(
      getTripStatus(DEPARTURE, DURATION, utc('2026-07-16T15:00:00Z')),
    ).toBe('upcoming');
  });

  it('is in-progress comfortably mid-trip', () => {
    // 20:00Z → 15:00 Chicago.
    expect(
      getTripStatus(DEPARTURE, DURATION, utc('2026-07-16T20:00:00Z')),
    ).toBe('in-progress');
  });

  it('is completed comfortably after the trip', () => {
    // 23:00Z → 18:00 Chicago.
    expect(
      getTripStatus(DEPARTURE, DURATION, utc('2026-07-16T23:00:00Z')),
    ).toBe('completed');
  });

  // Chicago anchoring, not UTC and not the runner's local zone: 19:30Z in
  // JANUARY is 13:30 Chicago (CST, UTC-6) — an hour before departure —
  // whereas a UTC reading would call it long completed.
  it('anchors to Chicago wall-clock time across the winter offset too', () => {
    expect(
      getTripStatus(DEPARTURE, DURATION, utc('2026-01-15T19:30:00Z')),
    ).toBe('upcoming');
    // 20:30:00Z in January → 14:30:00 Chicago → exactly at departure.
    expect(
      getTripStatus(DEPARTURE, DURATION, utc('2026-01-15T20:30:00Z')),
    ).toBe('in-progress');
  });
});
