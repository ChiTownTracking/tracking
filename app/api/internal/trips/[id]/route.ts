import { isUuidShaped } from '@/lib/trackingTokens';
import { deleteTrip, getTrip } from '@/lib/tripsStore';

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
