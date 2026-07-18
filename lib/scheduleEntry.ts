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
// Assumes a non-empty schedule — a vehicle assignment always has at least
// one run, enforced at the API layer, not here.
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
  const statuses = ordered.map((entry) =>
    getTripStatus(
      entry.arrivalTime,
      entry.waitMinutes * 60 + tripDurationSeconds,
      now,
    ),
  );

  const inProgress = ordered.find(
    (_, index) => statuses[index] === 'in-progress',
  );
  if (inProgress) {
    return inProgress;
  }
  const upcoming = ordered.find((_, index) => statuses[index] === 'upcoming');
  if (upcoming) {
    return upcoming;
  }
  return ordered[ordered.length - 1];
}
