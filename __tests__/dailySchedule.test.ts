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
    // Nothing detected on any of these entries.
    expect(
      tomorrow.every((item) => item.actualPickupClock === undefined),
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

  // Phase N7: the row's third column is now its OWN confirmed pickup —
  // scoped to the calendar day THAT row is for, never a prediction and
  // never another day's stamp.
  //
  // A separate clock from the window fixtures above, on an ordinary
  // mid-window day: noon Chicago on Fri, Jul 17 2026 ("2026-07-17"), with
  // no trip window at all so nothing is filtered out.
  describe('actualPickupClock (per-row pickup detection)', () => {
    const NOON = new Date('2026-07-17T17:00:00.000Z');
    const DETECTED_AT = '2026-07-17T16:57:00.000Z'; // 11:57 AM Chicago

    function rowsFor(dateOffsetDays: number, overrides: Partial<ScheduleEntry>) {
      return computeDailySchedule(
        [entry('run-a', '11:55', { waitMinutes: 10, ...overrides })],
        dateOffsetDays,
        undefined,
        undefined,
        600,
        NOON,
      );
    }

    it("a same-date detection returns THIS row's formatted 12-hour clock", () => {
      const [row] = rowsFor(0, {
        actualPickupAt: DETECTED_AT,
        actualPickupDate: '2026-07-17',
      });

      expect(row.actualPickupClock).toBe('11:57 AM');
    });

    it('a detection from a DIFFERENT date is absent, never shown as this row\'s time', () => {
      // Yesterday's leftover on the same daily-recurring entry.
      const [row] = rowsFor(0, {
        actualPickupAt: '2026-07-16T16:57:00.000Z',
        actualPickupDate: '2026-07-16',
      });

      expect(row.actualPickupClock).toBeUndefined();
      // Omitted entirely, not present-and-empty.
      expect(row).not.toHaveProperty('actualPickupClock');
    });

    it('an entry with no detection at all is absent', () => {
      const [row] = rowsFor(0, {});

      expect(row).not.toHaveProperty('actualPickupClock');
    });

    it("TOMORROW's row of a run detected TODAY is absent — each row checks its own day", () => {
      // The one detection is real and today's; tomorrow's occurrence of the
      // very same entry has not happened, so its row must stay blank.
      const detection = {
        actualPickupAt: DETECTED_AT,
        actualPickupDate: '2026-07-17',
      };
      const [todayRow] = rowsFor(0, detection);
      const [tomorrowRow] = rowsFor(1, detection);

      expect(todayRow.actualPickupClock).toBe('11:57 AM');
      expect(tomorrowRow).not.toHaveProperty('actualPickupClock');
    });

    // The column never falls back to the predicted destination arrival it
    // replaced — a stored prediction alone puts nothing in this slot.
    it('a stored prediction with no detection still leaves the row blank', () => {
      const [row] = rowsFor(0, {
        predictedArrivalDurationSeconds: 1000,
        predictedArrivalStaticDurationSeconds: 1200,
      });

      expect(row).not.toHaveProperty('actualPickupClock');
    });
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
