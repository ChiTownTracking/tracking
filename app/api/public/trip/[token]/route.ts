import type { NextRequest } from 'next/server';
import { RedisRateLimiter } from '@/lib/rateLimiter';
import { isUuidShaped } from '@/lib/trackingTokens';
import { buildTripDetailResponse } from '@/lib/tripDetail';
import { getTripByToken } from '@/lib/tripsStore';

// The per-trip public surface — a trip token resolves its own trip's
// detail: the shared path plus EVERY assigned vehicle's live progress and
// run schedule (Phase I1's multi-vehicle shape). Outside proxy.ts's
// matchers by design; the token is the gate, never a session.

// Own budget, own prefix — this surface's traffic shouldn't share (or
// drain) the route board's allowance. 30/60s stays the starting point.
const tripLimiter = new RedisRateLimiter(30, 60, 'ratelimit:trip');

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

    // Everything lives on the trip itself now — no separate route to go
    // missing, so a resolved token always yields a full response.
    return Response.json(await buildTripDetailResponse(trip));
  } catch (error) {
    console.error('trip detail route failed:', error);
    return Response.json(
      { error: 'Unable to fetch trip data' },
      { status: 502 },
    );
  }
}
