import { describe, expect, it } from 'vitest';
import {
  detectDeparture,
  detectDropoffCompletion,
  detectPickupArrival,
  isVehicleCurrentlyAtPickup,
} from '@/lib/pickupDetection';
import {
  PICKUP_DETECTION_RADIUS_METERS,
  PICKUP_EARLY_WINDOW_MINUTES,
  PICKUP_LATE_WINDOW_MINUTES,
} from '@/lib/pickupDetectionConfig';
import { haversineMeters } from '@/lib/routeGeometry';
import { DROPOFF_FALLBACK_MINUTES_AFTER_ESTIMATE } from '@/lib/tripEstimateConfig';
import type { ScheduleEntry } from '@/lib/trips';

// A pinned clock throughout, same style as scheduleOccurrence.test.ts:
// every instant below is expressed relative to ONE occurrence, so a case's
// name and its arithmetic can't drift apart.
//
// The occurrence: 9:00 AM Chicago on Friday, July 17 2026 (CDT, UTC-5).
const OCCURRENCE = new Date('2026-07-17T14:00:00.000Z');
const DATE_LABEL = '2026-07-17';
const MINUTE_MS = 60_000;

function at(offsetMinutes: number): Date {
  return new Date(OCCURRENCE.getTime() + offsetMinutes * MINUTE_MS);
}

function entry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return { id: 'run-0900', arrivalTime: '09:00', waitMinutes: 10, ...overrides };
}

// The first waypoint — a real Chicago coordinate, so the haversine works on
// realistic latitudes rather than the equator.
const PICKUP = { lat: 41.8781, lng: -87.6298 };

// Metres per degree of latitude on the same sphere lib/routeGeometry.ts
// uses — the fixtures' distances are derived, then PROVEN with that same
// haversine in the boundary test, never merely assumed.
const METERS_PER_DEGREE_LAT = (Math.PI / 180) * 6371000;

function northOfPickup(meters: number): { lat: number; lng: number } {
  return { lat: PICKUP.lat + meters / METERS_PER_DEGREE_LAT, lng: PICKUP.lng };
}

const AT_THE_STOP = northOfPickup(20);
const DOWN_THE_BLOCK = northOfPickup(400);

function detect(
  overrides: {
    entry?: ScheduleEntry;
    now?: Date;
    position?: { lat: number; lng: number } | null;
  } = {},
) {
  return detectPickupArrival(
    overrides.entry ?? entry(),
    OCCURRENCE,
    DATE_LABEL,
    overrides.now ?? OCCURRENCE,
    overrides.position === undefined ? AT_THE_STOP : overrides.position,
    PICKUP,
  );
}

