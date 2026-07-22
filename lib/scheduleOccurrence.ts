import { getStatusForOccurrence, type TripStatus } from './scheduleStatus';
import type { ScheduleEntry } from './trips';

// Phase N6: turns a recurring "HH:mm" schedule entry into a CONCRETE
// occurrence — a specific calendar day's real instant — and checks that
// occurrence against the TRIP's own active window (lib/trackingWindow),
// not just raw time-of-day.
//
// This is the fix for the reported bug: a trip created the same evening,
// whose window opens that evening but whose daily schedule times are
// early-morning, was showing "Arrives at 9:00 AM" (today, already long
// past by the clock) instead of recognizing that TODAY's 7:30/8:00/8:30/
// 9:00 AM occurrences all preceded the window opening — they never
// really existed under this trip's link — and the real next occurrence
// is tomorrow morning. Plain getTripStatus, working in bare time-of-day,
// had no way to know that; window-aware validity does.

// Same Chicago-anchoring technique as scheduleStatus.ts and
// nextOccurrence.ts (Intl.DateTimeFormat with an explicit timeZone,
// hourCycle 'h23' so midnight reads "00", never local-timezone Date
// math) — a third copy of the same algorithm, not a third algorithm.
const chicagoClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function chicagoSecondsOfDay(now: Date): number {
  const parts = chicagoClock.formatToParts(now);
  const read = (type: 'hour' | 'minute' | 'second'): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return read('hour') * 3600 + read('minute') * 60 + read('second');
}

const DAY_SECONDS = 24 * 3600;

// The real instant of "HH:mm, dateOffsetDays days from today" (Chicago
// wall clock). dateOffsetDays: 0 = today's calendar occurrence (whether
// already past or not), 1 = tomorrow's — an EXPLICIT day, unlike
// nextOccurrenceOf's auto-picked "whichever hasn't happened yet."
//
// Implementation: shift `now` by the real-second delta between the
// target clock time and now's own clock time, then add whole days. This
// only ever adds a fixed offset relative to `now` (never re-deriving a
// fresh Chicago clock reading for the target day), so a DST transition
// falling inside the offset window could shift the result by up to an
// hour — the same accepted approximation nextOccurrenceOf already makes
// for the identical reason; trip schedules here span days to a week, not
// the twice-a-year transition itself.
export function computeOccurrenceTimestamp(
  arrivalTime: string,
  dateOffsetDays: number,
  now: Date,
): Date {
  const [hours, minutes] = arrivalTime.split(':').map(Number);
  const targetSeconds = hours * 3600 + minutes * 60;
  const nowSeconds = chicagoSecondsOfDay(now);
  return new Date(
    now.getTime() +
      (targetSeconds + dateOffsetDays * DAY_SECONDS - nowSeconds) * 1000,
  );
}

export interface OccurrenceValidity {
  // Whether this occurrence's DEPARTURE timestamp actually falls inside
  // the trip's active window. false means this occurrence doesn't count
  // for this date at all — never happened under this link, or not yet
  // reachable — same as if the entry didn't exist for that day.
  withinWindow: boolean;
  // Present only when withinWindow is true — no status for an occurrence
  // that doesn't count.
  status?: TripStatus;
}

// windowStart/windowEnd are the Trip's OWN optional fields (ISO strings,
// lib/trips.ts) — absent on a pre-N3 trip, meaning "always active," the
// same no-migration precedent used throughout the app. Absent here means
// NO window gating at all: every occurrence is valid and status alone
// decides — the exact pre-N6 behavior, preserved for legacy trips.
export function computeOccurrenceValidity(
  entry: ScheduleEntry,
  dateOffsetDays: number,
  windowStart: string | undefined,
  windowEnd: string | undefined,
  durationSeconds: number,
  now: Date,
): OccurrenceValidity {
  const arrivalTimestamp = computeOccurrenceTimestamp(
    entry.arrivalTime,
    dateOffsetDays,
    now,
  );

  if (windowStart === undefined || windowEnd === undefined) {
    return {
      withinWindow: true,
      status: getStatusForOccurrence(arrivalTimestamp, durationSeconds, now),
    };
  }

  // The window gates on DEPARTURE (arrival + this run's own wait), not
  // arrival — a pickup scheduled a moment before the window opens but
  // that doesn't actually leave until after it opens is still a
  // legitimate occurrence.
  const departureTimestamp = new Date(
    arrivalTimestamp.getTime() + entry.waitMinutes * 60_000,
  );
  const withinWindow =
    departureTimestamp.getTime() >= new Date(windowStart).getTime() &&
    departureTimestamp.getTime() <= new Date(windowEnd).getTime();

  if (!withinWindow) {
    return { withinWindow: false };
  }
  return {
    withinWindow: true,
    status: getStatusForOccurrence(arrivalTimestamp, durationSeconds, now),
  };
}

// A convenience combining computeOccurrenceTimestamp + getStatusForOccurrence
// for callers that already know their occurrence is window-valid (e.g. it
// survived computeDailySchedule's filtering) and just need the day-aware
// clock status — dateOffsetDays 0 is algebraically identical to the older
// day-hardwired getTripStatus (lib/scheduleStatus.ts), generalized to any
// day.
export function getOccurrenceStatus(
  arrivalTime: string,
  dateOffsetDays: number,
  durationSeconds: number,
  now: Date,
): TripStatus {
  return getStatusForOccurrence(
    computeOccurrenceTimestamp(arrivalTime, dateOffsetDays, now),
    durationSeconds,
    now,
  );
}
