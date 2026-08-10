import { chicagoCalendarAnchor, chicagoDateLabel } from './chicagoDate';
import { formatClock12Hour } from './clockFormat';
import {
  computeDailySchedule,
  type DailyScheduleItem,
} from './dailySchedule';
import {
  computeDepartureClock,
  computePredictedArrivalRange,
} from './departureTime';
import { summarizeLiveProgress } from './liveProgress';
import { getLiveVehicles } from './liveVehicles';
import { detectedPickupClock } from './pickupDetection';
import { PICKUP_LATE_WINDOW_MINUTES } from './pickupDetectionConfig';
import {
  computeOccurrenceTimestamp,
  getOccurrenceStatus,
} from './scheduleOccurrence';
import {
  selectActiveScheduleEntry,
  type ActiveScheduleSelection,
} from './scheduleEntry';
import type { TripStatus } from './scheduleStatus';
import type { Trip } from './trips';
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

// Phase N6: generalized from a today/tomorrow boolean to an explicit
// dateOffsetDays (0 = today, 1 = tomorrow, matching
// lib/scheduleEntry.ts's ActiveScheduleSelection). Phase N7: the Chicago
// calendar-date arithmetic itself moved to lib/chicagoDate.ts, so the day
// this label names and the day a pickup detection is scoped to are, by
// construction, the same day.
function formatActiveRunDate(now: Date, dateOffsetDays: number): string {
  return runDateFormat.format(chicagoCalendarAnchor(now, dateOffsetDays));
}

// Phase N7's READ step: which of three pickup states the active run is in.
//
// DETECTED — a stored stamp whose date matches THIS occurrence's real
//   calendar date. The match is checked explicitly, never assumed: the same
//   entry recurs daily, so yesterday's stamp is still sitting on it.
// MISSED — no such stamp, and the detection window's late edge (the same
//   PICKUP_LATE_WINDOW_MINUTES the write step stops at) has passed.
// PENDING — neither: the run is still inside its window, or hasn't reached
//   it. Emits nothing at all, leaving the card's existing predicted-arrival
//   display exactly as it was.
//
// Returns a spreadable object so both states stay absent-when-not-true,
// the same convention as serviceNote/cardLabel above.
function resolvePickupState(
  selection: ActiveScheduleSelection,
  now: Date,
): { actualPickupClock?: string; pickupMissed?: true } {
  const { entry, dateOffsetDays } = selection;
  // A cancelled run isn't happening (Phase L3) — it can't be detected and
  // it can't be missed. The card says "cancelled" for it and nothing else.
  if (entry.cancelled) {
    return {};
  }

  // The same date-matching check every schedule ROW goes through
  // (lib/pickupDetection.ts) — one implementation, so the headline and the
  // list can't disagree about whether this run was detected.
  const actualPickupClock = detectedPickupClock(entry, dateOffsetDays, now);
  if (actualPickupClock !== undefined) {
    return { actualPickupClock };
  }

  const occurrenceInstant = computeOccurrenceTimestamp(
    entry.arrivalTime,
    dateOffsetDays,
    now,
  );
  if (
    now.getTime() >
    occurrenceInstant.getTime() + PICKUP_LATE_WINDOW_MINUTES * 60_000
  ) {
    return { pickupMissed: true };
  }
  return {};
}

// Phase P: how a vehicle's map marker should read, from the three stored
// lifecycle stamps and nothing else — no live position, no radius
// recheck, no clock guesswork beyond the date match. A marker keyed to a
// stored fact can't flicker; one keyed to "is it within 100 m right now?"
// flickers whenever a parked bus's fix wanders.
export type MarkerStatus = 'at-pickup' | 'en-route' | 'general';

// Both of the card/marker progress signals, resolved together from one
// reading of the same three stamps.
function resolveRunProgress(
  selection: ActiveScheduleSelection | null,
  now: Date,
): { departedPickup: boolean; markerStatus: MarkerStatus } {
  // Nothing scheduled, or a run that isn't happening: neutral marker,
  // nothing departed. (A cancelled run gets its own card message, and no
  // lifecycle state at all — same rule the write steps follow.)
  if (selection === null || selection.entry.cancelled) {
    return { departedPickup: false, markerStatus: 'general' };
  }

  const { entry } = selection;
  // The occurrence's own real calendar date — every stamp is checked
  // against it, so yesterday's leftovers on this daily-recurring entry
  // count for nothing today.
  const dateLabel = chicagoDateLabel(now, selection.dateOffsetDays);
  const pickedUp =
    entry.actualPickupAt !== undefined && entry.actualPickupDate === dateLabel;
  const departed =
    entry.actualDepartureAt !== undefined &&
    entry.actualDepartureDate === dateLabel;
  const droppedOff =
    entry.actualDropoffAt !== undefined && entry.actualDropoffDate === dateLabel;

  // The three stamps only ever advance, and each requires the one before
  // it, so these cases are mutually exclusive by construction.
  const markerStatus: MarkerStatus = droppedOff
    ? 'general' // the run is over — the marker goes back to neutral
    : departed
      ? 'en-route'
      : pickedUp
        ? 'at-pickup'
        : 'general'; // nothing confirmed yet

  return { departedPickup: departed, markerStatus };
}

