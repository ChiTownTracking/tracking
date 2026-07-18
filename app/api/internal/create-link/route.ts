import { createLinkInputSchema } from '@/lib/createLinkInput';
import { googleMapsClient } from '@/lib/googleMapsClient';
import {
  createTrackingLink,
  type NamedRoute,
  type TrackingLink,
} from '@/lib/trackingTokens';
import { getVehicleRoster } from '@/lib/vehicleRoster';

// COMPLIANCE: the route geometry stored and served from here is Google Maps
// Content and, per Google's Maps Service Specific Terms, must only be
// displayed on a Google Map. Every map in the app renders on Google Maps as
// of Phase J4 — keep it that way: rendering this data on any non-Google map
// reopens the violation.
//
// Staff-only (proxy.ts matches /api/internal/:path*).
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (body === null) {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsed = createLinkInputSchema.safeParse(body);
    if (!parsed.success) {
      // Clean message only — no raw zod internals in the response.
      const error = parsed.error.issues
        .map((issue) =>
          issue.path.length > 0
            ? `${issue.path.join('.')}: ${issue.message}`
            : issue.message,
        )
        .join('; ');
      return Response.json({ error }, { status: 400 });
    }

    // Don't trust the client's vehicle list — every ID must exist in the
    // current roster. In routes mode each route's own vehicleIds are checked
    // (and errors name the route); the top-level fields are meaningless
    // there and get no roster check at all.
    const roster = await getVehicleRoster();
    const knownIds = new Set(roster.map((vehicle) => vehicle.vehicleId));
    const { routes: routesInput, ...linkBase } = parsed.data;
    const hasRoutes = routesInput !== undefined && routesInput.length > 0;
    if (hasRoutes) {
      const rosterErrors = routesInput.flatMap((routeInput) =>
        routeInput.vehicleIds
          .filter((id) => !knownIds.has(id))
          .map((id) => `${routeInput.name}: vehicle ${id} does not exist.`),
      );
      if (rosterErrors.length > 0) {
        return Response.json(
          { error: rosterErrors.join(' ') },
          { status: 400 },
        );
      }
    } else {
      const unknownIds = (linkBase.vehicleIds ?? []).filter(
        (id) => !knownIds.has(id),
      );
      if (unknownIds.length > 0) {
        return Response.json(
          { error: `Unknown vehicle id(s): ${unknownIds.join(', ')}` },
          { status: 400 },
        );
      }
    }

    // Route geometry is computed BEFORE the link is written — one routing
    // call per named route, in submitted order. If ANY route fails, no link
    // exists at all: never a half-saved one, even when an earlier route in
    // the loop already succeeded.
    //
    // TODO(post-J3): ORS had a confirmed unroutable-point error shape
    // (OrsUnroutablePointError) that produced an actionable 400 naming the
    // failing route. No Google equivalent has been captured yet, so every
    // getRoute() failure currently falls through to the generic outer catch
    // → 502 — same "don't guess the error shape" discipline as everything
    // else. Restore the actionable 400 once a real unroutable-point response
    // from Google has actually been captured and reviewed.
    let routes: NamedRoute[] | undefined;
    if (hasRoutes) {
      routes = [];
      for (const routeInput of routesInput) {
        const result = await googleMapsClient.getRoute(
          routeInput.waypoints.map((waypoint) => ({
            lat: waypoint.lat,
            lng: waypoint.lng,
          })),
        );
        routes.push({
          name: routeInput.name,
          vehicleIds: routeInput.vehicleIds,
          windowStart: routeInput.windowStart,
          windowEnd: routeInput.windowEnd,
          waypoints: routeInput.waypoints,
          schedule: routeInput.schedule,
          route: {
            geometry: result.geometry,
            distanceMeters: result.distanceMeters,
            durationSeconds: result.durationSeconds,
          },
        });
      }
    }

    const token = crypto.randomUUID();
    let link: TrackingLink;
    if (routes) {
      // Routes mode: top-level fields are IGNORED by readers (each route
      // governs itself) — store derived aggregates purely so the stored
      // shape stays uniform: union of route vehicles, min/max of route
      // windows. Not a source of truth.
      link = {
        customerName: linkBase.customerName,
        vehicleIds: [...new Set(routes.flatMap((route) => route.vehicleIds))],
        windowStart: routes
          .map((route) => route.windowStart)
          .reduce((a, b) => (new Date(a) <= new Date(b) ? a : b)),
        windowEnd: routes
          .map((route) => route.windowEnd)
          .reduce((a, b) => (new Date(a) >= new Date(b) ? a : b)),
        routes,
      };
    } else {
      const { vehicleIds, windowStart, windowEnd } = linkBase;
      if (!vehicleIds || !windowStart || !windowEnd) {
        // Unreachable: the schema requires all three when no routes exist.
        throw new Error('missing top-level fields on a no-routes link');
      }
      link = {
        customerName: linkBase.customerName,
        vehicleIds,
        windowStart,
        windowEnd,
      };
    }
    await createTrackingLink(token, link);
    return Response.json({ token, url: `/track/${token}` });
  } catch (error) {
    console.error('create-link route failed:', error);
    return Response.json(
      { error: 'Unable to create tracking link' },
      { status: 502 },
    );
  }
}
