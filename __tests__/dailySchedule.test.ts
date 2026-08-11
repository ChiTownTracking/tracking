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
  const STATIC_TRAVEL_SECONDS = 600; // the trip's own drive time
  const DURATION_SECONDS = 10 * 60 + STATIC_TRAVEL_SECONDS; // wait + drive, as callers pass

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
      STATIC_TRAVEL_SECONDS,
      NOON,
    );
  }

  // THE trigger: a confirmed pickup starts the run, full stop.
  //
  // This deliberately SUPERSEDES Phase Q's extra gate, which also
  // required the scheduled instant to have passed and so held an
  // early-detected run at 'upcoming' until the clock caught up (its
  // 16:54:59.999/16:55:00.000 boundary test is gone with it — there is no
  // such boundary now). Detection is already bounded to a few minutes
  // either side of the scheduled arrival, so a stamp existing at all is
  // sufficient evidence the run has begun.
  it('a pickup confirmed EARLY is in-progress IMMEDIATELY, with no wait for the scheduled instant', () => {
    // Detected at 11:50, five minutes ahead of the 11:55 run.
    const entryAt1155 = entry('run-a', '11:55', {
      waitMinutes: 10,
      actualPickupAt: '2026-07-17T16:50:00.000Z',
      actualPickupDate: TODAY,
    });
    const statusAt = (iso: string): TripStatus =>
      resolveDisplayStatus(
        entryAt1155,
        0,
        DURATION_SECONDS,
        STATIC_TRAVEL_SECONDS,
        new Date(iso),
      );

    // The detection instant itself — nothing further is waited on.
    expect(statusAt('2026-07-17T16:50:00.000Z')).toBe('in-progress');
    // The instant Phase Q used to call 'upcoming', one millisecond short
    // of 11:55: in progress now, from the very same stored data.
    expect(statusAt('2026-07-17T16:54:59.999Z')).toBe('in-progress');
    // And unchanged across the old boundary, which no longer means
    // anything here.
    expect(statusAt('2026-07-17T16:55:00.000Z')).toBe('in-progress');
  });

  it('a pickup confirmed inside the late window is in-progress immediately', () => {
    // Scheduled 11:55, detected 11:58 — already past the scheduled
    // instant, so there is nothing to wait for.
    expect(
      statusOf({
        actualPickupAt: '2026-07-17T16:58:00.000Z',
        actualPickupDate: TODAY,
      }),
    ).toBe('in-progress');
  });

  // Departure is no longer part of this decision at all (it drives the
  // map marker and the live dot instead) — a picked-up run reads the same
  // whether or not it has physically pulled away.
  it('reads the same with or without a departure recorded', () => {
    expect(statusOf(PICKED_UP)).toBe('in-progress');
    expect(statusOf({ ...PICKED_UP, ...DEPARTED })).toBe('in-progress');
  });

  it('a confirmed drop-off reads COMPLETED, outranking everything above', () => {
    expect(statusOf({ ...PICKED_UP, ...DEPARTED, ...DROPPED_OFF })).toBe(
      'completed',
    );
    // Even with no departure ever recorded.
    expect(statusOf({ ...PICKED_UP, ...DROPPED_OFF })).toBe('completed');
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

  // The Phase P downgrade still stands: the clock alone can never promote
  // a run to in-progress.
  it('an unconfirmed run mid-window is still downgraded to UPCOMING', () => {
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

  it('a pickup stamp from a DIFFERENT date never starts a run', () => {
    // Yesterday's arrival sitting on this daily-recurring entry.
    expect(
      statusOf({
        actualPickupAt: '2026-07-16T16:57:00.000Z',
        actualPickupDate: '2026-07-16',
      }),
    ).toBe('upcoming');
  });

  // Phase R: the absolute ceiling. Every case above assumes detection
  // eventually records what happened; these are the ones where it never
  // does, and the row would otherwise read "In progress" forever.
  //
  // For this fixture — 11:55 (16:55Z) + 10 min drive + 5 min grace — the
  // ceiling falls at 17:10:00.000Z exactly. Note that NOON (17:00Z), the
  // instant every test above pins, sits ten minutes short of it, so none
  // of their expectations move.
  describe('absolute in-progress ceiling', () => {
    const CEILING = new Date('2026-07-17T17:10:00.000Z');
    const at = (iso: string, overrides: Partial<ScheduleEntry>): TripStatus =>
      resolveDisplayStatus(
        entry('run-a', '11:55', { waitMinutes: 10, ...overrides }),
        0,
        DURATION_SECONDS,
        STATIC_TRAVEL_SECONDS,
        new Date(iso),
      );

    // The stuck-vehicle case this exists for: a real pickup, then silence
    // — no departure ever detected, no drop-off ever detected — with the
    // page still being polled long afterwards.
    it('flips a picked-up run with NO departure or drop-off recorded at exactly the ceiling', () => {
      // One millisecond short: still under way, on the fact alone.
      expect(at('2026-07-17T17:09:59.999Z', PICKED_UP)).toBe('in-progress');
      // At the ceiling: over, from identical stored data.
      expect(at(CEILING.toISOString(), PICKED_UP)).toBe('completed');
      // And it stays over — this is a floor, not a momentary flip.
      expect(at('2026-07-17T19:30:00.000Z', PICKED_UP)).toBe('completed');
    });

    it('a departure that was recorded, with the drop-off never detected, does not extend it either', () => {
      expect(at('2026-07-17T17:09:59.999Z', { ...PICKED_UP, ...DEPARTED })).toBe(
        'in-progress',
      );
      expect(at(CEILING.toISOString(), { ...PICKED_UP, ...DEPARTED })).toBe(
        'completed',
      );
    });

    // A genuinely recorded drop-off must be answered by the FACT, not by
    // the backstop that happens to agree with it. Both return 'completed',
    // so the return value alone cannot tell the two branches apart — the
    // entry below is booby-trapped instead: reading arrivalTime is the
    // first thing computing the ceiling does, and nothing before the
    // drop-off check touches it. If the ceiling were evaluated first, this
    // throws instead of returning.
    it('answers a confirmed drop-off from the real fact, without ever computing the ceiling', () => {
      const droppedOffBeforeCeiling = {
        ...PICKED_UP,
        actualDropoffAt: '2026-07-17T17:04:00.000Z',
        actualDropoffDate: TODAY,
      };
      const poisoned: ScheduleEntry = {
        id: 'run-a',
        waitMinutes: 10,
        ...droppedOffBeforeCeiling,
        get arrivalTime(): string {
          throw new Error(
            'the ceiling was computed before the recorded drop-off answered',
          );
        },
      };

      // 17:05 — the drop-off is real, and the ceiling is still five
      // minutes away, so branch order is the only thing under test here.
      const justAfterDropoff = new Date('2026-07-17T17:05:00.000Z');
      expect(
        resolveDisplayStatus(
          poisoned,
          0,
          DURATION_SECONDS,
          STATIC_TRAVEL_SECONDS,
          justAfterDropoff,
        ),
      ).toBe('completed');

      // Proof the trap is live rather than the assertion above passing on
      // an entry that simply never reads arrivalTime: the same booby-trap
      // WITHOUT the drop-off stamp falls through to the ceiling and blows
      // up. (Built fresh — spreading `poisoned` would fire the getter.)
      const poisonedNoDropoff: ScheduleEntry = {
        id: 'run-a',
        waitMinutes: 10,
        ...PICKED_UP,
        get arrivalTime(): string {
          throw new Error('the ceiling was computed');
        },
      };
      expect(() =>
        resolveDisplayStatus(
          poisonedNoDropoff,
          0,
          DURATION_SECONDS,
          STATIC_TRAVEL_SECONDS,
          justAfterDropoff,
        ),
      ).toThrow('the ceiling was computed');
    });

    // The ceiling bounds runs that really started; it has no business
    // ending one nobody ever saw begin. Such a run can't be 'in-progress'
    // anyway (the clock alone never promotes one), so applying it there
    // would only declare an unobserved run finished BEFORE its own window
    // closes — a claim there's no evidence for.
    it('leaves a run with no pickup at all to the clock fallback', () => {
      // 17:12 — two minutes PAST the ceiling, three short of this run's
      // own window end (16:55 + 20 min). Untouched: still upcoming.
      expect(at('2026-07-17T17:12:00.000Z', {})).toBe('upcoming');
      // 17:15 — its window elapses, and the pre-existing fallback (not the
      // ceiling) is what completes it.
      expect(at('2026-07-17T17:15:00.000Z', {})).toBe('completed');
    });
  });
});