describe('detectPickupArrival', () => {
  it('the constants are the documented 100 m / -5 min / +10 min', () => {
    expect(PICKUP_DETECTION_RADIUS_METERS).toBe(100);
    expect(PICKUP_EARLY_WINDOW_MINUTES).toBe(5);
    expect(PICKUP_LATE_WINDOW_MINUTES).toBe(10);
  });

  it('detects: inside the window and inside the radius', () => {
    const original = entry();

    const result = detectPickupArrival(
      original,
      OCCURRENCE,
      DATE_LABEL,
      at(2),
      AT_THE_STOP,
      PICKUP,
    );

    expect(result.changed).toBe(true);
    expect(result.entry.actualPickupAt).toBe('2026-07-17T14:02:00.000Z');
    expect(result.entry.actualPickupDate).toBe(DATE_LABEL);
    // A NEW entry — the caller's stored object is never mutated in place.
    expect(result.entry).not.toBe(original);
    expect(original).not.toHaveProperty('actualPickupAt');
    // Nothing else about the run is disturbed.
    expect(result.entry.id).toBe('run-0900');
    expect(result.entry.arrivalTime).toBe('09:00');
    expect(result.entry.waitMinutes).toBe(10);
  });

  it('does NOT detect before the early bound, even parked at the stop', () => {
    // Six minutes early: one minute outside the five-minute grace.
    expect(detect({ now: at(-6) }).changed).toBe(false);
    // Exactly at the early bound is inside it — the window is closed
    // BEFORE -5, not at it.
    expect(detect({ now: at(-PICKUP_EARLY_WINDOW_MINUTES) }).changed).toBe(true);
  });

  // Documented deliberately as its own case, rather than left as a
  // side effect of the boundary test above: the recorded time for an
  // early-arriving bus is not computed, offset, or clamped by anything.
  // It is plain `now`. It merely CANNOT be earlier than window-open,
  // because before that instant detection doesn't run at all — which is
  // what makes "pickup time minus five minutes" the natural floor for a
  // bus that was already sitting there.
  it('an early-arriving vehicle is stamped at window-open, not before, and not via a hardcoded offset', () => {
    // The bus has been parked at the stop for twenty minutes. Nothing is
    // recorded: there is no earlier stamp for a later poll to preserve.
    expect(detect({ now: at(-20) }).changed).toBe(false);

    // The very first poll once the window opens. The stamp is that
    // instant, which happens to be arrival minus the early-window
    // constant — an outcome of when detection became possible, not of any
    // formula in the detector.
    const firstPoll = detect({ now: at(-PICKUP_EARLY_WINDOW_MINUTES) });
    expect(firstPoll.changed).toBe(true);
    expect(firstPoll.entry.actualPickupAt).toBe('2026-07-17T13:55:00.000Z');
    expect(new Date(firstPoll.entry.actualPickupAt!).getTime()).toBe(
      OCCURRENCE.getTime() - PICKUP_EARLY_WINDOW_MINUTES * MINUTE_MS,
    );

    // A poll landing a few seconds INTO the window records those seconds
    // verbatim — no snapping to the bound, no rounding to the minute.
    // A special-cased "arrival minus 5" would have flattened this to
    // 13:55:00.
    const secondsLate = new Date(
      OCCURRENCE.getTime() - PICKUP_EARLY_WINDOW_MINUTES * MINUTE_MS + 7_000,
    );
    const slightlyLater = detect({ now: secondsLate });
    expect(slightlyLater.entry.actualPickupAt).toBe(
      '2026-07-17T13:55:07.000Z',
    );
    expect(slightlyLater.entry.actualPickupAt).toBe(secondsLate.toISOString());
  });

  it('does NOT detect past the late cutoff, even parked at the stop', () => {
    // Eleven minutes late: the run is no longer detectable, only missed.
    expect(detect({ now: at(11) }).changed).toBe(false);
    // Exactly at the cutoff still counts.
    expect(detect({ now: at(PICKUP_LATE_WINDOW_MINUTES) }).changed).toBe(true);
  });

  it('does NOT detect a vehicle that is inside the window but too far away', () => {
    const result = detect({ now: at(1), position: DOWN_THE_BLOCK });

    expect(result.changed).toBe(false);
    expect(result.entry).not.toHaveProperty('actualPickupAt');
    expect(result.entry).not.toHaveProperty('actualPickupDate');
  });

  it('the radius boundary: just inside detects, just outside does not', () => {
    // Derived from the constant, not a copy of its current value, so this
    // keeps testing the BOUNDARY rather than a stale number if the radius
    // is retuned again.
    const justInside = northOfPickup(PICKUP_DETECTION_RADIUS_METERS - 0.1);
    const justOutside = northOfPickup(PICKUP_DETECTION_RADIUS_METERS + 0.1);
    // The fixtures really do straddle the radius, measured with the same
    // haversine the detector itself calls.
    expect(haversineMeters(justInside, PICKUP)).toBeLessThanOrEqual(
      PICKUP_DETECTION_RADIUS_METERS,
    );
    expect(haversineMeters(justOutside, PICKUP)).toBeGreaterThan(
      PICKUP_DETECTION_RADIUS_METERS,
    );

    expect(detect({ now: at(1), position: justInside }).changed).toBe(true);
    expect(detect({ now: at(1), position: justOutside }).changed).toBe(false);
  });

  it('does nothing when the vehicle has no live position at all', () => {
    const result = detect({ now: at(1), position: null });

    expect(result.changed).toBe(false);
    expect(result.entry).not.toHaveProperty('actualPickupAt');
  });

  it('never overwrites an existing detection for the SAME date', () => {
    // The bus arrived at 8:58 and is still sitting there at 9:03 — the
    // recorded arrival stays the moment it first showed up.
    const alreadyDetected = entry({
      actualPickupAt: '2026-07-17T13:58:00.000Z',
      actualPickupDate: DATE_LABEL,
    });

    const result = detect({ entry: alreadyDetected, now: at(3) });

    expect(result.changed).toBe(false);
    expect(result.entry).toBe(alreadyDetected);
    expect(result.entry.actualPickupAt).toBe('2026-07-17T13:58:00.000Z');
  });

  it('treats a detection from a DIFFERENT date as absent — this daily run detects afresh', () => {
    // Yesterday's stamp, still sitting on this recurring entry. Without the
    // date pairing it would read as "already arrived" every morning after.
    const stale = entry({
      actualPickupAt: '2026-07-16T13:59:00.000Z',
      actualPickupDate: '2026-07-16',
    });

    const result = detect({ entry: stale, now: at(1) });

    expect(result.changed).toBe(true);
    expect(result.entry.actualPickupAt).toBe('2026-07-17T14:01:00.000Z');
    expect(result.entry.actualPickupDate).toBe(DATE_LABEL);
  });

  it('a stale detection is still no excuse to detect outside the window', () => {
    // The stale-date path must not become a back door around the bounds.
    const stale = entry({
      actualPickupAt: '2026-07-16T13:59:00.000Z',
      actualPickupDate: '2026-07-16',
    });

    const result = detect({ entry: stale, now: at(11) });

    expect(result.changed).toBe(false);
    // Yesterday's pair is left exactly as it was — untouched, not cleared.
    expect(result.entry.actualPickupDate).toBe('2026-07-16');
  });
});

