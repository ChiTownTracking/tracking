import { isUuidShaped } from '@/lib/trackingTokens';
import {
  formatInputIssues,
  updateTripInputSchema,
  validateWindowOrdering,
} from '@/lib/tripInput';
import { deleteTrip, getTrip, saveTrip } from '@/lib/tripsStore';

// Staff-only (proxy.ts matches /api/internal/:path*). The FULL staff-side
// trip document — including token, real vehicle IDs, and raw stored fields
// — this is authenticated staff data, not the public minimal-disclosure
// shape served by /api/public/trip/[token].
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    // Trip ids are crypto.randomUUID()s — malformed ids never reach Redis
    // and get the same 404 as unknown ones, same convention as every
    // token-shaped param in the app.
    if (!isUuidShaped(id)) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const trip = await getTrip(id);
    if (!trip) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    return Response.json(trip);
  } catch (error) {
    console.error('trip detail (staff) route failed:', error);
    return Response.json(
      { error: 'Unable to fetch trip' },
      { status: 502 },
    );
  }
}

// Phase O1: edit a trip's name and/or active window after creation. Only
// these three fields — the physical path, its geometry, and every vehicle's
// runs are untouched here, so no routing or prediction call is spent (a
// name and a window change neither where the bus goes nor when it leaves).
// Same 404 conventions as the GET above.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = updateTripInputSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: formatInputIssues(parsed.error) },
        { status: 400 },
      );
    }

    const { id } = await params;
    if (!isUuidShaped(id)) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const trip = await getTrip(id);
    if (!trip) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    // Merge FIRST, validate second: a body carrying only windowEnd must be
    // checked against the window start the trip already has, not against
    // nothing. `??` is right here because both fields are optional-absent,
    // never legitimately null.
    const windowStart = parsed.data.windowStart ?? trip.windowStart;
    const windowEnd = parsed.data.windowEnd ?? trip.windowEnd;
    if (!validateWindowOrdering(windowStart, windowEnd)) {
      return Response.json(
        { error: 'windowEnd must be after windowStart' },
        { status: 400 },
      );
    }

    const updated = {
      ...trip,
      name: parsed.data.name ?? trip.name,
      // Spread-in only when defined, so a trip with no window keeps having
      // no window rather than gaining explicit undefined keys.
      ...(windowStart !== undefined ? { windowStart } : {}),
      ...(windowEnd !== undefined ? { windowEnd } : {}),
    };
    await saveTrip(updated);

    return Response.json({
      name: updated.name,
      windowStart: updated.windowStart,
      windowEnd: updated.windowEnd,
    });
  } catch (error) {
    console.error('trip update route failed:', error);
    return Response.json({ error: 'Unable to update trip' }, { status: 502 });
  }
}

// Phase M1: permanent deletion — the trip document, its listing, and its
// public /trip/[token] link all stop existing together (deleteTrip cleans
// the token reverse index too). Same 404 conventions as the GET above;
// same { ok: true } success shape as the links DELETE route.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!isUuidShaped(id)) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const trip = await getTrip(id);
    if (!trip) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    await deleteTrip(id);
    return Response.json({ ok: true });
  } catch (error) {
    console.error('trip delete route failed:', error);
    return Response.json(
      { error: 'Unable to delete trip' },
      { status: 502 },
    );
  }
}
