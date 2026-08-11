import { describe, expect, it } from 'vitest';
import {
  computeDailySchedule,
  resolveDisplayStatus,
} from '@/lib/dailySchedule';
import { getOccurrenceStatus } from '@/lib/scheduleOccurrence';
import type { TripStatus } from '@/lib/scheduleStatus';
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

  // No trip-level window at all (legacy trip): nothing is FILTERED, every
  // entry appears — the pre-N6 behavior, which this still guards.
  //
  // Phase P changed what the statuses say, not what survives the filter.
  // None of these entries carries a real departure, so the 11:55 run —
  // which the bare clock would call in-progress at noon, and which this
  // test asserted as such before — is now 'upcoming'. The 09:00 run's
  // window has fully elapsed with nothing ever observed, so it stays
  // 'completed'.
  it('an absent window filters nothing — every entry appears, with fact-aware statuses', () => {
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
      // Mid-window by the clock, but nothing was ever observed departing.
      ['active', 'upcoming'],
      ['later', 'upcoming'],
    ]);
  });
});

// Phase P: "In progress" means an OBSERVED departure, not a clock that
// happened to enter the run's window. Pinned to noon Chicago on Fri, Jul
// 17 2026 ("2026-07-17"), with a run at 11:55 + 10 min wait + 10 min drive
// — a window of 11:55→12:15, so the bare clock calls it in-progress at
// noon. That disagreement is the whole point of these cases.
describe('resolveDisplayStatus', () => {
  const NOON = new Date('2026-07-17T17:00:00.000Z');
  const TODAY = '2026-07-17';
  const DURATION_SECONDS = 10 * 60 + 600; // wait + drive, as callers pass

  const PICKED_UP = {
    actualPickupAt: '2026-07-17T16:57:00.000Z',
    actualPickupDate: TODAY,
  };
  const DEPARTED = {
    actualDepartureAt: '2026-07-17T16:59:00.000Z',
    actualDepartureDate: TODAY,
  };
  const DROPPED_OFF = {
    actualDropoffAt: '2026-07-17T17:09:00.000Z',
    actualDropoffDate: TODAY,
  };

  function statusOf(
    overrides: Partial<ScheduleEntry> = {},
    dateOffsetDays = 0,
    arrivalTime = '11:55',
  ): TripStatus {
    return resolveDisplayStatus(
      entry('run-a', arrivalTime, { waitMinutes: 10, ...overrides }),
      dateOffsetDays,
      DURATION_SECONDS,
      NOON,
    );
  }

  // THE reported case: the bus arrived and is still sitting at the kerb,
  // the clock has wandered into the run's window, and the row was
  // announcing a journey that has not begun.
  it('picked up but not yet departed reads UPCOMING, even though the clock says in-progress', () => {
    // The clock genuinely disagrees — proving this isn't just a run that
    // hadn't started yet.
    expect(getOccurrenceStatus('11:55', 0, DURATION_SECONDS, NOON)).toBe(
      'in-progress',
    );

    expect(statusOf(PICKED_UP)).toBe('upcoming');
  });

  it('a confirmed departure reads IN PROGRESS', () => {
    expect(statusOf({ ...PICKED_UP, ...DEPARTED })).toBe('in-progress');
  });

  it('a confirmed drop-off reads COMPLETED, outranking the departure', () => {
    expect(statusOf({ ...PICKED_UP, ...DEPARTED, ...DROPPED_OFF })).toBe(
      'completed',
    );
  });

  // The dark-vehicle case: nothing was ever observed, but the whole window
  // is behind us. Calling that "upcoming" would be a plain lie.
  it('no facts at all with the window fully elapsed reads COMPLETED', () => {
    // 09:00 + 20 min ended at 09:20, hours before noon.
    expect(statusOf({}, 0, '09:00')).toBe('completed');
  });

  it('no facts at all before the run starts reads UPCOMING', () => {
    expect(statusOf({}, 0, '14:00')).toBe('upcoming');
  });

  // Only the clock-based in-progress is downgraded — the other two clock
  // answers pass through untouched.
  it('an unconfirmed run mid-window is the ONLY clock answer that changes', () => {
    // Same entry, same instant, no facts: was in-progress, now upcoming.
    expect(getOccurrenceStatus('11:55', 0, DURATION_SECONDS, NOON)).toBe(
      'in-progress',
    );
    expect(statusOf({})).toBe('upcoming');
  });

  // A future day can never match today's stamps, so it falls straight
  // through to the clock path it always used.
  it("TOMORROW's row ignores today's real facts entirely", () => {
    // Every fact recorded today, including a completed drop-off...
    const allFactsToday = { ...PICKED_UP, ...DEPARTED, ...DROPPED_OFF };

    // ...and tomorrow's occurrence of the same recurring entry is still
    // simply upcoming, exactly as the bare clock would say.
    expect(statusOf(allFactsToday, 1)).toBe('upcoming');
    expect(getOccurrenceStatus('11:55', 1, DURATION_SECONDS, NOON)).toBe(
      'upcoming',
    );
  });

  it('a departure stamp from a DIFFERENT date never promotes a row', () => {
    // Yesterday's departure sitting on this daily-recurring entry.
    expect(
      statusOf({
        ...PICKED_UP,
        actualDepartureAt: '2026-07-16T16:59:00.000Z',
        actualDepartureDate: '2026-07-16',
      }),
    ).toBe('upcoming');
  });
});
