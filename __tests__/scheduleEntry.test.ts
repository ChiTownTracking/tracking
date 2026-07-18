import { describe, expect, it } from 'vitest';
import { selectActiveScheduleEntry } from '@/lib/scheduleEntry';
import type { ScheduleEntry } from '@/lib/trips';

// July 2026: America/Chicago is CDT (UTC-5), so 17:00Z is noon Chicago —
// the same explicit-timezone reasoning getTripStatus itself is tested with.
const NOON_CHICAGO = new Date('2026-07-17T17:00:00Z');
const TRIP_DURATION_SECONDS = 3600;

function entry(
  id: string,
  arrivalTime: string,
  waitMinutes = 10,
  cancelled = false,
): ScheduleEntry {
  return { id, arrivalTime, waitMinutes, ...(cancelled ? { cancelled } : {}) };
}

describe('selectActiveScheduleEntry', () => {
  it('an in-progress run wins even when later upcoming runs exist', () => {
    // 11:30 + 10min wait + 1h drive runs until 12:40 Chicago — in progress
    // at noon. 09:00 ended 10:10 (completed); 14:00 is upcoming.
    const schedule = [
      entry('morning', '09:00'),
      entry('midday', '11:30'),
      entry('afternoon', '14:00'),
    ];

    expect(
      selectActiveScheduleEntry(schedule, TRIP_DURATION_SECONDS, NOON_CHICAGO)
        .id,
    ).toBe('midday');
  });

  it('the EARLIEST upcoming run wins when nothing is in progress, regardless of stored order', () => {
    // Deliberately unsorted: 15:00 listed before 13:00.
    const schedule = [
      entry('later', '15:00'),
      entry('sooner', '13:00'),
      entry('done', '09:00'),
    ];

    expect(
      selectActiveScheduleEntry(schedule, TRIP_DURATION_SECONDS, NOON_CHICAGO)
        .id,
    ).toBe('sooner');
  });

  it('the last run wins when everything today is already completed', () => {
    // Both ended well before noon; the latest one is the least-wrong
    // attribution target. Unsorted on purpose.
    const schedule = [entry('second', '08:30'), entry('first', '07:00')];

    expect(
      selectActiveScheduleEntry(schedule, TRIP_DURATION_SECONDS, NOON_CHICAGO)
        .id,
    ).toBe('second');
  });

  // The Phase L3 core regression: a cancelled run is not a real run, so
  // its clock window means nothing — a cancelled 11:30 must never read as
  // "in progress" at noon just because the clock says so.
  it('a cancelled run is NEVER selected as in-progress, even inside its own clock window', () => {
    // Without the cancelled flag, 11:30 would win as in-progress (the
    // first test above proves exactly that).
    const schedule = [
      entry('morning', '09:00'),
      entry('midday-cancelled', '11:30', 10, true),
      entry('afternoon', '14:00'),
    ];

    expect(
      selectActiveScheduleEntry(schedule, TRIP_DURATION_SECONDS, NOON_CHICAGO)
        .id,
    ).toBe('afternoon');
  });

  it('a cancelled run is skipped for next-upcoming in favor of a later real run', () => {
    // Nothing in progress; 13:00 is the sooner upcoming but cancelled.
    const schedule = [
      entry('cancelled-sooner', '13:00', 10, true),
      entry('real-later', '15:00'),
    ];

    expect(
      selectActiveScheduleEntry(schedule, TRIP_DURATION_SECONDS, NOON_CHICAGO)
        .id,
    ).toBe('real-later');
  });

  it('the all-done fallback prefers the last REAL run over a later cancelled one', () => {
    // Both real runs completed; the 16:00 cancellation must not become the
    // dwell-attribution target just because it sorts last.
    const schedule = [
      entry('first', '07:00'),
      entry('second', '08:30'),
      entry('cancelled-later', '16:00', 10, true),
    ];

    expect(
      selectActiveScheduleEntry(
        schedule,
        TRIP_DURATION_SECONDS,
        new Date('2026-07-17T23:30:00Z'), // 18:30 Chicago — 16:00 window over too
      ).id,
    ).toBe('second');
  });

  it('when EVERY run is cancelled, the last one is returned as a display anchor, flag intact', () => {
    const schedule = [
      entry('c1', '09:00', 10, true),
      entry('c2', '14:00', 0, true),
    ];

    const selected = selectActiveScheduleEntry(
      schedule,
      TRIP_DURATION_SECONDS,
      NOON_CHICAGO,
    );
    expect(selected.id).toBe('c2');
    // Callers rely on the flag to know this is not a live run.
    expect(selected.cancelled).toBe(true);
  });

  it('a single-entry schedule trivially returns that entry in every state', () => {
    const only = [entry('only', '11:00', 0)];
    // 11:00 + 1h ends at 12:00 Chicago sharp.
    const before = new Date('2026-07-17T15:00:00Z'); // 10:00 Chicago — upcoming
    const during = new Date('2026-07-17T16:30:00Z'); // 11:30 Chicago — in progress
    const after = new Date('2026-07-17T18:00:00Z'); // 13:00 Chicago — completed

    for (const now of [before, during, after]) {
      expect(
        selectActiveScheduleEntry(only, TRIP_DURATION_SECONDS, now).id,
      ).toBe('only');
    }
  });
});
