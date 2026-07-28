import { computeDepartureClock } from '@/lib/departureTime';
import { isUuidShaped } from '@/lib/trackingTokens';
import {
  formatInputIssues,
  vehicleAssignmentInputSchema,
} from '@/lib/tripInput';
import {
  type ClockPrediction,
  resolvePredictionsForClocks,
} from '@/lib/tripPredictionResolver';
import type { VehicleAssignment } from '@/lib/trips';
import { getTrip, saveTrip } from '@/lib/tripsStore';
import { getVehicleRoster } from '@/lib/vehicleRoster';

// Staff-only (proxy.ts matches /api/internal/:path*). Phase O2: put ANOTHER
// vehicle on an existing trip — same physical path, its own runs. The body
// is validated by the very schema creation uses for each of its vehicles
// (lib/tripInput), so "a valid assignment" means one thing whichever door
// it arrives through.
//
// The trip's route geometry is deliberately NOT recomputed: the path is a
// property of the trip, not of who drives it, so adding a vehicle costs no
// routing call at all — only whatever arrival predictions its departure
// clocks genuinely need.
//
// ONE assignment per vehicle per trip is the invariant here. Replace
// already protects it from the other direction (it appends into the
// existing assignment rather than adding a second one); this endpoint
// refuses the duplicate outright and points staff at the schedule they
// already have.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = vehicleAssignmentInputSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: formatInputIssues(parsed.error) },
        { status: 400 },
      );
    }
    const { vehicleId, cardLabel, schedule } = parsed.data;

    const { id } = await params;
    if (!isUuidShaped(id)) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const trip = await getTrip(id);
    if (!trip) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    // Checked before the roster fetch: it needs nothing external, and it's
    // the more specific answer for staff who are looking at a vehicle
    // that's already right there on the trip.
    if (trip.vehicles.some((v) => v.vehicleId === vehicleId)) {
      return Response.json(
        {
          error: `Vehicle ${vehicleId} is already on this trip — edit its existing schedule instead.`,
        },
        { status: 400 },
      );
    }
    // Same roster check as trip creation and replace: never trust a
    // client-supplied vehicle id.
    const roster = await getVehicleRoster();
    if (!roster.some((v) => v.vehicleId === vehicleId)) {
      return Response.json(
        { error: `Vehicle ${vehicleId} does not exist.` },
        { status: 400 },
      );
    }

    // Every departure clock the trip ALREADY has a prediction for. The new
    // vehicle's runs frequently mirror an existing vehicle's times (that's
    // usually why a second bus is added), so those clocks cost nothing.
    // Cancelled runs count here too: a prediction describes a departure
    // time, not whether someone ends up driving it.
    const existingClockPredictions = new Map<string, ClockPrediction>();
    for (const entry of trip.vehicles.flatMap(
      (assignment) => assignment.schedule,
    )) {
      if (
        entry.predictedArrivalDurationSeconds === undefined ||
        entry.predictedArrivalStaticDurationSeconds === undefined
      ) {
        continue;
      }
      const clock = computeDepartureClock(entry.arrivalTime, entry.waitMinutes);
      if (existingClockPredictions.has(clock)) {
        continue;
      }
      existingClockPredictions.set(clock, {
        predictedDurationSeconds: entry.predictedArrivalDurationSeconds,
        staticDurationSeconds: entry.predictedArrivalStaticDurationSeconds,
      });
    }

    const predictions = await resolvePredictionsForClocks(
      schedule.map((entry) =>
        computeDepartureClock(entry.arrivalTime, entry.waitMinutes),
      ),
      trip.waypoints[0],
      trip.waypoints[trip.waypoints.length - 1],
      existingClockPredictions,
      trip.name,
    );

    const assignment: VehicleAssignment = {
      vehicleId,
      // Stored only when non-empty — absent, never '', same as creation.
      ...(cardLabel ? { cardLabel } : {}),
      schedule: schedule.map((entry) => {
        // null (attempted, failed) and undefined (never asked) both leave
        // the fields ABSENT — the ScheduleEntry contract, and the same
        // never-block-on-Google convention creation follows.
        const predicted =
          predictions.get(
            computeDepartureClock(entry.arrivalTime, entry.waitMinutes),
          ) ?? null;
        return {
          // Each run gets its own stable id, exactly as at creation.
          id: crypto.randomUUID(),
          arrivalTime: entry.arrivalTime,
          waitMinutes: entry.waitMinutes,
          ...(predicted !== null
            ? {
                predictedArrivalDurationSeconds:
                  predicted.predictedDurationSeconds,
                predictedArrivalStaticDurationSeconds:
                  predicted.staticDurationSeconds,
              }
            : {}),
        };
      }),
    };

    await saveTrip({ ...trip, vehicles: [...trip.vehicles, assignment] });
    return Response.json({ vehicle: assignment });
  } catch (error) {
    console.error('add trip vehicle route failed:', error);
    return Response.json(
      { error: 'Unable to add vehicle to trip' },
      { status: 502 },
    );
  }
}
