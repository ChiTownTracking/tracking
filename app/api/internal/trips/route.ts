import { computeDepartureClock } from '@/lib/departureTime';
import {
  googleMapsClient,
  type GoogleRouteResult,
} from '@/lib/googleMapsClient';
import { nextOccurrenceOf } from '@/lib/nextOccurrence';
import { createTripInputSchema, formatInputIssues } from '@/lib/tripInput';
import type { Trip } from '@/lib/trips';
import { createTrip, listTrips } from '@/lib/tripsStore';
import { getVehicleRoster } from '@/lib/vehicleRoster';

// COMPLIANCE: the geometry/legs/totals stored and served from here are
// Google Maps Content and, per Google's Maps Service Specific Terms, must
// only be displayed on a Google Map. Every map in the app renders on Google
// Maps as of Phase J4 — keep it that way: rendering this data on any
// non-Google map reopens the violation.
//
// Staff-only (proxy.ts matches /api/internal/:path*). Phase I1: THE one
// trip-creation endpoint — the old routes / create-with-trip pair is gone.
// One POST makes one Trip: one physical path, any number of vehicles, each
// with its own runs, one shareable /trip/[token] link.

// Trip's stored shape — and everything reading it (liveProgress → tripEta,
// the trip map UI) — still speaks ORS-style legBoundaryIndices: the index
// into the whole-route geometry where each waypoint sits. Google doesn't
// return that; it returns each leg's OWN geometry instead. Both real
// captures (__fixtures__/googleRoute.json, googleRouteMultileg.json) confirm
// the route-level polyline is EXACTLY the leg polylines stitched end-to-end
// with the shared boundary point deduplicated (109+201 points → 309), so
// each boundary index is the running sum of (leg length - 1). The guard
// re-checks that stitching on every response and fails loudly rather than
// storing indices that would silently corrupt downstream ETA math.
function deriveLegBoundaryIndices(result: GoogleRouteResult): number[] {
  const indices = [0];
  let acc = 0;
  for (const leg of result.legs) {
    acc += leg.geometry.length - 1;
    indices.push(acc);
  }
  const mismatch =
    indices[indices.length - 1] !== result.geometry.length - 1 ||
    result.legs.some((leg, i) => {
      const [lat, lng] = leg.geometry[0];
      const boundary = result.geometry[indices[i]];
      return boundary[0] !== lat || boundary[1] !== lng;
    });
  if (mismatch) {
    throw new Error(
      'Google route geometry is not the stitch of its leg geometries — cannot derive legBoundaryIndices',
    );
  }
  return indices;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (body === null) {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsed = createTripInputSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: formatInputIssues(parsed.error) },
        { status: 400 },
      );
    }

    // EVERYTHING is validated before anything is created or any ORS call is
    // spent — same "don't half-save" discipline as always. Every vehicle is
    // checked and every failure named (accumulated, not first-only): fixing
    // a three-vehicle form one 400 at a time would be miserable.
    const roster = await getVehicleRoster();
    const rosterIds = new Set(roster.map((v) => v.vehicleId));
    const missingVehicles = parsed.data.vehicles
      .map((assignment) => assignment.vehicleId)
      .filter((vehicleId) => !rosterIds.has(vehicleId));
    if (missingVehicles.length > 0) {
      return Response.json(
        {
          error: missingVehicles
            .map((vehicleId) => `Vehicle ${vehicleId} does not exist.`)
            .join(' '),
        },
        { status: 400 },
      );
    }

    // ONE routing call for the whole trip — one physical path, shared by
    // every vehicle on it.
    //
    // TODO(post-J3): ORS had a confirmed unroutable-point error shape
    // (OrsUnroutablePointError) that produced an actionable 400 here. No
    // Google equivalent has been captured yet, so every getRoute() failure
    // currently falls through to the generic outer catch → 502 — same
    // "don't guess the error shape" discipline as everything else. Restore
    // the actionable 400 once a real unroutable-point response from Google
    // has actually been captured and reviewed.
    const result = await googleMapsClient.getRoute(
      parsed.data.waypoints.map((waypoint) => ({
        lat: waypoint.lat,
        lng: waypoint.lng,
      })),
    );

    // Phase K1: traffic-aware arrival prediction, ONE Google call per
    // DISTINCT departure clock time (arrival + wait) — several runs across
    // several vehicles sharing a departure time share one prediction.
    // First waypoint → last waypoint direct (no intermediates): this is
    // the single "estimated arrival at the final stop" number, not a
    // per-leg breakdown. Best-effort by design: a failed prediction is
    // logged server-side and that entry simply stores no prediction —
    // trip creation NEVER fails because of this block.
    // Both raw numbers from the ONE response per distinct departure —
    // stored exactly as Google returned them. The bus-vs-car buffer is a
    // display-time adjustment (lib/departureTime + tripEstimateConfig),
    // never baked into stored data: the record of what Google actually
    // said stays intact, separate from how we choose to present it.
    const departurePredictions = new Map<
      string,
      { predictedDurationSeconds: number; staticDurationSeconds: number }
    >();
    const distinctDepartureClocks = [
      ...new Set(
        parsed.data.vehicles.flatMap((assignment) =>
          assignment.schedule.map((entry) =>
            computeDepartureClock(entry.arrivalTime, entry.waitMinutes),
          ),
        ),
      ),
    ];
    const firstWaypoint = parsed.data.waypoints[0];
    const lastWaypoint =
      parsed.data.waypoints[parsed.data.waypoints.length - 1];
    await Promise.all(
      distinctDepartureClocks.map(async (departureClock) => {
        try {
          const prediction = await googleMapsClient.predictArrival(
            { lat: firstWaypoint.lat, lng: firstWaypoint.lng },
            { lat: lastWaypoint.lat, lng: lastWaypoint.lng },
            nextOccurrenceOf(departureClock, new Date()),
          );
          departurePredictions.set(departureClock, prediction);
        } catch (error) {
          console.error(
            `create-trip arrival prediction failed (${parsed.data.name}, departure ${departureClock}):`,
            error,
          );
        }
      }),
    );

    const trip: Trip = {
      id: crypto.randomUUID(),
      // The trip-link credential — same entropy/generation as tracking
      // tokens.
      token: crypto.randomUUID(),
      name: parsed.data.name,
      // Phase N3: the validated active window (windowEnd > windowStart,
      // enforced by the schema).
      windowStart: parsed.data.windowStart,
      windowEnd: parsed.data.windowEnd,
      waypoints: parsed.data.waypoints,
      geometry: result.geometry,
      // Explicitly strip each leg's geometry: Trip.legs stores timings only,
      // and Google's per-leg geometry (absent from the ORS shape) must not
      // silently bloat every stored trip via structural typing.
      legs: result.legs.map(({ distanceMeters, durationSeconds }) => ({
        distanceMeters,
        durationSeconds,
      })),
      legBoundaryIndices: deriveLegBoundaryIndices(result),
      totalDistanceMeters: result.distanceMeters,
      totalDurationSeconds: result.durationSeconds,
      vehicles: parsed.data.vehicles.map((assignment) => ({
        vehicleId: assignment.vehicleId,
        // Phase N4: store the card label only when it's a non-empty string
        // — a trimmed-to-empty value is absent, not stored as '', matching
        // the absent-means-normal convention.
        ...(assignment.cardLabel
          ? { cardLabel: assignment.cardLabel }
          : {}),
        schedule: assignment.schedule.map((entry) => {
          const predicted = departurePredictions.get(
            computeDepartureClock(entry.arrivalTime, entry.waitMinutes),
          );
          return {
            // Each run gets its own stable id — future per-run edits/links
            // need something to point at.
            id: crypto.randomUUID(),
            arrivalTime: entry.arrivalTime,
            waitMinutes: entry.waitMinutes,
            // Both absent (not zero/null) when the prediction call failed —
            // the fields' contract in lib/trips.ts.
            ...(predicted !== undefined
              ? {
                  predictedArrivalDurationSeconds:
                    predicted.predictedDurationSeconds,
                  predictedArrivalStaticDurationSeconds:
                    predicted.staticDurationSeconds,
                }
              : {}),
          };
        }),
      })),
      createdAt: new Date().toISOString(),
    };
    await createTrip(trip);

    return Response.json({
      id: trip.id,
      token: trip.token,
      tripPath: `/trip/${trip.token}`,
    });
  } catch (error) {
    console.error('create-trip failed:', error);
    return Response.json({ error: 'Unable to create trip' }, { status: 502 });
  }
}

export async function GET() {
  try {
    const [trips, roster] = await Promise.all([listTrips(), getVehicleRoster()]);
    const rosterById = new Map(roster.map((v) => [v.vehicleId, v]));
    // List payload stays light: no geometry/legs (hundreds of points), just
    // what the staff table needs. Newest first.
    const rows = trips
      .map((trip) => ({
        id: trip.id,
        name: trip.name,
        stopCount: trip.waypoints.length,
        totalDistanceMeters: trip.totalDistanceMeters,
        totalDurationSeconds: trip.totalDurationSeconds,
        vehicles: trip.vehicles.map((assignment) => ({
          vehicleId: assignment.vehicleId,
          vehicleRegistration:
            rosterById.get(assignment.vehicleId)?.registrationNumber ??
            `(unknown ${assignment.vehicleId})`,
          runCount: assignment.schedule.length,
        })),
        token: trip.token,
        createdAt: trip.createdAt,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Response.json(rows);
  } catch (error) {
    console.error('list-trips failed:', error);
    return Response.json({ error: 'Unable to list trips' }, { status: 502 });
  }
}
