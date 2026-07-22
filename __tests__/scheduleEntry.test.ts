import { describe, expect, it } from 'vitest';
import { selectActiveScheduleEntry } from '@/lib/scheduleEntry';
import type { ScheduleEntry } from '@/lib/trips';

// July 2026: America/Chicago is CDT (UTC-5), so 17:00Z is noon Chicago —
// the same explicit-timezone reasoning getTripStatus itself is tested with.
const NOON_CHICAGO = new Date('2026-07-17T17:00:00Z');
const TRIP_DURATION_SECONDS = 3600;
// No trip-level window in most of these cases — the legacy/no-gating
// path, so every occurrence (today AND tomorrow) is a valid candidate.
const NO_WINDOW = undefined;

function entry(
  id: string,
  arrivalTime: string,
  waitMinutes = 10,
  cancelled = false,
): ScheduleEntry {
  return { id, arrivalTime, waitMinutes, ...(cancelled ? { cancelled } : {}) };
}

describe('selectActiveScheduleEntry', () => {
  it('an in-progress run wins even when later upcoming runs exist (today)', () => {
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
      NO_WINDOW,
      NO_WINDOW,
      NOON_CHICAGO,
    );
    expect(selected.entry.id).toBe('midday');
    // An in-progress run can only ever be today's — tomorrow's occurrence
    // is mathematically always still ahead of `now`.
    expect(selected.dateOffsetDays).toBe(0);
  });

  it('the EARLIEST upcoming run wins when nothing is in progress, regardless of stored order (today beats any tomorrow candidate)', () => {
    // Deliberately unsorted: 15:00 listed before 13:00.
    const schedule = [
      entry('later', '15:00'),
      entry('sooner', '13:00'),
      entry('done', '09:00'),
    ];

    const selected = selectActiveScheduleEntry(
      schedule,
      TRIP_DURATION_SECONDS,
      NO_WINDOW,
      NO_WINDOW,
      NOON_CHICAGO,
    );
    // 'sooner' (today 13:00) beats every tomorrow candidate too — ANY
    // today timestamp precedes ANY tomorrow timestamp.
    expect(selected.entry.id).toBe('sooner');
    expect(selected.dateOffsetDays).toBe(0);
  });

  // Phase N6: once today is exhausted, the REAL next occurrence is
  // tomorrow's EARLIEST run — not an arbitrary "last entry of today"
  // stand-in (the old, cruder fallback this replaces).
  it("once everything today is completed, the EARLIEST run tomorrow wins — not merely today's last entry", () => {
    // Both ended well before noon. Unsorted on purpose.
    const schedule = [entry('second', '08:30'), entry('first', '07:00')];

    const selected = selectActiveScheduleEntry(
      schedule,
      TRIP_DURATION_SECONDS,
      NO_WINDOW,
      NO_WINDOW,
      NOON_CHICAGO,
    );
    // 'first' (07:00) is the earliest tomorrow, genuinely next — not
    // 'second' (08:30), which the old today-only algorithm picked purely
    // because it sorted last.
    expect(selected.entry.id).toBe('first');
    expect(selected.dateOffsetDays).toBe(1);
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
      NO_WINDOW,
      NO_WINDOW,
      NOON_CHICAGO,
    );
    expect(selected.entry.id).toBe('afternoon');
    expect(selected.dateOffsetDays).toBe(0);
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
      NO_WINDOW,
      NO_WINDOW,
      NOON_CHICAGO,
    );
    expect(selected.entry.id).toBe('real-later');
    expect(selected.dateOffsetDays).toBe(0);
  });

  it('a cancelled entry can never win the all-done fallback either, even sorting last', () => {
    // Both real runs completed today; the 16:00 cancellation must not
    // become the anchor just because it sorts last — it isn't even a
    // candidate. The genuinely-next occurrence is 'first' tomorrow 07:00.
    const schedule = [
      entry('first', '07:00'),
      entry('second', '08:30'),
      entry('cancelled-later', '16:00', 10, true),
    ];

    const selected = selectActiveScheduleEntry(
      schedule,
      TRIP_DURATION_SECONDS,
      NO_WINDOW,
      NO_WINDOW,
      new Date('2026-07-17T23:30:00Z'), // 18:30 Chicago — 16:00 window over too
    );
    expect(selected.entry.id).toBe('first');
    expect(selected.dateOffsetDays).toBe(1);
  });

  it('when EVERY run is cancelled, the last one is returned as a display anchor, flag intact (tomorrow)', () => {
    const schedule = [
      entry('c1', '09:00', 10, true),
      entry('c2', '14:00', 0, true),
    ];

    const selected = selectActiveScheduleEntry(
      schedule,
      TRIP_DURATION_SECONDS,
      NO_WINDOW,
      NO_WINDOW,
      NOON_CHICAGO,
    );
    expect(selected.entry.id).toBe('c2');
    // Callers rely on the flag to know this is not a live run.
    expect(selected.entry.cancelled).toBe(true);
    // Nothing real remains at all — the pure last-resort anchor.
    expect(selected.dateOffsetDays).toBe(1);
  });

  it('a single-entry schedule trivially returns that entry, dateOffsetDays matching its actual state', () => {
    const only = [entry('only', '11:00', 0)];
    // 11:00 + 1h ends at 12:00 Chicago sharp.
    const before = new Date('2026-07-17T15:00:00Z'); // 10:00 Chicago — upcoming
    const during = new Date('2026-07-17T16:30:00Z'); // 11:30 Chicago — in progress
    const after = new Date('2026-07-17T18:00:00Z'); // 13:00 Chicago — completed

    // Upcoming and in-progress are today's; the completed one falls
    // through to the tomorrow fallback (the SAME single entry object
    // either way, since there's only one to pick from).
    const upcoming = selectActiveScheduleEntry(
      only,
      TRIP_DURATION_SECONDS,
      NO_WINDOW,
      NO_WINDOW,
      before,
    );
    expect(upcoming.entry.id).toBe('only');
    expect(upcoming.dateOffsetDays).toBe(0);

    const inProgress = selectActiveScheduleEntry(
      only,
      TRIP_DURATION_SECONDS,
      NO_WINDOW,
      NO_WINDOW,
      during,
    );
    expect(inProgress.entry.id).toBe('only');
    expect(inProgress.dateOffsetDays).toBe(0);

    const completed = selectActiveScheduleEntry(
      only,
      TRIP_DURATION_SECONDS,
      NO_WINDOW,
      NO_WINDOW,
      after,
    );
    expect(completed.entry.id).toBe('only');
    expect(completed.dateOffsetDays).toBe(1);
  });

  // The reported bug's headline regression, at the selection level: a
  // trip whose window opens the same evening it's created, with an
  // early-morning daily schedule. TODAY's occurrences of every entry
  // precede the window opening; the real next occurrence is tomorrow's
  // EARLIEST run (07:30), not 9:00 AM (today's LAST entry, what the old
  // unwindowed algorithm wrongly anchored on).
  it('REGRESSION: a same-evening window with early-morning times selects the earliest run TOMORROW, not the last one today', () => {
    const schedule: ScheduleEntry[] = [
      { id: 'run-0730', arrivalTime: '07:30', waitMinutes: 0 },
      { id: 'run-0800', arrivalTime: '08:00', waitMinutes: 0 },
      { id: 'run-0830', arrivalTime: '08:30', waitMinutes: 0 },
      { id: 'run-0900', arrivalTime: '09:00', waitMinutes: 0 },
    ];

    const windowStart = '2026-07-23T00:06:00.000Z'; // Jul 22, 7:06 PM Chicago
    const windowEnd = '2026-07-30T00:06:00.000Z';
    const now = new Date('2026-07-23T00:30:00.000Z'); // Jul 22, 7:30 PM Chicago

    const selected = selectActiveScheduleEntry(
      schedule,
      1800,
      windowStart,
      windowEnd,
      now,
    );

    expect(selected.entry.id).toBe('run-0730');
    expect(selected.dateOffsetDays).toBe(1);
  });
});
