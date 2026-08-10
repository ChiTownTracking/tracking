import type { NextRequest } from 'next/server';
import { chicagoDateLabel } from '@/lib/chicagoDate';
import { getLiveVehicles } from '@/lib/liveVehicles';
import {
  detectDeparture,
  detectDropoffCompletion,
  detectPickupArrival,
} from '@/lib/pickupDetection';
import { RedisRateLimiter } from '@/lib/rateLimiter';
import { selectActiveScheduleEntry } from '@/lib/scheduleEntry';
import { computeOccurrenceTimestamp } from '@/lib/scheduleOccurrence';
import { isUuidShaped } from '@/lib/trackingTokens';
import { getWindowStatus, WINDOW_MESSAGES } from '@/lib/trackingWindow';
import { buildTripDetailResponse } from '@/lib/tripDetail';
import type { Trip } from '@/lib/trips';
import { getTripByToken, saveTrip } from '@/lib/tripsStore';

// The per-trip public surface — a trip token resolves its own trip's
// detail: the shared path plus EVERY assigned vehicle's live progress and
// run schedule (Phase I1's multi-vehicle shape). Outside proxy.ts's
// matchers by design; the token is the gate, never a session.

// Never serve a cached copy of this route. Every answer here is computed
// from the live vehicle fix and the clock at request time, and Phase N7
// now WRITES during the request — a reused response would silently skip
// the detection pass. This project's cacheComponents flag is off
// (next.config.ts), so the pre-16 route-segment config still applies; if
// that flag is ever turned on, `dynamic` is removed and this becomes a
// `cacheLife`/`'use cache'` decision instead.
export const dynamic = 'force-dynamic';

// Own budget, own prefix — this surface's traffic shouldn't share (or
// drain) the route board's allowance. 30/60s stays the starting point.
const tripLimiter = new RedisRateLimiter(30, 60, 'ratelimit:trip');

