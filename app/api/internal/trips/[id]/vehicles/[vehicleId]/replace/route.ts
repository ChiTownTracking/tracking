import { z } from 'zod';
import { getTripStatus } from '@/lib/scheduleStatus';
import { isUuidShaped } from '@/lib/trackingTokens';
import type { ScheduleEntry } from '@/lib/trips';
import { getTrip, saveTrip } from '@/lib/tripsStore';
import { getVehicleRoster } from '@/lib/vehicleRoster';

// Staff-only (proxy.ts matches /api/internal/:path*). Phase L1: move the
// rest of one vehicle's day to a different vehicle. Every genuinely
// UPCOMING, not-already-cancelled run moves — arrival times and waits
// copied verbatim, no new timing logic — while completed/in-progress/
// cancelled runs stay on the original assignment exactly as they were:
// that history preservation is the guarantee, not an optimization. The
// serviceNote (when provided) lands on the ORIGINAL vehicle, where the
// "why service moved off it" explanation belongs.

const replaceInputSchema = z.object({
  replacementVehicleId: z.string().min(1),
  note: z.string().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; vehicleId: string }> },
) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = replaceInputSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: 'replacementVehicleId is required' },
        { status: 400 },
      );
    }
    const { replacementVehicleId, note } = parsed.data;

    const { id, vehicleId } = await params;
    if (!isUuidShaped(id)) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const trip = await getTrip(id);
    if (!trip) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const original = trip.vehicles.find((v) => v.vehicleId === vehicleId);
    if (!original) {
      return Response.json(
        { error: `Vehicle ${vehicleId} is not assigned to this trip.` },
        { status: 404 },
      );
    }
    if (replacementVehicleId === vehicleId) {
      return Response.json(
        { error: 'Replacement must be a different vehicle.' },
        { status: 400 },
      );
    }
    // Same roster check as trip creation: never trust a client-supplied
    // vehicle id.
    const roster = await getVehicleRoster();
    if (!roster.some((v) => v.vehicleId === replacementVehicleId)) {
      return Response.json(
        { error: `Vehicle ${replacementVehicleId} does not exist.` },
        { status: 400 },
      );
    }

    const now = new Date();
    const moved: ScheduleEntry[] = [];
    const retained: ScheduleEntry[] = [];
    for (const entry of original.schedule) {
      // Same status window as everywhere else: arrival + wait + the
      // trip's driving duration.
      const isUpcoming =
        !entry.cancelled &&
        getTripStatus(
          entry.arrivalTime,
          entry.waitMinutes * 60 + trip.totalDurationSeconds,
          now,
        ) === 'upcoming';
      (isUpcoming ? moved : retained).push(entry);
    }

    const replacementExists = trip.vehicles.some(
      (v) => v.vehicleId === replacementVehicleId,
    );
    let vehicles = trip.vehicles.map((assignment) => {
      if (assignment.vehicleId === vehicleId) {
        // History stays put; only the moved runs leave. May legitimately
        // end up with an empty schedule (see the VehicleAssignment note in
        // lib/trips.ts).
        return {
          ...assignment,
          schedule: retained,
          ...(note !== undefined ? { serviceNote: note } : {}),
        };
      }
      if (
        assignment.vehicleId === replacementVehicleId &&
        moved.length > 0
      ) {
        // One assignment per vehicle per trip — append, never a second
        // assignment for the same vehicle.
        return { ...assignment, schedule: [...assignment.schedule, ...moved] };
      }
      return assignment;
    });
    if (!replacementExists && moved.length > 0) {
      vehicles = [
        ...vehicles,
        { vehicleId: replacementVehicleId, schedule: moved },
      ];
    }

    await saveTrip({ ...trip, vehicles });
    return Response.json({ movedCount: moved.length });
  } catch (error) {
    console.error('replace vehicle route failed:', error);
    return Response.json(
      { error: 'Unable to replace vehicle' },
      { status: 502 },
    );
  }
}
