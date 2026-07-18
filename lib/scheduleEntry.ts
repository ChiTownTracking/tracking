import { getTripStatus } from './scheduleStatus';
import type { ScheduleEntry } from './trips';

// Which of a vehicle's runs should live progress be attributed to right
// now? Preference order: the run currently in progress; else the next one
// coming up; else (everything today already done) the last run — the map
// still needs SOME run's wait time to reason about, and the most recent
// one is the least wrong.
//
// A run's "in progress" window includes its own pickup wait: the vehicle
// sitting at the first stop for waitMinutes IS part of the run, so the
// status duration is waitMinutes*60 + the trip's driving duration.
//
// A cancelled run is not a real run anymore (Phase L3): it can never be
// the in-progress or next-upcoming target no matter what the clock says
// about its window. It only surfaces through the very last fallback, when
// EVERY run is cancelled — callers still need an entry to display, and
// must check .cancelled before treating it as active.
//
// Assumes a non-empty schedule — a vehicle assignment always has at least
// one run at creation. (A post-replace emptied assignment exists, but its
// callers guard for length before calling.)
export function selectActiveScheduleEntry(
  schedule: ScheduleEntry[],
  tripDurationSeconds: number,
  now: Date,
): ScheduleEntry {
  // Zero-padded "HH:mm" sorts lexicographically === chronologically; never
  // assume the stored order.
  const ordered = [...schedule].sort((a, b) =>
    a.arrivalTime.localeCompare(b.arrivalTime),
  );
  const real = ordered.filter((entry) => !entry.cancelled);
  const statuses = real.map((entry) =>
    getTripStatus(
      entry.arrivalTime,
      entry.waitMinutes * 60 + tripDurationSeconds,
      now,
    ),
  );

  const inProgress = real.find(
    (_, index) => statuses[index] === 'in-progress',
  );
  if (inProgress) {
    return inProgress;
  }
  const upcoming = real.find((_, index) => statuses[index] === 'upcoming');
  if (upcoming) {
    return upcoming;
  }
  if (real.length > 0) {
    return real[real.length - 1];
  }
  return ordered[ordered.length - 1];
}