// Phase N7: stamp each vehicle's ACTIVE run with the moment it actually
// reached the pickup, when the live fix says it just did. Returns the trip
// to build the response from — the same object when nothing was detected,
// a new one (already persisted) when something was.
//
// The live read uses the same deduped id list buildTripDetailResponse
// builds, so getLiveVehicles' 30-second cache serves that call from memory:
// one upstream Quartix request per HTTP request, exactly as before.
//
// Persistence is ONE saveTrip for the whole trip after every vehicle has
// been judged — never one write per vehicle — and nothing at all when
// nothing changed.
async function applyPickupDetection(trip: Trip): Promise<Trip> {
  const pickupWaypoint = trip.waypoints[0];
  // Where the run ends — the same list's last entry, which on a two-stop
  // trip is simply the other one.
  const dropoffWaypoint = trip.waypoints[trip.waypoints.length - 1];
  if (
    pickupWaypoint === undefined ||
    dropoffWaypoint === undefined ||
    trip.vehicles.length === 0
  ) {
    return trip;
  }

  const liveVehicles = await getLiveVehicles([
    ...new Set(trip.vehicles.map((assignment) => assignment.vehicleId)),
  ]);
  const liveById = new Map(liveVehicles.map((live) => [live.vehicleId, live]));
  const now = new Date();

  let detectedAny = false;
  const vehicles = trip.vehicles.map((assignment) => {
    // An L1 replace can leave an assignment with no runs at all — nothing
    // to detect against.
    if (assignment.schedule.length === 0) {
      return assignment;
    }
    // The SAME selection the response's own date label and dwell
    // attribution use (lib/scheduleEntry.ts), so the run being stamped is
    // exactly the run being shown — no second, subtly-different notion of
    // "the active one".
    const selection = selectActiveScheduleEntry(
      assignment.schedule,
      trip.totalDurationSeconds,
      trip.windowStart,
      trip.windowEnd,
      now,
    );
    // A cancelled run is not a real run (Phase L3): it only ever surfaces
    // as a last-resort display anchor, and a bus that happens to idle at
    // the stop must not record an arrival for a run that isn't happening.
    if (selection.entry.cancelled) {
      return assignment;
    }

    const live = liveById.get(assignment.vehicleId);
    const vehiclePosition = live
      ? { lat: live.latitude, lng: live.longitude }
      : null;
    const occurrenceInstant = computeOccurrenceTimestamp(
      selection.entry.arrivalTime,
      selection.dateOffsetDays,
      now,
    );
    const occurrenceDateLabel = chicagoDateLabel(now, selection.dateOffsetDays);

    const pickup = detectPickupArrival(
      selection.entry,
      occurrenceInstant,
      occurrenceDateLabel,
      now,
      vehiclePosition,
      pickupWaypoint,
    );
    // Phase P: departure is judged on the entry AS THE PICKUP STEP LEFT
    // IT, not the stored one — so a pickup recorded on this very request
    // is already visible to it, and the two steps can't disagree about
    // the same instant. Chained, never parallel, for that reason.
    const departure = detectDeparture(
      pickup.entry,
      occurrenceDateLabel,
      now,
      vehiclePosition,
      pickupWaypoint,
      occurrenceInstant,
    );

    // ...and drop-off on the departure step's output, for the same
    // reason: a departure recorded a moment ago in this very request is
    // already a real fact by the time completion is judged, so a run can
    // start and finish inside one poll without waiting for the next.
    const dropoff = detectDropoffCompletion(
      departure.entry,
      occurrenceDateLabel,
      now,
      vehiclePosition,
      dropoffWaypoint,
      trip.totalDurationSeconds,
    );

    // Any link in the chain changing is a change; `dropoff.entry` carries
    // all three, having been built from the two steps before it.
    if (!pickup.changed && !departure.changed && !dropoff.changed) {
      return assignment;
    }

    detectedAny = true;
    return {
      ...assignment,
      schedule: assignment.schedule.map((entry) =>
        entry.id === dropoff.entry.id ? dropoff.entry : entry,
      ),
    };
  });

  if (!detectedAny) {
    return trip;
  }
  const updated = { ...trip, vehicles };
  await saveTrip(updated);
  return updated;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const ip = request.headers.get('x-forwarded-for') ?? 'unknown';
    const limit = await tripLimiter.check(ip);
    if (!limit.allowed) {
      return Response.json(
        { error: 'Too many requests' },
        {
          status: 429,
          headers: {
            'Retry-After': String(Math.ceil((limit.retryAfterMs ?? 60_000) / 1000)),
          },
        },
      );
    }

    // Phase 6's principle: malformed tokens get the exact same generic 404
    // as valid-shaped-but-unknown ones (shape gate first, before any Redis
    // lookup), so the response never distinguishes "almost valid" from
    // "wrong".
    const { token } = await params;
    if (!isUuidShaped(token)) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const trip = await getTripByToken(token);
    if (!trip) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    // Phase N3: gate on the trip's active window exactly like /track does.
    // Pre-N3 trips have NO window fields — absence means "always active"
    // (the no-migration backward-compat case): skip gating entirely and
    // serve the full response as before. When both are present, the same
    // getWindowStatus/WINDOW_MESSAGES the tracking-link endpoint uses
    // decides — and, like /track, outside the window we return the minimal
    // status-only shape and never touch the live/roster layer, so no
    // vehicle or schedule data leaks before or after the window.
    if (trip.windowStart !== undefined && trip.windowEnd !== undefined) {
      const status = getWindowStatus(trip.windowStart, trip.windowEnd);
      if (status === 'not_started' || status === 'ended') {
        return Response.json({ status, message: WINDOW_MESSAGES[status] });
      }
    }

    // In-window (or a pre-N3 always-active trip): everything lives on the
    // trip itself now — no separate route to go missing, so a resolved
    // token always yields a full response.
    //
    // Phase N7's WRITE step runs first, on the active window only (the
    // not_started/ended branches above returned already, and deliberately
    // never touch the live layer at all). The response is then built from
    // whatever this step produced, so a detection made on this request
    // shows up on this request — not one 30-second poll later.
    return Response.json(
      await buildTripDetailResponse(await applyPickupDetection(trip)),
    );
  } catch (error) {
    console.error('trip detail route failed:', error);
    return Response.json(
      { error: 'Unable to fetch trip data' },
      { status: 502 },
    );
  }
}
