import type { NextRequest } from 'next/server';
import { getLiveVehicles } from '@/lib/liveVehicles';
import { RedisRateLimiter } from '@/lib/rateLimiter';
import { getTrackingLink, isUuidShaped } from '@/lib/trackingTokens';
import { getWindowStatus, WINDOW_MESSAGES } from '@/lib/trackingWindow';

// Public endpoint — deliberately outside proxy.ts's matchers. The limiter
// here caps abuse/cost (a stuck client, a scraper), NOT token guessing:
// tokens are 122-bit random UUIDs, so brute-forcing one is computationally
// infeasible with or without rate limiting. A legitimate customer polling
// every 30s uses ~2 requests/minute; 30/minute is generous headroom.
const trackingLimiter = new RedisRateLimiter(30, 60, 'ratelimit:track');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const ip = request.headers.get('x-forwarded-for') ?? 'unknown';
    if (!(await trackingLimiter.check(ip)).allowed) {
      return Response.json({ error: 'Too many requests' }, { status: 429 });
    }

    const { token } = await params;
    // Malformed tokens get the exact same 404 as unknown ones: a different
    // response would let a caller tell valid-shaped-but-wrong from garbage.
    if (!isUuidShaped(token)) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const link = await getTrackingLink(token);
    if (!link) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    // Phase E3b: for a routes link, this endpoint is only a directory —
    // route names for building links to /track/[token]/[routeIndex], where
    // each route's own window/vehicle logic runs. No window gating here:
    // there's no vehicle or location data to protect, just low-sensitivity
    // staff-chosen labels. The top-level window/vehicle fields are derived
    // aggregates on these links and are deliberately never consulted.
    if (link.routes) {
      return Response.json({
        routes: link.routes.map((route, index) => ({
          index,
          name: route.name,
        })),
      });
    }

    const status = getWindowStatus(link.windowStart, link.windowEnd);
    // Outside the window, don't call Quartix at all.
    if (status === 'not_started' || status === 'ended') {
      return Response.json({ status, message: WINDOW_MESSAGES[status] });
    }

    const vehicles = await getLiveVehicles(link.vehicleIds);
    // Don't trust Quartix's VehicleIDList filtering: only vehicles this link
    // was created for may ever reach the customer, even if the upstream
    // response includes extras.
    const allowedIds = new Set(link.vehicleIds);
    const linkedVehicles = vehicles.filter((vehicle) =>
      allowedIds.has(vehicle.vehicleId),
    );
    // Legacy links may still carry old flat waypoints/route fields in
    // Redis — those are never exposed.
    return Response.json({
      status: 'active',
      customerName: link.customerName,
      vehicles: linkedVehicles,
    });
  } catch (error) {
    console.error('track route failed:', error);
    return Response.json(
      { error: 'Unable to fetch tracking data' },
      { status: 502 },
    );
  }
}
