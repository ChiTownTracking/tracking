import { detectedPickupClock } from './pickupDetection';
import { computeOccurrenceValidity } from './scheduleOccurrence';
import type { TripStatus } from './scheduleStatus';
import type { ScheduleEntry } from './trips';

// Phase N6: which of a vehicle's recurring runs actually count as a valid
// occurrence on a SPECIFIC calendar day (today = dateOffsetDays 0,
// tomorrow = 1), window-checked via computeOccurrenceValidity — replacing
// the old unconditional "every configured run, today's clock status"
// list. An occurrence outside the trip's active window (the reported bug:
// an early-morning time whose TODAY occurrence precedes a same-evening
// window opening) is dropped entirely for that day, not mislabeled.

export interface DailyScheduleItem {
  entry: ScheduleEntry;
  // 'cancelled' overrides whatever the clock status would otherwise be —
  // same convention the UI (ScheduleTimeline) already applies: "already
  // happened" and "never happening" must not read identically.
  status: TripStatus | 'cancelled';
  // Phase N7: when the vehicle was REALLY seen at the pickup on THIS
  // row's own day — replacing the buffered predicted destination-arrival
  // clock that used to sit here. A prediction and an observation are
  // different claims, and the schedule list now makes the one it can
  // actually stand behind.
  //
  // Present only when a detection exists for THIS row's occurrence date
  // (a today row checks today, a tomorrow row checks tomorrow — see
  // pickupDetection.detectedPickupClock); absent otherwise, so an
  // undetected row renders blank rather than falling back to any other
  // number.
  actualPickupClock?: string;
}

export function computeDailySchedule(
  schedule: ScheduleEntry[],
  dateOffsetDays: number,
  windowStart: string | undefined,
  windowEnd: string | undefined,
  tripDurationSeconds: number,
  now: Date,
): DailyScheduleItem[] {
  const items: DailyScheduleItem[] = [];

  for (const entry of schedule) {
    // Cancelled entries are INCLUDED when window-valid (staff and
    // customers both still need to see "this run was cancelled"); they're
    // just never candidates for live-selection purposes elsewhere
    // (lib/scheduleEntry.ts already excludes .cancelled entries there).
    const validity = computeOccurrenceValidity(
      entry,
      dateOffsetDays,
      windowStart,
      windowEnd,
      entry.waitMinutes * 60 + tripDurationSeconds,
      now,
    );
    if (!validity.withinWindow || validity.status === undefined) {
      continue;
    }

    // Scoped to the day THIS list is for: dateOffsetDays is the same one
    // the occurrence above was validated against, so a stamp from another
    // date is simply not this row's.
    const actualPickupClock = detectedPickupClock(entry, dateOffsetDays, now);

    items.push({
      entry,
      status: entry.cancelled ? 'cancelled' : validity.status,
      ...(actualPickupClock !== undefined ? { actualPickupClock } : {}),
    });
  }

  // Same "HH:mm sorts lexicographically === chronologically" convention as
  // everywhere else — safe here because every item in this array shares
  // the same dateOffsetDays.
  return items.sort((a, b) =>
    a.entry.arrivalTime.localeCompare(b.entry.arrivalTime),
  );
}
