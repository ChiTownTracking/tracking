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
): ScheduleEntry {
  return { id, arrivalTime, waitMinutes };
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
