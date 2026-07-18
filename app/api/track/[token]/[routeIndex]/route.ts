import type { NextRequest } from 'next/server';
import { getLiveVehicles } from '@/lib/liveVehicles';
import { RedisRateLimiter } from '@/lib/rateLimiter';
import { getTrackingLink, isUuidShaped } from '@/lib/trackingTokens';
import { getWindowStatus, WINDOW_MESSAGES } from '@/lib/trackingWindow';

// Same limit AND same Redis key prefix as the bare /api/track/[token]
// endpoint: the two share one 30-requests-per-60s budget per IP, so
// splitting the customer experience across two endpoints doesn't hand an
// abuser a doubled allowance.
const trackingLimiter = new RedisRateLimiter(30, 60, 'ratelimit:track');

// routeIndex is a plain array index, not a secret — the 122-bit token is
// the credential, so no UUID-style shape gate applies to it. Digits only:
// negatives, fractions, exponent notation are malformed and must be
// indistinguishable from a wrong guess (see the 404 note below).
const ROUTE_INDEX_SHAPE = /^\d+$/;

// Phase 6's principle, applied to the index: malformed index, unknown
// token, a no-routes link (indexed URLs are meaningless for that shape),
// and an out-of-range index all get byte-identical 404s, so the response
// never distinguishes "almost valid" from "wrong".
function notFound(): Response {
  return Response.json({ error: 'Not found' }, { status: 404 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; routeIndex: string }> },
) {
  try {
    const ip = request.headers.get('x-forwarded-for') ?? 'unknown';
    if (!(await trackingLimiter.check(ip)).allowed) {
      return Response.json({ error: 'Too many requests' }, { status: 429 });
    }

    const { token, routeIndex } = await params;
    // Both shape gates run before any Redis lookup, mirroring the bare
    // endpoint's token handling.
    if (!isUuidShaped(token) || !ROUTE_INDEX_SHAPE.test(routeIndex)) {
      return notFound();
    }
    const link = await getTrackingLink(token);
    const route = link?.routes?.[Number(routeIndex)];
    if (!link || !route) {
      return notFound();
    }

    // THIS route's own window — never the link's top-level fields, which
    // for a routes link are only derived aggregates (see TrackingLink).
    // Sibling routes with different windows are independently gated.
    const status = getWindowStatus(route.windowStart, route.windowEnd);
    // Outside the window, don't call Quartix at all.
    if (status === 'not_started' || status === 'ended') {
      return Response.json({ status, message: WINDOW_MESSAGES[status] });
    }

    const vehicles = await getLiveVehicles(route.vehicleIds);
    // Don't trust Quartix's VehicleIDList filtering — the same rule the
    // bare endpoint applies at the link level, enforced here at the route
    // level: only THIS route's vehicles may ever reach this page, even if
    // a sibling route on the same link was granted others.
    const allowedIds = new Set(route.vehicleIds);
    const routeVehicles = vehicles.filter((vehicle) =>
      allowedIds.has(vehicle.vehicleId),
    );
    return Response.json({
      status: 'active',
      customerName: link.customerName,
      // The route's own name: lets any consumer (the standalone indexed
      // page, screen readers) identify the leg without the tab UI that
      // usually surrounds this data. Active-state only, like everything
      // else here.
      name: route.name,
      vehicles: routeVehicles,
      waypoints: route.waypoints,
      route: route.route,
      schedule: route.schedule,
    });
  } catch (error) {
    console.error('per-route track endpoint failed:', error);
    return Response.json(
      { error: 'Unable to fetch tracking data' },
      { status: 502 },
    );
  }
}
