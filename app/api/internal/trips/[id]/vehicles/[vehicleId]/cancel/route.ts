import { z } from 'zod';
import { getTripStatus } from '@/lib/scheduleStatus';
import { isUuidShaped } from '@/lib/trackingTokens';
import { getTrip, saveTrip } from '@/lib/tripsStore';

// Staff-only (proxy.ts matches /api/internal/:path*). Phase L1: cancel the
// rest of one vehicle's day on a trip. Only runs that are genuinely still
// UPCOMING (by the same clock math tripDetail/scheduleEntry already use:
// arrival + wait + the trip's driving duration) flip to cancelled: true —
// completed and in-progress runs are history and stay exactly as they are,
// and already-cancelled runs stay cancelled (idempotent). Zero flips is a
// successful no-op, not an error.

const cancelInputSchema = z.object({
  note: z.string().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; vehicleId: string }> },
) {
  try {
    // A bodyless PATCH is valid (note is optional) — treat it as {}.
    const body = await request.json().catch(() => ({}));
    const parsed = cancelInputSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: 'note must be a string' },
        { status: 400 },
      );
    }
    const note = parsed.data.note;

    const { id, vehicleId } = await params;
    if (!isUuidShaped(id)) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const trip = await getTrip(id);
    if (!trip) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    if (!trip.vehicles.some((v) => v.vehicleId === vehicleId)) {
      return Response.json(
        { error: `Vehicle ${vehicleId} is not assigned to this trip.` },
        { status: 404 },
      );
    }

    const now = new Date();
    let cancelledCount = 0;
    const vehicles = trip.vehicles.map((assignment) => {
      if (assignment.vehicleId !== vehicleId) {
        return assignment;
      }
      const schedule = assignment.schedule.map((entry) => {
        if (entry.cancelled) {
          return entry;
        }
        // Same status window as everywhere else: a run's in-progress span
        // includes its own pickup wait plus the trip's driving duration.
        const status = getTripStatus(
          entry.arrivalTime,
          entry.waitMinutes * 60 + trip.totalDurationSeconds,
          now,
        );
        if (status !== 'upcoming') {
          return entry;
        }
        cancelledCount += 1;
        return { ...entry, cancelled: true };
      });
      return {
        ...assignment,
        schedule,
        // A provided note overwrites; an omitted one leaves any existing
        // note alone.
        ...(note !== undefined ? { serviceNote: note } : {}),
      };
    });

    await saveTrip({ ...trip, vehicles });
    return Response.json({ cancelledCount });
  } catch (error) {
    console.error('cancel vehicle route failed:', error);
    return Response.json(
      { error: 'Unable to cancel vehicle runs' },
      { status: 502 },
    );
  }
}
