import { describe, expect, it } from 'vitest';
import { computeDailySchedule } from '@/lib/dailySchedule';
import type { ScheduleEntry } from '@/lib/trips';

function entry(
  id: string,
  arrivalTime: string,
  overrides: Partial<ScheduleEntry> = {},
): ScheduleEntry {
  return { id, arrivalTime, waitMinutes: 0, ...overrides };
}

describe('computeDailySchedule', () => {
  // The EXACT reported scenario, mirroring scheduleOccurrence.test.ts's:
  // windowStart = Jul 22, 7:06 PM Chicago; now = Jul 22, ~7:30 PM Chicago;
  // four early-morning entries whose TODAY occurrences all precede the
  // window opening.
  const WINDOW_START = '2026-07-23T00:06:00.000Z';
  const WINDOW_END = '2026-07-30T00:06:00.000Z';
  const NOW = new Date('2026-07-23T00:30:00.000Z');
  const TRIP_DURATION_SECONDS = 1800;
  const SCHEDULE = [
    entry('run-1', '09:00'),
    // Deliberately unsorted on input — order must come from the output,
    // not the input.
    entry('run-4', '07:30'),
    entry('run-2', '08:30'),
    entry('run-3', '08:00'),
  ];

  it("dateOffsetDays=0 (today) returns an EMPTY array — nothing valid today", () => {
    const today = computeDailySchedule(
      SCHEDULE,
      0,
      WINDOW_START,
      WINDOW_END,
      TRIP_DURATION_SECONDS,
      NOW,
    );
    expect(today).toEqual([]);
  });

  it("dateOffsetDays=1 (tomorrow) returns all four, each 'upcoming', in chronological order", () => {
    const tomorrow = computeDailySchedule(
      SCHEDULE,
      1,
      WINDOW_START,
      WINDOW_END,
      TRIP_DURATION_SECONDS,
      NOW,
    );
    expect(tomorrow.map((item) => item.entry.id)).toEqual([
      'run-4', // 07:30
      'run-3', // 08:00
      'run-2', // 08:30
      'run-1', // 09:00
    ]);
    expect(tomorrow.every((item) => item.status === 'upcoming')).toBe(true);
    // No stored predictions on any of these entries.
    expect(
      tomorrow.every((item) => item.predictedArrivalClock === undefined),
    ).toBe(true);
  });

  // Cancelled entries: included when window-valid, status forced to the
  // literal 'cancelled' — never excluded outright the way an out-of-
  // window entry is.
  it('includes a cancelled entry (status "cancelled") when its occurrence is window-valid', () => {
    const withCancelled = computeDailySchedule(
      [entry('run-c', '08:00', { cancelled: true })],
      1,
      WINDOW_START,
      WINDOW_END,
      TRIP_DURATION_SECONDS,
      NOW,
    );
    expect(withCancelled).toEqual([
      { entry: withCancelled[0].entry, status: 'cancelled' },
    ]);
  });

  it('still EXCLUDES a cancelled entry whose occurrence falls outside the window', () => {
    const todayCancelled = computeDailySchedule(
      [entry('run-c', '08:00', { cancelled: true })],
      0, // today — outside the window, same as the real entries
      WINDOW_START,
      WINDOW_END,
      TRIP_DURATION_SECONDS,
      NOW,
    );
    expect(todayCancelled).toEqual([]);
  });

  // A stored raw prediction becomes a buffered single clock time.
  it('computes a buffered predictedArrivalClock when a raw prediction is stored', () => {
    const withPrediction = computeDailySchedule(
      [
        entry('run-p', '07:30', {
          predictedArrivalDurationSeconds: 1000,
        }),
      ],
      1,
      WINDOW_START,
      WINDOW_END,
      TRIP_DURATION_SECONDS,
      NOW,
    );
    // Departure = arrival (no wait) = 07:30 tomorrow. 1000s * 1.1 buffer =
    // 1100s → round to 18 min (1100/60 = 18.33 → 18) → 07:48.
    expect(withPrediction[0].predictedArrivalClock).toBe('07:48');
  });

  // No trip-level window at all (legacy trip): nothing is filtered, every
  // entry appears with its plain clock status — the pre-N6 behavior.
  it('an absent window filters nothing — every entry appears with plain clock status', () => {
    const noon = new Date('2026-07-17T17:00:00Z');
    const legacy = computeDailySchedule(
      [
        entry('done', '09:00'),
        entry('active', '11:55', { waitMinutes: 10 }),
        entry('later', '14:00'),
      ],
      0,
      undefined,
      undefined,
      600,
      noon,
    );
    expect(legacy.map((item) => [item.entry.id, item.status])).toEqual([
      ['done', 'completed'],
      ['active', 'in-progress'],
      ['later', 'upcoming'],
    ]);
  });
});