// The LIVE counterpart: same radius, same window, same fixtures and the
// same boundary structure as the recorder above — the point being that it
// asks the identical question, it just never writes the answer down.
describe('isVehicleCurrentlyAtPickup', () => {
  function isAtPickup(
    now: Date,
    position: { lat: number; lng: number } | null = AT_THE_STOP,
  ): boolean {
    return isVehicleCurrentlyAtPickup(position, PICKUP, OCCURRENCE, now);
  }

  it('inside the radius and inside the window → true', () => {
    expect(isAtPickup(at(2))).toBe(true);
  });

  it('inside the window but outside the radius → false', () => {
    expect(isAtPickup(at(2), DOWN_THE_BLOCK)).toBe(false);
  });

  it('inside the radius but before the early bound → false', () => {
    expect(isAtPickup(at(-6))).toBe(false);
    // The bound itself is inside the window, same as the recorder's.
    expect(isAtPickup(at(-PICKUP_EARLY_WINDOW_MINUTES))).toBe(true);
  });

  it('inside the radius but past the late cutoff → false', () => {
    expect(isAtPickup(at(11))).toBe(false);
    expect(isAtPickup(at(PICKUP_LATE_WINDOW_MINUTES))).toBe(true);
  });

  // Past the late bound this is false no matter where the bus is, which is
  // precisely when the "missed" state begins — so the two can never both
  // be showing, without either one knowing about the other.
  it('is false past the late cutoff even parked at the stop — the missed state can never overlap it', () => {
    expect(isAtPickup(at(30))).toBe(false);
  });

  it('a vehicle with no live fix is false, never assumed present', () => {
    expect(isAtPickup(at(2), null)).toBe(false);
  });

  it('the radius boundary matches the recorder exactly (unchanged)', () => {
    expect(isAtPickup(at(2), northOfPickup(PICKUP_DETECTION_RADIUS_METERS - 0.1))).toBe(
      true,
    );
    expect(isAtPickup(at(2), northOfPickup(PICKUP_DETECTION_RADIUS_METERS + 0.1))).toBe(
      false,
    );
  });
});

