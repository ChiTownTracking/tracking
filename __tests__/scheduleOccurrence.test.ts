import { describe, expect, it } from 'vitest';
import {
  computeOccurrenceTimestamp,
  computeOccurrenceValidity,
} from '@/lib/scheduleOccurrence';
import type { ScheduleEntry } from '@/lib/trips';

function entry(arrivalTime: string, waitMinutes = 0): ScheduleEntry {
  return { id: `run-${arrivalTime}`, arrivalTime, waitMinutes };
}

describe('computeOccurrenceTimestamp', () => {
  // Chicago is UTC-5 (CDT) in July.
  it("returns TODAY's real instant for dateOffsetDays 0", () => {
    // Noon Chicago, July 17.
    const now = new Date('2026-07-17T17:00:00Z');
    // 09:00 Chicago, same day → 14:00Z.
    expect(computeOccurrenceTimestamp('09:00', 0, now)).toEqual(
      new Date('2026-07-17T14:00:00Z'),
    );
  });

  it("returns TOMORROW's real instant, exactly 24h later, for dateOffsetDays 1", () => {
    const now = new Date('2026-07-17T17:00:00Z');
    expect(computeOccurrenceTimestamp('09:00', 1, now)).toEqual(
      new Date('2026-07-18T14:00:00Z'),
    );
  });

  it('dateOffsetDays 0 is unaffected by whether the time already passed today', () => {
    // Noon Chicago; 07:00 already passed today, but dateOffsetDays=0 still
    // means TODAY at 07:00 — a real past instant, not "next occurrence."
    const now = new Date('2026-07-17T17:00:00Z');
    expect(computeOccurrenceTimestamp('07:00', 0, now)).toEqual(
      new Date('2026-07-17T12:00:00Z'),
    );
  });
});

describe('computeOccurrenceValidity', () => {
  // The EXACT reported scenario: a trip whose active window opens the
  // same evening it's created (windowStart = July 22, 7:06 PM Chicago =
  // 2026-07-23T00:06:00Z), with a daily schedule of early-morning times.
  // `now` is July 22, ~7:30 PM Chicago (2026-07-23T00:30:00Z) — the
  // window is open, but TODAY's own 7:30/8:00/8:30/9:00 AM occurrences
  // all happened HOURS BEFORE the window even existed.
  const WINDOW_START = '2026-07-23T00:06:00.000Z'; // Jul 22, 7:06 PM Chicago
  const WINDOW_END = '2026-07-30T00:06:00.000Z'; // a week later
  const NOW = new Date('2026-07-23T00:30:00.000Z'); // Jul 22, 7:30 PM Chicago
  const TRIP_DURATION_SECONDS = 1800;
  const TIMES = ['07:30', '08:00', '08:30', '09:00'];

  it("TODAY's occurrence of every entry is outside the window — none of them ever really happened under this link", () => {
    for (const time of TIMES) {
      const validity = computeOccurrenceValidity(
        entry(time),
        0,
        WINDOW_START,
        WINDOW_END,
        TRIP_DURATION_SECONDS,
        NOW,
      );
      expect(validity.withinWindow).toBe(false);
      // No status for an occurrence that doesn't count.
      expect(validity.status).toBeUndefined();
    }
  });

  it("TOMORROW's occurrence of every entry IS within the window, and upcoming — the real regression fix", () => {
    for (const time of TIMES) {
      const validity = computeOccurrenceValidity(
        entry(time),
        1,
        WINDOW_START,
        WINDOW_END,
        TRIP_DURATION_SECONDS,
        NOW,
      );
      expect(validity.withinWindow).toBe(true);
      expect(validity.status).toBe('upcoming');
    }
  });

  // The window gates on DEPARTURE (arrival + wait), not bare arrival.
  it('gates on the DEPARTURE timestamp (arrival + waitMinutes), not the bare arrival', () => {
    // Arrival lands exactly 5 minutes before windowStart; a 10-minute wait
    // pushes the real DEPARTURE to 5 minutes after windowStart — still a
    // legitimate occurrence.
    const arrivalTime = '19:01'; // 5 min before 7:06 PM Chicago
    const withWait = computeOccurrenceValidity(
      entry(arrivalTime, 10),
      0,
      WINDOW_START,
      WINDOW_END,
      TRIP_DURATION_SECONDS,
      new Date('2026-07-23T00:01:00.000Z'), // Jul 22, 7:01 PM Chicago
    );
    expect(withWait.withinWindow).toBe(true);

    // Same arrival, no wait: departure IS the arrival, still before the
    // window opens.
    const withoutWait = computeOccurrenceValidity(
      entry(arrivalTime, 0),
      0,
      WINDOW_START,
      WINDOW_END,
      TRIP_DURATION_SECONDS,
      new Date('2026-07-23T00:01:00.000Z'),
    );
    expect(withoutWait.withinWindow).toBe(false);
  });

  // The ordinary, mature-trip case: a window that opened days ago must
  // still correctly mark a genuinely-past today occurrence as completed —
  // this fix must not disturb the normal case.
  it('a mature trip (window opened days ago) still marks a genuinely-past today run as completed', () => {
    // durationSeconds is the caller's job to combine, same convention as
    // getTripStatus everywhere else: entry.waitMinutes*60 (10*60) + the
    // trip's 600s drive = 1200s. 09:00 + 20min ends 09:20, long before
    // noon.
    const validity = computeOccurrenceValidity(
      entry('09:00', 10),
      0,
      '2026-07-15T00:00:00.000Z', // window opened a week before `now`
      '2026-08-15T00:00:00.000Z', // and stays open for weeks
      10 * 60 + 600,
      new Date('2026-07-22T17:00:00Z'), // noon Chicago, July 22
    );
    expect(validity).toEqual({ withinWindow: true, status: 'completed' });
  });

  // No trip-level window at all (a pre-N3 legacy trip): every occurrence
  // is valid, status alone decides — the exact pre-N6 behavior.
  it('an absent window means NO gating at all — every occurrence is valid', () => {
    const validity = computeOccurrenceValidity(
      entry('09:00', 10),
      0,
      undefined,
      undefined,
      10 * 60 + 600,
      new Date('2026-07-22T17:00:00Z'),
    );
    expect(validity).toEqual({ withinWindow: true, status: 'completed' });
  });
});
