import { chicagoClock24, chicagoDateLabel } from './chicagoDate';
import { formatClock12Hour } from './clockFormat';
import {
  PICKUP_DETECTION_RADIUS_METERS,
  PICKUP_EARLY_WINDOW_MINUTES,
  PICKUP_LATE_WINDOW_MINUTES,
} from './pickupDetectionConfig';
import { haversineMeters } from './routeGeometry';
import { DROPOFF_FALLBACK_MINUTES_AFTER_ESTIMATE } from './tripEstimateConfig';
import type { ScheduleEntry } from './trips';

// Phase N7: did this run's vehicle actually show up at the pickup?
//
// Pure decision, no I/O and no clock of its own — the caller supplies the
// occurrence being judged, the instant, and the live fix, so the whole
// thing is testable against a pinned clock. The caller also owns
// persistence: this returns a NEW entry (never mutates) plus whether
// anything changed, and writes nothing.
//
// Detection is deliberately one-shot per occurrence. The FIRST fix inside
// the window that lands inside the radius wins and is never revised — a bus
// that sits at the stop for ten minutes recorded its arrival at minute one,
// not minute ten.

// The READ counterpart of the write rule below, and the ONE place the
// date match lives: a stored stamp counts only when its date is the real
// calendar date of the occurrence being LOOKED AT. The card's headline
// DETECTED state and every row of the schedule list both ask through here,
// so a row and the headline can never disagree about the same run.
//
// dateOffsetDays is that occurrence's own day (0 = today, 1 = tomorrow),
// so a tomorrow row is checked against TOMORROW's label — which is exactly
// why today's detection never leaks onto tomorrow's occurrence of the same
// recurring entry, in either display.
//
// Returns the display-ready 12-hour Chicago clock, or undefined for "not
// detected for THIS occurrence" — absent, never a placeholder and never a
// fallback to some other number.
export function detectedPickupClock(
  entry: ScheduleEntry,
  dateOffsetDays: number,
  now: Date,
): string | undefined {
  if (
    // A run that isn't happening has no arrival to report — the same rule
    // a cancelled run's stored prediction already follows.
    entry.cancelled ||
    entry.actualPickupAt === undefined ||
    entry.actualPickupDate !== chicagoDateLabel(now, dateOffsetDays)
  ) {
    return undefined;
  }
  return formatClock12Hour(chicagoClock24(new Date(entry.actualPickupAt)));
}

// Is the vehicle at the pickup RIGHT NOW? Both conditions at once: inside
// the radius AND inside the window around this occurrence's arrival.
//
// Purely computed, every call, from the current fix — nothing is stored
// and nothing is remembered. That's the whole difference from
// detectPickupArrival below, which records a permanent fact the first time
// this becomes true: this one goes back to false the moment the bus pulls
// away, or the moment the window closes, whichever comes first.
//
// Because it is false past the late bound, it can never be true at the
// same time as the "missed" state (lib/tripDetail.ts), which only begins
// there — mutual exclusion falls out of the shared bounds rather than
// needing a rule of its own.
export function isVehicleCurrentlyAtPickup(
  // Null when the vehicle isn't reporting: absence of evidence, never
  // evidence of presence.
  vehiclePosition: { lat: number; lng: number } | null,
  pickupWaypoint: { lat: number; lng: number },
  occurrenceInstant: Date,
  now: Date,
): boolean {
  if (vehiclePosition === null) {
    return false;
  }
  const earlyBound =
    occurrenceInstant.getTime() - PICKUP_EARLY_WINDOW_MINUTES * 60_000;
  const lateBound =
    occurrenceInstant.getTime() + PICKUP_LATE_WINDOW_MINUTES * 60_000;
  if (now.getTime() < earlyBound || now.getTime() > lateBound) {
    return false;
  }
  return (
    haversineMeters(vehiclePosition, pickupWaypoint) <=
    PICKUP_DETECTION_RADIUS_METERS
  );
}

export interface PickupDetectionResult {
  // The original entry when nothing changed, a new one carrying the
  // detection when it did — same object identity discipline as everywhere
  // else in lib.
  entry: ScheduleEntry;
  changed: boolean;
}

export function detectPickupArrival(
  entry: ScheduleEntry,
  // THIS occurrence's real scheduled arrival instant
  // (scheduleOccurrence.computeOccurrenceTimestamp) — not a bare "HH:mm",
  // which couldn't say which day it belongs to.
  occurrenceInstant: Date,
  // "YYYY-MM-DD" for that same occurrence, Chicago-anchored
  // (chicagoDate.chicagoDateLabel — the identical helper behind the card's
  // activeRunDateLabel, so a stamp and its display can never disagree).
  occurrenceDateLabel: string,
  now: Date,
  // Null when the vehicle isn't reporting: absence of evidence, never
  // evidence of absence.
  vehiclePosition: { lat: number; lng: number } | null,
  pickupWaypoint: { lat: number; lng: number },
): PickupDetectionResult {
  const unchanged: PickupDetectionResult = { entry, changed: false };

  // A detection already exists FOR THIS SPECIFIC OCCURRENCE — keep the
  // first one. A stamp from any OTHER date is a previous day's leftover on
  // this daily-recurring entry, and reads exactly like no stamp at all.
  if (entry.actualPickupDate === occurrenceDateLabel) {
    return unchanged;
  }

  // The same predicate the live indicator uses — one implementation of
  // "in the radius, in the window", so what the card shows live and what
  // gets written down can never disagree about the same moment.
  if (
    !isVehicleCurrentlyAtPickup(
      vehiclePosition,
      pickupWaypoint,
      occurrenceInstant,
      now,
    )
  ) {
    return unchanged;
  }

  return {
    // The pair, written together — see the ScheduleEntry comment for why
    // neither field ever exists without the other.
    entry: {
      ...entry,
      actualPickupAt: now.toISOString(),
      actualPickupDate: occurrenceDateLabel,
    },
    changed: true,
  };
}

