import {
  computeOccurrenceTimestamp,
  computeOccurrenceValidity,
  getOccurrenceStatus,
} from './scheduleOccurrence';
import type { TripStatus } from './scheduleStatus';
import type { ScheduleEntry } from './trips';

// Which of a vehicle's runs should live progress be attributed to right
// now, and which one should the customer card headline? Preference order:
// the run currently in progress; else the chronologically-EARLIEST
// upcoming occurrence, searched across TODAY and TOMORROW (Phase N6 —
// previously this only ever looked at today, which is what produced the
// reported bug: a same-evening trip's early-morning times all read as
// "completed" today, with no notion that their real next occurrence was
// tomorrow); else the last entry with a valid occurrence in either day —
// the map still needs SOME run's wait time to reason about, and the most
// recently finished one is the least wrong.
//
// A run's "in progress"/"upcoming" window includes its own pickup wait:
// the vehicle sitting at the first stop for waitMinutes IS part of the
// run, so the status duration passed to computeOccurrenceValidity is
// waitMinutes*60 + the trip's driving duration.
//
// windowStart/windowEnd are the TRIP's own optional active-window fields
// (lib/trips.ts) — every occurrence is checked against them via
// computeOccurrenceValidity, so a candidate that falls outside the
// window (before it opens, or after it closes) is never even considered,
// regardless of what the bare clock would say. Absent window (a legacy
// trip) means no gating at all — the pre-N3/N6 behavior, unchanged.
//
// A cancelled run is not a real run (Phase L3): it can never be a
// candidate at all, in either day. It only surfaces through the very
// last resort, when NOTHING real has any valid occurrence anywhere —
// callers still need an entry to display, and must check .cancelled
// before treating it as active.
//
// Assumes a non-empty schedule — a vehicle assignment always has at least
// one run at creation. (A post-replace emptied assignment exists, but its
// callers guard for length before calling.)
export interface ActiveScheduleSelection {
  entry: ScheduleEntry;
  // Which calendar day the winning entry's occurrence belongs to: 0 =
  // today, 1 = tomorrow. Replaces the old occursToday boolean with this
  // more general value. For the last-resort fallbacks (today's real runs
  // are all done, or nothing real is valid at all) this is explicitly 1 —
  // the entry's genuine NEXT occurrence is tomorrow, even when the run
  // object being anchored on (for dwell attribution) is today's
  // already-finished one.
  dateOffsetDays: number;
}

interface Candidate {
  entry: ScheduleEntry;
  dateOffsetDays: number;
  status: TripStatus;
  timestampMs: number;
}

export function selectActiveScheduleEntry(
  schedule: ScheduleEntry[],
  tripDurationSeconds: number,
  windowStart: string | undefined,
  windowEnd: string | undefined,
  now: Date,
): ActiveScheduleSelection {
  // Zero-padded "HH:mm" sorts lexicographically === chronologically; never
  // assume the stored order.
  const ordered = [...schedule].sort((a, b) =>
    a.arrivalTime.localeCompare(b.arrivalTime),
  );
  const real = ordered.filter((entry) => !entry.cancelled);

  // Every real entry's occurrence on BOTH today and tomorrow, window-
  // checked — an occurrence outside the window (the reported bug) simply
  // never becomes a candidate.
  const candidates: Candidate[] = [];
  for (const dateOffsetDays of [0, 1]) {
    for (const entry of real) {
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
      candidates.push({
        entry,
        dateOffsetDays,
        status: validity.status,
        timestampMs: computeOccurrenceTimestamp(
          entry.arrivalTime,
          dateOffsetDays,
          now,
        ).getTime(),
      });
    }
  }

  const inProgress = candidates.find((c) => c.status === 'in-progress');
  if (inProgress) {
    return {
      entry: inProgress.entry,
      dateOffsetDays: inProgress.dateOffsetDays,
    };
  }

  // Tomorrow's occurrence timestamp is always strictly later than `now`
  // (by construction — see computeOccurrenceTimestamp), so it can never be
  // 'in-progress' or 'completed', only 'upcoming'. This branch is
  // therefore where a same-day-exhausted schedule finds its REAL next
  // occurrence, not an arbitrary stand-in.
  const upcoming = candidates.filter((c) => c.status === 'upcoming');
  if (upcoming.length > 0) {
    const earliest = upcoming.reduce((min, c) =>
      c.timestampMs < min.timestampMs ? c : min,
    );
    return { entry: earliest.entry, dateOffsetDays: earliest.dateOffsetDays };
  }

  // Nothing in-progress or upcoming anywhere: whatever candidates remain
  // are 'completed'. Per the note above, that can only be a TODAY
  // occurrence (tomorrow's is never completed), so this is exactly the
  // old "everything today is done" fallback — now correctly reached only
  // when tomorrow's occurrence ALSO has no valid candidate (e.g. the
  // window itself excludes it). The chronologically LAST completed one is
  // the least-wrong dwell-attribution anchor; the date label is
  // unconditionally tomorrow, since that's this entry's real next
  // occurrence regardless of which already-finished run we anchored on.
  if (candidates.length > 0) {
    const last = candidates.reduce((max, c) =>
      c.timestampMs > max.timestampMs ? c : max,
    );
    return { entry: last.entry, dateOffsetDays: 1 };
  }

  // Truly nothing real and valid anywhere — every run cancelled, or every
  // real run's occurrence falls outside the window in both directions.
  // Last resort: the last entry overall, tomorrow, as a pure display
  // anchor with no real occurrence behind it.
  return { entry: ordered[ordered.length - 1], dateOffsetDays: 1 };
}

