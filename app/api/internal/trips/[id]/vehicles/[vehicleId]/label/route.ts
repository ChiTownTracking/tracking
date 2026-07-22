import { z } from 'zod';
import { isUuidShaped } from '@/lib/trackingTokens';
import { getTrip, saveTrip } from '@/lib/tripsStore';

// Staff-only (proxy.ts matches /api/internal/:path*). Phase N4: set or
// clear one vehicle's customer-facing card label ("Route A", shown before
// the vehicle number on the public trip card).
//
// Deliberately its OWN route, not folded into cancel/replace: those are
// service-disruption actions with their own semantics (and, in the UI, a
// confirmation step). A card label is a persistent display setting with no
// disruption meaning, so it gets a plain, friction-free endpoint.
//
// null or an empty/whitespace-only string CLEARS the label — the field is
// removed entirely rather than stored as '', matching the file's
// absent-means-normal convention.
const labelInputSchema = z.object({
  cardLabel: z.string().max(40).nullable(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; vehicleId: string }> },
) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = labelInputSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: 'cardLabel must be a string or null' },
        { status: 400 },
      );
    }
    // Trim here (not in the schema) so the length cap above measures the
    // raw input, and so a whitespace-only value collapses to a clear.
    const trimmed = parsed.data.cardLabel?.trim() ?? '';

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

    const vehicles = trip.vehicles.map((assignment) => {
      if (assignment.vehicleId !== vehicleId) {
        return assignment;
      }
      // Rebuild without cardLabel, then re-add only when non-empty — an
      // empty/null input leaves the field absent, never stored as ''.
      const { cardLabel: _dropped, ...rest } = assignment;
      return trimmed.length > 0 ? { ...rest, cardLabel: trimmed } : rest;
    });

    await saveTrip({ ...trip, vehicles });
    return Response.json({ cardLabel: trimmed.length > 0 ? trimmed : null });
  } catch (error) {
    console.error('vehicle label route failed:', error);
    return Response.json(
      { error: 'Unable to update vehicle label' },
      { status: 502 },
    );
  }
}
