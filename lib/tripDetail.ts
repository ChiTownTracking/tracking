import { formatClock12Hour } from './clockFormat';
import { computeDailySchedule } from './dailySchedule';
import {
  computeDepartureClock,
  computePredictedArrivalRange,
} from './departureTime';
import { summarizeLiveProgress } from './liveProgress';
import { getLiveVehicles } from './liveVehicles';
import { getOccurrenceStatus } from './scheduleOccurrence';
import { selectActiveScheduleEntry } from './scheduleEntry';
import type { TripStatus } from './scheduleStatus';
import type { ScheduleEntry, Trip } from './trips';
import { getVehicleRoster } from './vehicleRoster';

// Phase I1: the public trip detail, multi-vehicle. Every assigned vehicle
// comes back with its own independent live progress (attributed to its
// currently-active run via selectActiveScheduleEntry) AND its full run
// schedule with per-run Completed/In Progress/Upcoming statuses — the
// status labels are pure clock math, independent of live position.

// Phase N5: the active run's calendar date, Chicago-anchored like every
// other date/time computation in this app ("Fri, Jul 17").
const runDateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

// Reads a Date's Chicago calendar Y/M/D — the basis for advancing to
// "tomorrow" without local-timezone Date math.
const chicagoYmd = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Phase N6: generalized from a today/tomorrow boolean to an explicit
// dateOffsetDays (0 = today, 1 = tomorrow, matching
// lib/scheduleEntry.ts's ActiveScheduleSelection).
function formatActiveRunDate(now: Date, dateOffsetDays: number): string {
  if (dateOffsetDays === 0) {
    return runDateFormat.format(now);
  }
  // Advance the Chicago calendar date by dateOffsetDays and re-anchor at
  // UTC noon — well clear of the 2 AM DST switch, and Date normalizes any
  // month/year rollover — so a DST boundary can never mis-date it.
  const parts = chicagoYmd.formatToParts(now);
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const shifted = new Date(
    Date.UTC(read('year'), read('month') - 1, read('day') + dateOffsetDays, 12),
  );
  return runDateFormat.format(shifted);
}

// The rich per-entry public shape (id/arrivalTime/waitMinutes/status/
// cancelled?/departureClock/predictedArrivalRange), day-aware: dateOffsetDays
// 0 for the existing today `schedule` field, 1 for the new
// `tomorrowSchedule` field — both otherwise identical formatting.
function buildScheduleEntryDetail(
  entry: ScheduleEntry,
  dateOffsetDays: number,
  tripDurationSeconds: number,
  now: Date,
): SchedulePublicEntry {
  const departureClock = computeDepartureClock(
    entry.arrivalTime,
    entry.waitMinutes,
  );
  return {
    id: entry.id,
    arrivalTime: entry.arrivalTime,
    waitMinutes: entry.waitMinutes,
    status: getOccurrenceStatus(
      entry.arrivalTime,
      dateOffsetDays,
      entry.waitMinutes * 60 + tripDurationSeconds,
      now,
    ),
    departureClock,
    ...(entry.cancelled ? { cancelled: true } : {}),
    // A cancelled run gets no prediction even when one was stored at
    // booking — there is nothing to predict for a run that isn't
    // happening.
    predictedArrivalRange:
      !entry.cancelled &&
      entry.predictedArrivalDurationSeconds !== undefined &&
      entry.predictedArrivalStaticDurationSeconds !== undefined
        ? (() => {
            const range = computePredictedArrivalRange(
              departureClock,
              entry.predictedArrivalDurationSeconds,
              entry.predictedArrivalStaticDurationSeconds,
            );
            return {
              early: formatClock12Hour(range.early),
              late: formatClock12Hour(range.late),
            };
          })()
        : null,
  };
}