// Phase P: the departure step. Same fixtures and same pinned clock as the
// two above — an occurrence at 9:00 AM Chicago, a pickup point, and one
// position inside the radius (AT_THE_STOP) and one well outside it
// (DOWN_THE_BLOCK).
describe('detectDeparture', () => {
  // The state departure detection requires: this run already arrived
  // TODAY. Everything below starts from here unless it's testing the
  // absence of it.
  const ARRIVED = entry({
    actualPickupAt: '2026-07-17T13:58:00.000Z',
    actualPickupDate: DATE_LABEL,
  });

  function depart(
    overrides: {
      entry?: ScheduleEntry;
      now?: Date;
      position?: { lat: number; lng: number } | null;
    } = {},
  ) {
    return detectDeparture(
      overrides.entry ?? ARRIVED,
      DATE_LABEL,
      overrides.now ?? OCCURRENCE,
      overrides.position === undefined ? AT_THE_STOP : overrides.position,
      PICKUP,
      OCCURRENCE,
    );
  }

  it('does nothing before the pickup is confirmed — nothing departs what it never reached', () => {
    // No stamp at all, and parked far away: every OTHER condition for
    // departure is met, and it still must not fire.
    const result = depart({ entry: entry(), position: DOWN_THE_BLOCK });

    expect(result.changed).toBe(false);
    expect(result.entry).not.toHaveProperty('actualDepartureAt');
  });

  it("does nothing when the pickup stamp belongs to a DIFFERENT date", () => {
    // Yesterday's arrival on this daily-recurring run says nothing about
    // today's occurrence.
    const staleArrival = entry({
      actualPickupAt: '2026-07-16T13:58:00.000Z',
      actualPickupDate: '2026-07-16',
    });

    expect(
      depart({ entry: staleArrival, position: DOWN_THE_BLOCK }).changed,
    ).toBe(false);
  });

  it('fires when the vehicle leaves the radius', () => {
    const result = depart({ now: at(1), position: DOWN_THE_BLOCK });

    expect(result.changed).toBe(true);
    expect(result.entry.actualDepartureAt).toBe('2026-07-17T14:01:00.000Z');
    expect(result.entry.actualDepartureDate).toBe(DATE_LABEL);
    // The arrival record is untouched — two independent facts.
    expect(result.entry.actualPickupAt).toBe('2026-07-17T13:58:00.000Z');
    // New object, never a mutation of the caller's.
    expect(ARRIVED).not.toHaveProperty('actualDepartureAt');
  });

  it('does NOT fire while the vehicle is still inside the radius and inside the window', () => {
    expect(depart({ now: at(1) }).changed).toBe(false);
  });

  it('fires at the late bound even when the vehicle never leaves the radius', () => {
    // Still parked at the stop, but the pickup window's own late cutoff
    // has arrived — the same +10 constant that stops pickup detection.
    expect(depart({ now: at(PICKUP_LATE_WINDOW_MINUTES) }).changed).toBe(true);
    // One minute earlier it had not yet fired: the bound is the trigger,
    // not merely "some time later".
    expect(depart({ now: at(PICKUP_LATE_WINDOW_MINUTES - 1) }).changed).toBe(
      false,
    );
  });

  it('also fires at the late bound when the vehicle has gone dark', () => {
    // No fix at all: (a) can never be evaluated, so the time-based
    // fallback is the only thing that can end this pickup.
    const result = depart({
      now: at(PICKUP_LATE_WINDOW_MINUTES),
      position: null,
    });

    expect(result.changed).toBe(true);
    expect(result.entry.actualDepartureAt).toBe('2026-07-17T14:10:00.000Z');
  });

  // "Whichever condition is met first wins", both orderings.
  it('radius-exit BEFORE the late bound wins, and stamps the exit time', () => {
    const result = depart({ now: at(3), position: DOWN_THE_BLOCK });

    expect(result.entry.actualDepartureAt).toBe('2026-07-17T14:03:00.000Z');
  });

  it('the late bound wins when the vehicle is still at the stop, and stamps that instant', () => {
    const result = depart({ now: at(PICKUP_LATE_WINDOW_MINUTES) });

    expect(result.entry.actualDepartureAt).toBe('2026-07-17T14:10:00.000Z');
  });

  // THE stickiness guarantee, and the reason this is stored at all.
  it('never un-sets: a vehicle that drifts back inside the radius stays departed', () => {
    const departed = entry({
      actualPickupAt: '2026-07-17T13:58:00.000Z',
      actualPickupDate: DATE_LABEL,
      actualDepartureAt: '2026-07-17T14:01:00.000Z',
      actualDepartureDate: DATE_LABEL,
    });

    // Back within the radius, well inside the window — every live signal
    // says "at the pickup" again.
    const result = depart({ entry: departed, now: at(4) });

    expect(result.changed).toBe(false);
    expect(result.entry).toBe(departed);
    // The ORIGINAL departure instant, not the re-entry moment.
    expect(result.entry.actualDepartureAt).toBe('2026-07-17T14:01:00.000Z');
  });

  it('never re-stamps a later departure over an earlier one', () => {
    const departed = entry({
      actualPickupAt: '2026-07-17T13:58:00.000Z',
      actualPickupDate: DATE_LABEL,
      actualDepartureAt: '2026-07-17T14:01:00.000Z',
      actualDepartureDate: DATE_LABEL,
    });

    // Left the radius again, much later — the first exit is still the
    // departure.
    const result = depart({
      entry: departed,
      now: at(30),
      position: DOWN_THE_BLOCK,
    });

    expect(result.changed).toBe(false);
    expect(result.entry.actualDepartureAt).toBe('2026-07-17T14:01:00.000Z');
  });

  it("a departure stamp from a DIFFERENT date is treated as absent — today's run departs afresh", () => {
    const yesterdaysDeparture = entry({
      actualPickupAt: '2026-07-17T13:58:00.000Z',
      actualPickupDate: DATE_LABEL,
      actualDepartureAt: '2026-07-16T14:01:00.000Z',
      actualDepartureDate: '2026-07-16',
    });

    const result = depart({
      entry: yesterdaysDeparture,
      now: at(2),
      position: DOWN_THE_BLOCK,
    });

    expect(result.changed).toBe(true);
    expect(result.entry.actualDepartureAt).toBe('2026-07-17T14:02:00.000Z');
    expect(result.entry.actualDepartureDate).toBe(DATE_LABEL);
  });
});