// The CLIENT's counterpart, for components that already receive schedule
// data PRE-SPLIT and PRE-FILTERED by day (the public API's `schedule` for
// today and `tomorrowSchedule` for tomorrow, lib/tripDetail.ts) — no
// window check needed again here, since only window-valid entries ever
// made it into either array. Same priority order (in-progress, else
// earliest upcoming across both pools, else the last completed one,
// tomorrow, else the last entry at all including cancelled ones,
// tomorrow) as selectActiveScheduleEntry, just fed two ready-made pools
// instead of deriving both offsets from one raw list + a window. Generic
// so callers (e.g. TripStatusCard's richer TripCardScheduleEntry) get
// their own entry type back, matching selectActiveScheduleEntry's own
// "returns an element of the array it was given" behavior.
export function selectActiveFromDailyPools<
  T extends { arrivalTime: string; waitMinutes: number; cancelled?: boolean },
>(
  today: T[],
  tomorrow: T[],
  tripDurationSeconds: number,
  now: Date,
): { entry: T; dateOffsetDays: number } | null {
  interface PoolCandidate {
    entry: T;
    dateOffsetDays: number;
    timestampMs: number;
  }
  const pools: { entries: T[]; dateOffsetDays: number }[] = [
    { entries: today, dateOffsetDays: 0 },
    { entries: tomorrow, dateOffsetDays: 1 },
  ];

  const all: PoolCandidate[] = [];
  const real: (PoolCandidate & { status: TripStatus })[] = [];
  for (const { entries, dateOffsetDays } of pools) {
    for (const entry of entries) {
      const timestampMs = computeOccurrenceTimestamp(
        entry.arrivalTime,
        dateOffsetDays,
        now,
      ).getTime();
      all.push({ entry, dateOffsetDays, timestampMs });
      if (entry.cancelled) {
        continue;
      }
      real.push({
        entry,
        dateOffsetDays,
        timestampMs,
        status: getOccurrenceStatus(
          entry.arrivalTime,
          dateOffsetDays,
          entry.waitMinutes * 60 + tripDurationSeconds,
          now,
        ),
      });
    }
  }

  const inProgress = real.find((c) => c.status === 'in-progress');
  if (inProgress) {
    return { entry: inProgress.entry, dateOffsetDays: inProgress.dateOffsetDays };
  }
  const upcoming = real.filter((c) => c.status === 'upcoming');
  if (upcoming.length > 0) {
    const earliest = upcoming.reduce((min, c) =>
      c.timestampMs < min.timestampMs ? c : min,
    );
    return { entry: earliest.entry, dateOffsetDays: earliest.dateOffsetDays };
  }
  if (real.length > 0) {
    const last = real.reduce((max, c) =>
      c.timestampMs > max.timestampMs ? c : max,
    );
    return { entry: last.entry, dateOffsetDays: 1 };
  }
  // Every entry in both pools is cancelled — same last-resort spirit as
  // selectActiveScheduleEntry's own all-cancelled case: still anchor on
  // SOMETHING (the caller needs .cancelled to render the right message)
  // rather than returning null.
  if (all.length > 0) {
    const last = all.reduce((max, c) =>
      c.timestampMs > max.timestampMs ? c : max,
    );
    return { entry: last.entry, dateOffsetDays: 1 };
  }
  // Genuinely nothing in either pool at all.
  return null;
}