export interface TripVehicleDetail {
  vehicleId: string;
  // From the normalized roster (registrationNumber/description, same fields
  // as the staff Trips table) — never a raw Quartix field.
  vehicleLabel: string;
  // All the live fields null together when the vehicle has no live data:
  // the vehicle still appears, with its static schedule intact below.
  position: { lat: number; lng: number; headingDegrees: number | null } | null;
  positionConfident: boolean | null;
  // When the live position was last reported (Phase K2, for the card's
  // "Updated Xm ago" freshness label) — null together with position.
  positionUpdatedAt: string | null;
  speedMph: number | null;
  nextStopIndex: number | null;
  stopEtas: { arrival: string | null; departure: string | null }[] | null;
  // Phase L3: the assignment's staff-written service note ("bus broke
  // down, swapped to spare") — present only when set, omitted when absent,
  // same convention as every optional field.
  serviceNote?: string;
  // Phase N4: optional customer-facing card prefix ("Route A"), shown
  // before the vehicle number on the card — present only when set, omitted
  // when absent (same convention as serviceNote).
  cardLabel?: string;
  // Phase N5: the active run's real calendar date, Chicago-anchored and
  // preformatted ("Fri, Jul 17") — today when the run is happening/next
  // today, tomorrow when the fallback anchored on an already-finished run.
  // Present whenever there's an active entry to anchor it to; omitted only
  // for a fully-emptied assignment (nothing scheduled at all).
  activeRunDateLabel?: string;
  // EVERY run whose occurrence is valid TODAY (Phase N6: window-checked —
  // an occurrence outside the trip's active window, e.g. one that would
  // have happened before the window even opened, is simply not in this
  // list at all, not mislabeled). Can be EMPTY — that's a real, correct
  // outcome, not a bug.
  schedule: SchedulePublicEntry[];
  // Phase N6: the SAME entries and window, one calendar day ahead — every
  // run whose occurrence is valid TOMORROW. Lets the public page show
  // what's coming up next even on a day where nothing (or nothing more)
  // is left today.
  tomorrowSchedule: SchedulePublicEntry[];
}

interface SchedulePublicEntry {
  id: string;
  arrivalTime: string;
  waitMinutes: number;
  // Clock math only — a cancelled entry still carries its clock status;
  // displays check `cancelled` first.
  status: TripStatus;
  // Phase L3: present (true) only when staff cancelled this run —
  // omitted entirely otherwise, mirroring storage.
  cancelled?: boolean;
  // "HH:mm" — arrival + wait, the run's actual departure (Phase K2:
  // exposed per entry, no longer an internal-only computation).
  departureClock: string;
  // Display-ready 12-hour predicted arrival RANGE at the FINAL stop —
  // Google's traffic prediction and static baseline, bus-buffered and
  // ordered (lib/departureTime.computePredictedArrivalRange). Null when
  // either stored value is missing (failed/never computed). The raw
  // seconds and the buffer multiplier are deliberately NOT exposed —
  // only the two final formatted clock strings.
  predictedArrivalRange: { early: string; late: string } | null;
}

export interface TripDetailResponse {
  trip: {
    id: string;
    name: string;
    geometry: [number, number][];
    stops: { label: string; lat: number; lng: number }[];
    totalDistanceMeters: number;
    totalDurationSeconds: number;
  };
  vehicles: TripVehicleDetail[];
}