// Phase P: the drop-off step — internal only, never displayed. Same
// pinned clock; the drop-off point is a separate coordinate from the
// pickup, with one position on top of it and one far away.
describe('detectDropoffCompletion', () => {
  // A kilometre north of the pickup: nowhere near either end's radius
  // until we say otherwise.
  const DROPOFF = northOfPickup(1000);
  const AT_THE_DROPOFF = northOfPickup(1000 + 20); // ~20 m from it
  const MID_ROUTE = northOfPickup(500); // far from both ends

  // A 10-minute scheduled drive, so the time fallback lands at
  // departure + 10 min + 5 min = departure + 15 min.
  const TRAVEL_SECONDS = 600;
  const DEPARTED_AT = '2026-07-17T14:01:00.000Z'; // 9:01, one minute in
  const FALLBACK_DUE = new Date(
    new Date(DEPARTED_AT).getTime() +
      TRAVEL_SECONDS * 1000 +
      DROPOFF_FALLBACK_MINUTES_AFTER_ESTIMATE * MINUTE_MS,
  );

  // The state drop-off requires: this run departed TODAY.
  const DEPARTED = entry({
    actualPickupAt: '2026-07-17T13:58:00.000Z',
    actualPickupDate: DATE_LABEL,
    actualDepartureAt: DEPARTED_AT,
    actualDepartureDate: DATE_LABEL,
  });

  function complete(
    overrides: {
      entry?: ScheduleEntry;
      now?: Date;
      position?: { lat: number; lng: number } | null;
    } = {},
  ) {
    return detectDropoffCompletion(
      overrides.entry ?? DEPARTED,
      DATE_LABEL,
      overrides.now ?? at(5),
      overrides.position === undefined ? MID_ROUTE : overrides.position,
      DROPOFF,
      TRAVEL_SECONDS,
    );
  }

  it('does nothing before departure is confirmed — a run that never left cannot finish', () => {
    // Parked on top of the drop-off point, which alone would trigger (a),
    // but this run has only been picked up.
    const arrivedOnly = entry({
      actualPickupAt: '2026-07-17T13:58:00.000Z',
      actualPickupDate: DATE_LABEL,
    });

    const result = complete({ entry: arrivedOnly, position: AT_THE_DROPOFF });

    expect(result.changed).toBe(false);
    expect(result.entry).not.toHaveProperty('actualDropoffAt');
  });

  it('does nothing when the departure stamp belongs to a DIFFERENT date', () => {
    const staleDeparture = entry({
      actualPickupAt: '2026-07-17T13:58:00.000Z',
      actualPickupDate: DATE_LABEL,
      actualDepartureAt: '2026-07-16T14:01:00.000Z',
      actualDepartureDate: '2026-07-16',
    });

    expect(
      complete({ entry: staleDeparture, position: AT_THE_DROPOFF }).changed,
    ).toBe(false);
  });

  it('fires within the radius of the drop-off point', () => {
    const result = complete({ now: at(5), position: AT_THE_DROPOFF });

    expect(result.changed).toBe(true);
    expect(result.entry.actualDropoffAt).toBe('2026-07-17T14:05:00.000Z');
    expect(result.entry.actualDropoffDate).toBe(DATE_LABEL);
    // The two earlier facts are untouched — three independent records.
    expect(result.entry.actualPickupAt).toBe('2026-07-17T13:58:00.000Z');
    expect(result.entry.actualDepartureAt).toBe(DEPARTED_AT);
    expect(DEPARTED).not.toHaveProperty('actualDropoffAt');
  });

  it('does NOT fire outside the radius while the estimate still has time left', () => {
    // Mid-route, and well before departure + 10 min + 5 min.
    expect(complete({ now: at(5), position: MID_ROUTE }).changed).toBe(false);
  });

  it('the radius boundary matches the pickup geofence exactly', () => {
    const justInside = northOfPickup(
      1000 + PICKUP_DETECTION_RADIUS_METERS - 0.1,
    );
    const justOutside = northOfPickup(
      1000 + PICKUP_DETECTION_RADIUS_METERS + 0.1,
    );

    expect(complete({ position: justInside }).changed).toBe(true);
    expect(complete({ position: justOutside }).changed).toBe(false);
  });

  it('the time fallback fires at exactly departure + travel + 5 min, however far away it is', () => {
    // Nowhere near the drop-off point — only the clock can complete this.
    const result = complete({ now: FALLBACK_DUE, position: MID_ROUTE });

    expect(result.changed).toBe(true);
    expect(result.entry.actualDropoffAt).toBe(FALLBACK_DUE.toISOString());

    // One minute earlier it had not yet fired: the deadline is the
    // trigger, not merely "later on".
    const oneMinuteEarlier = new Date(FALLBACK_DUE.getTime() - MINUTE_MS);
    expect(complete({ now: oneMinuteEarlier, position: MID_ROUTE }).changed).toBe(
      false,
    );
  });

  it('the fallback is measured from the REAL departure, not the scheduled arrival', () => {
    // The same run, departed ten minutes later than the one above. Its
    // deadline must move with it — a scheduled-time anchor would have
    // expired this run while it was still driving.
    const lateDeparture = entry({
      actualPickupAt: '2026-07-17T13:58:00.000Z',
      actualPickupDate: DATE_LABEL,
      actualDepartureAt: '2026-07-17T14:11:00.000Z', // 10 min later
      actualDepartureDate: DATE_LABEL,
    });

    // The ORIGINAL deadline passes with nothing recorded...
    expect(
      complete({
        entry: lateDeparture,
        now: FALLBACK_DUE,
        position: MID_ROUTE,
      }).changed,
    ).toBe(false);
    // ...and the real one lands exactly ten minutes further out.
    const shiftedDeadline = new Date(FALLBACK_DUE.getTime() + 10 * MINUTE_MS);
    expect(
      complete({
        entry: lateDeparture,
        now: shiftedDeadline,
        position: MID_ROUTE,
      }).changed,
    ).toBe(true);
  });

  it('the fallback also completes a run whose vehicle has gone dark', () => {
    const result = complete({ now: FALLBACK_DUE, position: null });

    expect(result.changed).toBe(true);
    expect(result.entry.actualDropoffAt).toBe(FALLBACK_DUE.toISOString());
  });

  // "Whichever condition is met first wins", both orderings.
  it('arriving at the drop-off BEFORE the deadline wins, and stamps the arrival', () => {
    const result = complete({ now: at(6), position: AT_THE_DROPOFF });

    expect(result.entry.actualDropoffAt).toBe('2026-07-17T14:06:00.000Z');
  });

  it('the deadline wins when the vehicle never reaches the point, and stamps that instant', () => {
    const result = complete({ now: FALLBACK_DUE, position: MID_ROUTE });

    expect(result.entry.actualDropoffAt).toBe(FALLBACK_DUE.toISOString());
  });

  // Stickiness, mirroring departure's own three cases.
  it('never un-sets: a vehicle that leaves the drop-off area stays complete', () => {
    const completed = entry({
      actualPickupAt: '2026-07-17T13:58:00.000Z',
      actualPickupDate: DATE_LABEL,
      actualDepartureAt: DEPARTED_AT,
      actualDepartureDate: DATE_LABEL,
      actualDropoffAt: '2026-07-17T14:09:00.000Z',
      actualDropoffDate: DATE_LABEL,
    });

    const result = complete({
      entry: completed,
      now: at(20),
      position: MID_ROUTE,
    });

    expect(result.changed).toBe(false);
    expect(result.entry).toBe(completed);
    expect(result.entry.actualDropoffAt).toBe('2026-07-17T14:09:00.000Z');
  });

  it('never re-stamps a later completion over an earlier one', () => {
    const completed = entry({
      actualPickupAt: '2026-07-17T13:58:00.000Z',
      actualPickupDate: DATE_LABEL,
      actualDepartureAt: DEPARTED_AT,
      actualDepartureDate: DATE_LABEL,
      actualDropoffAt: '2026-07-17T14:09:00.000Z',
      actualDropoffDate: DATE_LABEL,
    });

    // Back at the drop-off point long afterwards, and past the deadline
    // too — both triggers armed, neither may re-fire.
    const result = complete({
      entry: completed,
      now: at(60),
      position: AT_THE_DROPOFF,
    });

    expect(result.changed).toBe(false);
    expect(result.entry.actualDropoffAt).toBe('2026-07-17T14:09:00.000Z');
  });

  it("a completion stamp from a DIFFERENT date is treated as absent — today's run completes afresh", () => {
    const yesterdaysCompletion = entry({
      actualPickupAt: '2026-07-17T13:58:00.000Z',
      actualPickupDate: DATE_LABEL,
      actualDepartureAt: DEPARTED_AT,
      actualDepartureDate: DATE_LABEL,
      actualDropoffAt: '2026-07-16T14:09:00.000Z',
      actualDropoffDate: '2026-07-16',
    });

    const result = complete({
      entry: yesterdaysCompletion,
      now: at(7),
      position: AT_THE_DROPOFF,
    });

    expect(result.changed).toBe(true);
    expect(result.entry.actualDropoffAt).toBe('2026-07-17T14:07:00.000Z');
    expect(result.entry.actualDropoffDate).toBe(DATE_LABEL);
  });
});
