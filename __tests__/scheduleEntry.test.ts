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
  it('an in-progress run wins even when later upcoming runs exist (occursToday)', () => {
    // 11:30 + 10min wait + 1h drive runs until 12:40 Chicago — in progress
    // at noon. 09:00 ended 10:10 (completed); 14:00 is upcoming.
    const schedule = [
      entry('morning', '09:00'),
      entry('midday', '11:30'),
      entry('afternoon', '14:00'),
    ];

    const selected = selectActiveScheduleEntry(
      schedule,
      TRIP_DURATION_SECONDS,
      NOON_CHICAGO,
    );
    expect(selected.entry.id).toBe('midday');
    // A run happening right now is, by definition, today's.
    expect(selected.occursToday).toBe(true);
  });

  it('the EARLIEST upcoming run wins when nothing is in progress, regardless of stored order (occursToday)', () => {
    // Deliberately unsorted: 15:00 listed before 13:00.
    const schedule = [
      entry('later', '15:00'),
      entry('sooner', '13:00'),
      entry('done', '09:00'),
    ];

    const selected = selectActiveScheduleEntry(
      schedule,
      TRIP_DURATION_SECONDS,
      NOON_CHICAGO,
    );
    expect(selected.entry.id).toBe('sooner');
    // Still coming up today.
    expect(selected.occursToday).toBe(true);
  });

  it('the last run wins when everything today is already completed (NOT today)', () => {
    // Both ended well before noon; the latest one is the least-wrong
    // attribution target. Unsorted on purpose.
    const schedule = [entry('second', '08:30'), entry('first', '07:00')];

    const selected = selectActiveScheduleEntry(
      schedule,
      TRIP_DURATION_SECONDS,
      NOON_CHICAGO,
    );
    expect(selected.entry.id).toBe('second');
    // The fallback: today's runs are done, so the next real occurrence is
    // tomorrow.
    expect(selected.occursToday).toBe(false);
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

    const selected = selectActiveScheduleEntry(
      schedule,
      TRIP_DURATION_SECONDS,
      NOON_CHICAGO,
    );
    expect(selected.entry.id).toBe('afternoon');
    expect(selected.occursToday).toBe(true);
  });

  it('a cancelled run is skipped for next-upcoming in favor of a later real run', () => {
    // Nothing in progress; 13:00 is the sooner upcoming but cancelled.
    const schedule = [
      entry('cancelled-sooner', '13:00', 10, true),
      entry('real-later', '15:00'),
    ];

    const selected = selectActiveScheduleEntry(
      schedule,
      TRIP_DURATION_SECONDS,
      NOON_CHICAGO,
    );
    expect(selected.entry.id).toBe('real-later');
    expect(selected.occursToday).toBe(true);
  });

  it('the all-done fallback prefers the last REAL run over a later cancelled one (NOT today)', () => {
    // Both real runs completed; the 16:00 cancellation must not become the
    // dwell-attribution target just because it sorts last.
    const schedule = [
      entry('first', '07:00'),
      entry('second', '08:30'),
      entry('cancelled-later', '16:00', 10, true),
    ];

    const selected = selectActiveScheduleEntry(
      schedule,
      TRIP_DURATION_SECONDS,
      new Date('2026-07-17T23:30:00Z'), // 18:30 Chicago — 16:00 window over too
    );
    expect(selected.entry.id).toBe('second');
    expect(selected.occursToday).toBe(false);
  });

  it('when EVERY run is cancelled, the last one is returned as a display anchor, flag intact (NOT today)', () => {
    const schedule = [
      entry('c1', '09:00', 10, true),
      entry('c2', '14:00', 0, true),
    ];

    const selected = selectActiveScheduleEntry(
      schedule,
      TRIP_DURATION_SECONDS,
      NOON_CHICAGO,
    );
    expect(selected.entry.id).toBe('c2');
    // Callers rely on the flag to know this is not a live run.
    expect(selected.entry.cancelled).toBe(true);
    // Nothing real remains today.
    expect(selected.occursToday).toBe(false);
  });

  it('a single-entry schedule trivially returns that entry, occursToday matching its actual state', () => {
    const only = [entry('only', '11:00', 0)];
    // 11:00 + 1h ends at 12:00 Chicago sharp.
    const before = new Date('2026-07-17T15:00:00Z'); // 10:00 Chicago — upcoming
    const during = new Date('2026-07-17T16:30:00Z'); // 11:30 Chicago — in progress
    const after = new Date('2026-07-17T18:00:00Z'); // 13:00 Chicago — completed

    // Upcoming and in-progress are today's; the completed one falls through
    // to the last-run fallback, so its next occurrence is tomorrow.
    const upcoming = selectActiveScheduleEntry(only, TRIP_DURATION_SECONDS, before);
    expect(upcoming.entry.id).toBe('only');
    expect(upcoming.occursToday).toBe(true);

    const inProgress = selectActiveScheduleEntry(only, TRIP_DURATION_SECONDS, during);
    expect(inProgress.entry.id).toBe('only');
    expect(inProgress.occursToday).toBe(true);

    const completed = selectActiveScheduleEntry(only, TRIP_DURATION_SECONDS, after);
    expect(completed.entry.id).toBe('only');
    expect(completed.occursToday).toBe(false);
  });
});