export async function buildTripDetailResponse(
  trip: Trip,
): Promise<TripDetailResponse> {
  // ALL vehicles in one live call plus one roster read — same
  // dedup-and-batch discipline as every prior phase.
  const vehicleIds = [
    ...new Set(trip.vehicles.map((assignment) => assignment.vehicleId)),
  ];
  const [liveVehicles, roster] = await Promise.all([
    getLiveVehicles(vehicleIds),
    getVehicleRoster(),
  ]);
  const liveById = new Map(liveVehicles.map((v) => [v.vehicleId, v]));
  const rosterById = new Map(roster.map((v) => [v.vehicleId, v]));

  const now = new Date();

  const vehicles: TripVehicleDetail[] = trip.vehicles.map((assignment) => {
    const rosterEntry = rosterById.get(assignment.vehicleId);
    const vehicleLabel =
      rosterEntry?.registrationNumber ||
      rosterEntry?.description ||
      'Unknown vehicle';

    // Phase N6: which occurrences are actually valid TODAY vs TOMORROW,
    // window-checked (computeDailySchedule) — not every configured run
    // unconditionally. Both then get the SAME rich per-entry formatting
    // (departureClock, predictedArrivalRange, day-aware status).
    const schedule = computeDailySchedule(
      assignment.schedule,
      0,
      trip.windowStart,
      trip.windowEnd,
      trip.totalDurationSeconds,
      now,
    ).map((item) =>
      buildScheduleEntryDetail(item.entry, 0, trip.totalDurationSeconds, now),
    );
    const tomorrowSchedule = computeDailySchedule(
      assignment.schedule,
      1,
      trip.windowStart,
      trip.windowEnd,
      trip.totalDurationSeconds,
      now,
    ).map((item) =>
      buildScheduleEntryDetail(item.entry, 1, trip.totalDurationSeconds, now),
    );

    // Present only when staff set one — the customer-facing "why service
    // changed" message (Phase L3).
    const serviceNote =
      assignment.serviceNote !== undefined
        ? { serviceNote: assignment.serviceNote }
        : {};

    // Phase N4: the optional card-label prefix, same present-or-omitted
    // spread as serviceNote.
    const cardLabel =
      assignment.cardLabel !== undefined
        ? { cardLabel: assignment.cardLabel }
        : {};

    // The active run drives BOTH the live dwell attribution below and the
    // Phase N5 date label — computed once here, for dark and live vehicles
    // alike. A replace can leave an assignment with NO runs (the L1
    // history-record case): null then, and no date label at all. Phase N6:
    // window-checked across today AND tomorrow (lib/scheduleEntry.ts) —
    // this is the actual fix for the reported bug.
    const activeSelection =
      assignment.schedule.length > 0
        ? selectActiveScheduleEntry(
            assignment.schedule,
            trip.totalDurationSeconds,
            trip.windowStart,
            trip.windowEnd,
            now,
          )
        : null;
    // Present whenever there's an entry to anchor it to; omitted only for a
    // fully-emptied assignment.
    const activeRunDate =
      activeSelection !== null
        ? {
            activeRunDateLabel: formatActiveRunDate(
              now,
              activeSelection.dateOffsetDays,
            ),
          }
        : {};

    const live = liveById.get(assignment.vehicleId);
    if (!live) {
      // No live fix: honest nulls, static schedule still fully present —
      // one dark vehicle must never hide its runs or the rest of the trip.
      return {
        vehicleId: assignment.vehicleId,
        vehicleLabel,
        position: null,
        positionConfident: null,
        positionUpdatedAt: null,
        speedMph: null,
        nextStopIndex: null,
        stopEtas: null,
        ...serviceNote,
        ...cardLabel,
        ...activeRunDate,
        schedule,
        tomorrowSchedule,
      };
    }

    // Live progress is attributed to this vehicle's active run: its pickup
    // wait is the dwell at stop 0, and no other stop has any dwell (wait
    // time is per-run, nowhere else). A replace can leave an assignment
    // with NO runs (the L1 history-record case) — zero dwell is the honest
    // attribution then.
    const dwellMinutes = trip.waypoints.map((_, index) =>
      index === 0 ? (activeSelection?.entry.waitMinutes ?? 0) : 0,
    );
    const progress = summarizeLiveProgress(trip, dwellMinutes, live, trip.id);

    return {
      vehicleId: assignment.vehicleId,
      vehicleLabel,
      position: {
        lat: live.latitude,
        lng: live.longitude,
        headingDegrees: live.heading ?? null,
      },
      positionConfident: progress.positionConfident,
      positionUpdatedAt: live.lastUpdatedAt,
      speedMph: live.speed ?? null,
      nextStopIndex: progress.nextStopIndex,
      stopEtas: progress.stopEtas,
      ...serviceNote,
      ...cardLabel,
      ...activeRunDate,
      schedule,
      tomorrowSchedule,
    };
  });

  return {
    trip: {
      // Explicit field mapping — the token and anything future stays out
      // of the public shape.
      id: trip.id,
      name: trip.name,
      geometry: trip.geometry,
      stops: trip.waypoints.map((stop) => ({
        label: stop.label,
        lat: stop.lat,
        lng: stop.lng,
      })),
      totalDistanceMeters: trip.totalDistanceMeters,
      totalDurationSeconds: trip.totalDurationSeconds,
    },
    vehicles,
  };
}