// Phase P: has the vehicle LEFT the pickup on this run?
//
// The counterpart to detectPickupArrival, and the same shape: pure,
// clock-injected, returns a new entry plus whether anything changed, and
// persists nothing itself.
//
// Two things can end a pickup, and the FIRST one to happen wins:
//   (a) the vehicle is reporting from outside the pickup radius — it
//       physically drove away, the ordinary case; or
//   (b) the pickup window's own late bound passes with the bus still
//       parked there. That bound is PICKUP_LATE_WINDOW_MINUTES, the very
//       same constant that stops pickup detection — past it, a run is no
//       longer meaningfully "at its pickup" whatever the GPS says, and a
//       vehicle whose fix goes dark mid-stop still gets a departure.
//
// STICKY, and deliberately so: once set for a date it is never revisited.
// A bus that pulls out and drifts back inside the radius (or a wobbly fix
// that appears to) has still departed, and the record must not flap back.
// That is the entire reason this is stored rather than recomputed live.
export function detectDeparture(
  entry: ScheduleEntry,
  occurrenceDateLabel: string,
  now: Date,
  vehiclePosition: { lat: number; lng: number } | null,
  pickupWaypoint: { lat: number; lng: number },
  occurrenceInstant: Date,
): PickupDetectionResult {
  const unchanged: PickupDetectionResult = { entry, changed: false };

  // Nothing can depart a pickup it never arrived at — and "arrived" has
  // to mean arrived TODAY, since a stamp from another date belongs to
  // another occurrence of this same recurring run.
  if (
    entry.actualPickupAt === undefined ||
    entry.actualPickupDate !== occurrenceDateLabel
  ) {
    return unchanged;
  }

  // Already departed for this date: keep the first answer, forever.
  if (entry.actualDepartureDate === occurrenceDateLabel) {
    return unchanged;
  }

  const leftTheRadius =
    vehiclePosition !== null &&
    haversineMeters(vehiclePosition, pickupWaypoint) >
      PICKUP_DETECTION_RADIUS_METERS;
  const windowClosed =
    now.getTime() >=
    occurrenceInstant.getTime() + PICKUP_LATE_WINDOW_MINUTES * 60_000;

  if (!leftTheRadius && !windowClosed) {
    return unchanged;
  }

  return {
    entry: {
      ...entry,
      actualDepartureAt: now.toISOString(),
      actualDepartureDate: occurrenceDateLabel,
    },
    changed: true,
  };
}

// Phase P: has this run FINISHED — reached its drop-off?
//
// Third and last of the run-lifecycle detectors, same shape as the two
// above: pure, clock-injected, returns a new entry plus whether anything
// changed, persists nothing.
//
// Two things can complete a run, first one wins:
//   (a) the vehicle reports within the pickup geofence's own radius of
//       the LAST waypoint — reused deliberately, since "close enough to
//       count as here" is one question, not a per-stop one; or
//   (b) the run's estimated travel time runs out, measured from the REAL
//       stored departure plus DROPOFF_FALLBACK_MINUTES_AFTER_ESTIMATE.
//       Anchoring on the observed departure rather than a scheduled time
//       is the whole reason departure detection exists — a run that left
//       twenty minutes late finishes twenty minutes late, and this
//       follows it instead of expiring early.
//
// STICKY per date, like its siblings: a completed run stays completed
// even if the vehicle wanders back out of range afterwards.
//
// INTERNAL: what it records never reaches the public response. It exists
// to return a map marker to its neutral state, not to tell a customer
// anything.
export function detectDropoffCompletion(
  entry: ScheduleEntry,
  occurrenceDateLabel: string,
  now: Date,
  vehiclePosition: { lat: number; lng: number } | null,
  // The trip's LAST waypoint — where the run ends.
  dropoffWaypoint: { lat: number; lng: number },
  // The trip's own totalDurationSeconds: first waypoint to last, no
  // pickup wait folded in (the wait is already behind us by definition —
  // we start counting from the real departure).
  staticTravelDurationSeconds: number,
): PickupDetectionResult {
  const unchanged: PickupDetectionResult = { entry, changed: false };

  // A run can't finish before it started moving, and "departed" has to
  // mean departed on THIS date — a stamp from another day belongs to
  // another occurrence of this recurring run.
  if (
    entry.actualDepartureAt === undefined ||
    entry.actualDepartureDate !== occurrenceDateLabel
  ) {
    return unchanged;
  }

  // Already complete for this date: keep the first answer, forever.
  if (entry.actualDropoffDate === occurrenceDateLabel) {
    return unchanged;
  }

  const atDropoff =
    vehiclePosition !== null &&
    haversineMeters(vehiclePosition, dropoffWaypoint) <=
      PICKUP_DETECTION_RADIUS_METERS;
  const estimateElapsed =
    now.getTime() >=
    new Date(entry.actualDepartureAt).getTime() +
      staticTravelDurationSeconds * 1000 +
      DROPOFF_FALLBACK_MINUTES_AFTER_ESTIMATE * 60_000;

  if (!atDropoff && !estimateElapsed) {
    return unchanged;
  }

  return {
    entry: {
      ...entry,
      actualDropoffAt: now.toISOString(),
      actualDropoffDate: occurrenceDateLabel,
    },
    changed: true,
  };
}
