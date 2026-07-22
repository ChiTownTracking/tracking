import {
  computeDepartureClock,
  computePredictedArrivalClock,
} from './departureTime';
import { computeOccurrenceValidity } from './scheduleOccurrence';
import type { TripStatus } from './scheduleStatus';
import { BUS_DURATION_BUFFER } from './tripEstimateConfig';
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
  // A single buffered predicted-arrival clock, present only when the
  // entry carries a stored raw prediction (Phase K1) and isn't cancelled
  // — a lighter sibling of tripDetail's own early/late RANGE, which
  // independently reformats the same raw fields for the public API.
  predictedArrivalClock?: string;
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

    const departureClock = computeDepartureClock(
      entry.arrivalTime,
      entry.waitMinutes,
    );
    // No prediction for a cancelled run — there's nothing to predict for
    // a run that isn't happening (same rule tripDetail.ts's own
    // predictedArrivalRange already follows).
    const predictedArrivalClock =
      !entry.cancelled && entry.predictedArrivalDurationSeconds !== undefined
        ? computePredictedArrivalClock(
            departureClock,
            Math.round(
              entry.predictedArrivalDurationSeconds * BUS_DURATION_BUFFER,
            ),
          )
        : undefined;

    items.push({
      entry,
      status: entry.cancelled ? 'cancelled' : validity.status,
      ...(predictedArrivalClock !== undefined ? { predictedArrivalClock } : {}),
    });
  }

  // Same "HH:mm sorts lexicographically === chronologically" convention as
  // everywhere else — safe here because every item in this array shares
  // the same dateOffsetDays.
  return items.sort((a, b) =>
    a.entry.arrivalTime.localeCompare(b.entry.arrivalTime),
  );
}