// The rich per-entry public shape (id/arrivalTime/waitMinutes/status/
// cancelled?/departureClock/actualPickupClock?/predictedArrivalRange),
// day-aware: dateOffsetDays 0 for the existing today `schedule` field, 1
// for the new `tomorrowSchedule` field — both otherwise identical
// formatting.
//
// Takes the whole DailyScheduleItem, not just its entry: Phase N7's
// per-row detection is already resolved there, against the very
// dateOffsetDays that item was validated for, so it rides through rather
// than being recomputed a second way here.
function buildScheduleEntryDetail(
  item: DailyScheduleItem,
  dateOffsetDays: number,
  tripDurationSeconds: number,
  now: Date,
): SchedulePublicEntry {
  const entry = item.entry;
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
    // Phase N7: the row's own confirmed pickup, present only when THIS
    // occurrence was really detected — the schedule list's third column.
    ...(item.actualPickupClock !== undefined
      ? { actualPickupClock: item.actualPickupClock }
      : {}),
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
  // Phase N7 — the active run's pickup state, at most ONE of these two
  // present, both absent in the ordinary pending case:
  // DETECTED: when the vehicle was actually seen at the first stop for
  // THIS occurrence, 12-hour Chicago clock ("9:02 AM").
  actualPickupClock?: string;
  // MISSED: no detection, and the detection window closed. Present (true)
  // only then — same never-store-false convention as `cancelled`.
  pickupMissed?: true;
  // Phase P: has the active run LEFT its pickup? Straight from the
  // stored departure stamp, date-checked — sticky, so it only ever goes
  // false→true, never back. Always present (unlike the two optional
  // fields above): it's one leg of a state machine the card walks, where
  // "not yet" is a real answer rather than an absence.
  //
  // Paired with actualPickupClock this gives the card its whole pickup
  // story without a second live computation: clock + !departed = the bus
  // is there now; clock + departed = it was there, at that time.
  departedPickup: boolean;
  // Phase P: which of three states this vehicle's map marker should show,
  // from the same stored stamps as departedPickup — 'at-pickup' while it
  // sits at the first stop, 'en-route' once it has left, 'general' before
  // the run starts and again once drop-off is confirmed.
  //
  // The drop-off stamps THEMSELVES are deliberately absent from this
  // shape: retiring the marker is the only thing they're for, and no
  // customer is ever shown a drop-off time.
  markerStatus: MarkerStatus;
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
  // Phase N7: THIS row's own confirmed pickup time ("9:02 AM"), present
  // only when the vehicle was really detected at the first stop on this
  // row's own occurrence date. Absent means undetected — the row's
  // arrival column stays blank; it never falls back to a predicted time.
  actualPickupClock?: string;
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
      buildScheduleEntryDetail(item, 0, trip.totalDurationSeconds, now),
    );
    const tomorrowSchedule = computeDailySchedule(
      assignment.schedule,
      1,
      trip.windowStart,
      trip.windowEnd,
      trip.totalDurationSeconds,
      now,
    ).map((item) =>
      buildScheduleEntryDetail(item, 1, trip.totalDurationSeconds, now),
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

    // Phase N7: detected / missed / pending for that same active run —
    // read-only here. The stamp itself is written upstream, in the public
    // trip route, BEFORE this builder runs, so a detection made on this
    // request is already visible to it.
    const pickupState =
      activeSelection !== null ? resolvePickupState(activeSelection, now) : {};

    const live = liveById.get(assignment.vehicleId);

    // Phase P: has this run left its pickup yet? Read STRAIGHT off the
    // stored departure stamp — the one sticky fact, written once by the
    // route's departure step — rather than re-deriving "is it still
    // there?" from the current fix.
    //
    // That is the whole point: a live radius re-check flickers when a
    // parked bus's GPS wanders across the boundary, and every display
    // keyed to it flickers in sympathy. A stored fact cannot flap, so
    // anything reading this reads the same answer at the same moment.
    // Date-scoped like every other stamp, since the entry recurs daily.
    // Phase P: both come out of ONE reading of the three stored stamps,
    // so the card's wording and the marker's state are the same fact
    // twice, never two lookalike computations that can disagree.
    const { departedPickup, markerStatus } = resolveRunProgress(
      activeSelection,
      now,
    );

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
        ...pickupState,
        departedPickup,
        markerStatus,
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
      ...pickupState,
      departedPickup,
      markerStatus,
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
