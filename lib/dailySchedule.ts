import { chicagoDateLabel } from './chicagoDate';
import { detectedPickupClock } from './pickupDetection';
import {
  computeOccurrenceTimestamp,
  computeOccurrenceValidity,
  getOccurrenceStatus,
} from './scheduleOccurrence';
import type { TripStatus } from './scheduleStatus';
import type { ScheduleEntry } from './trips';
import { IN_PROGRESS_ABSOLUTE_GRACE_MINUTES } from './tripEstimateConfig';

// Phase N6: which of a vehicle's recurring runs actually count as a valid
// occurrence on a SPECIFIC calendar day (today = dateOffsetDays 0,
// tomorrow = 1), window-checked via computeOccurrenceValidity — replacing
// the old unconditional "every configured run, today's clock status"
// list. An occurrence outside the trip's active window (the reported bug:
// an early-morning time whose TODAY occurrence precedes a same-evening
// window opening) is dropped entirely for that day, not mislabeled.

// Phase P: what a schedule row should SAY, given both the stored
// lifecycle facts and the clock.
//
// "In progress" used to be pure clock arithmetic: once the wall clock
// entered a run's window the row claimed the run was underway, whether or
// not any vehicle had actually moved. That is the reported bug — a row
// announcing a run in progress while the bus sat un-departed at the kerb.
// It now means an OBSERVED departure, and nothing else.
//
// The order matters: a real fact always beats the clock, and the newest
// real fact wins over the older one.
//   dropoff recorded today  → completed
//   pickup recorded today   → in-progress (bounded above by the ceiling
//                             below)
//   neither                 → ask the clock, but only to answer one
//                             question: is this run's whole window behind
//                             us? If so it's completed (the dark-vehicle
//                             case — the day ended and nothing was ever
//                             observed, so "upcoming" would be a lie).
//                             Anything else is upcoming, INCLUDING what
//                             the clock alone would have called
//                             in-progress. That downgrade is the actual
//                             behavior change here.
//
// Phase Q moved the in-progress trigger from the DEPARTURE stamp to the
// pickup stamp: a bus boarding passengers at the kerb is plainly under
// way, and waiting for it to physically pull out before the row read "in
// progress" left an obviously-live run looking like it hadn't started.
//
// It also required the scheduled instant to have arrived, so that an
// early-detected pickup sat at 'upcoming' until the clock caught up.
// That gate is now GONE, and the trigger is the pickup stamp alone. The
// detection itself is already the tightly-bounded event — a vehicle
// inside the pickup geofence within a few minutes either side of the
// scheduled arrival (lib/pickupDetectionConfig.ts) — so by the time a
// stamp exists at all, the run has demonstrably begun. Holding the row
// at 'upcoming' for the last couple of minutes only made the display lag
// a fact it already had; the geofence windows, not this function, are
// where "too early to count" gets decided.
//
// Departure is deliberately NOT consulted here anymore. It still answers
// its own, finer question — has the vehicle physically left the stop —
// which drives the map marker (lib/tripDetail.resolveRunProgress) and the
// card's live dot. Two different questions, two different signals.
//
// getOccurrenceStatus (the day-aware wrapper over getStatusForOccurrence)
// is reused untouched for that fallback — no second copy of the clock
// rules, and every other caller of it is unaffected.
//
// Date-scoped like every other stamp read: a "tomorrow" row asks for
// tomorrow's label, which today's facts can never match, so future rows
// fall through to the clock path exactly as they always did.
//
// Phase R adds the absolute ceiling. Detection can fail to record a
// departure or a drop-off for perfectly ordinary reasons — the tracker
// goes dark, the bus stops short of the pin, nobody loads the page while
// the fallback window is open — and until now every one of those left a
// picked-up run reading "In progress" indefinitely. So there is a hard
// upper bound: the scheduled instant, plus this trip's own travel
// duration, plus IN_PROGRESS_ABSOLUTE_GRACE_MINUTES. Past that point the
// row reads 'completed' whether or not anything was ever recorded, and
// 'in-progress' is structurally unreachable.
//
// It is a DISPLAY guarantee, not a fact: detectDeparture and
// detectDropoffCompletion are untouched and still record what genuinely
// happened whenever they can — which is why a real recorded drop-off is
// still checked first and wins outright. The ceiling only ever answers
// for the runs those detectors could not answer for.
//
// The ceiling sits inside the picked-up branch because that is the only
// branch it needs to bound: a run with no pickup can never be
// 'in-progress' at all (see the fallback below), so applying the ceiling
// to it would not prevent anything — it would only declare an
// unobserved run finished EARLIER than its own window ends, which is a
// claim this function has no grounds to make.
export function resolveDisplayStatus(
  entry: ScheduleEntry,
  dateOffsetDays: number,
  durationSeconds: number,
  // The trip's static travel duration — the very same trip.
  // totalDurationSeconds the drop-off fallback measures against
  // (lib/pickupDetection.detectDropoffCompletion), passed in rather than
  // recovered from durationSeconds above, which callers have already
  // added each entry's own pickup wait into.
  staticTravelDurationSeconds: number,
  now: Date,
): TripStatus {
  const dateLabel = chicagoDateLabel(now, dateOffsetDays);

  if (entry.actualDropoffDate === dateLabel) {
    return 'completed';
  }
  if (entry.actualPickupDate === dateLabel) {
    const occurrenceMs = computeOccurrenceTimestamp(
      entry.arrivalTime,
      dateOffsetDays,
      now,
    ).getTime();
    const absoluteCeilingMs =
      occurrenceMs +
      IN_PROGRESS_ABSOLUTE_GRACE_MINUTES * 60_000 +
      staticTravelDurationSeconds * 1000;

    if (now.getTime() >= absoluteCeilingMs) {
      return 'completed';
    }
    return 'in-progress';
  }

  const byClock = getOccurrenceStatus(
    entry.arrivalTime,
    dateOffsetDays,
    durationSeconds,
    now,
  );
  return byClock === 'completed' ? 'completed' : 'upcoming';
}

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
      // Phase P: the fact-aware status, not the bare clock one that
      // computeOccurrenceValidity returned for the window check above.
      // (That check still asks the pure clock question it always did:
      // does this occurrence fall inside the trip's active window.)
      status: entry.cancelled
        ? 'cancelled'
        : resolveDisplayStatus(
            entry,
            dateOffsetDays,
            entry.waitMinutes * 60 + tripDurationSeconds,
            tripDurationSeconds,
            now,
          ),
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
