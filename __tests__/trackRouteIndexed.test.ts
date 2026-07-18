import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { Vehicle } from '@/lib/liveVehicles';
import type { NamedRoute, TrackingLink } from '@/lib/trackingTokens';

const { limitMock, slidingWindowCalls } = vi.hoisted(() => ({
  limitMock: vi.fn(),
  // Plain array, not a mock: it survives clearAllMocks, so the one-time lazy
  // Ratelimit construction stays observable regardless of test order.
  slidingWindowCalls: [] as Array<[number, string]>,
}));

vi.mock('@upstash/ratelimit', () => {
  class Ratelimit {
    static slidingWindow(maxAttempts: number, window: string) {
      slidingWindowCalls.push([maxAttempts, window]);
      return { maxAttempts, window };
    }
    limit(key: string) {
      return limitMock(key);
    }
  }
  return { Ratelimit };
});

vi.mock('@/lib/redisClient', () => ({
  getRedis: () => ({}),
}));

// isUuidShaped stays real — the token-shape gate is under test here too.
vi.mock('@/lib/trackingTokens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trackingTokens')>();
  return { ...actual, getTrackingLink: vi.fn() };
});

vi.mock('@/lib/liveVehicles', () => ({
  getLiveVehicles: vi.fn(),
}));

import { GET } from '@/app/api/track/[token]/[routeIndex]/route';
import { getLiveVehicles } from '@/lib/liveVehicles';
import { getTrackingLink } from '@/lib/trackingTokens';

const TOKEN = 'a1b2c3d4-1111-4222-8333-abcdefabcdef';
const HOUR = 60 * 60 * 1000;

function makeRequest(): NextRequest {
  return new Request(`http://localhost/api/track/${TOKEN}/0`, {
    headers: { 'x-forwarded-for': '1.2.3.4' },
  }) as unknown as NextRequest;
}

function makeParams(
  token: string,
  routeIndex: string,
): { params: Promise<{ token: string; routeIndex: string }> } {
  return { params: Promise.resolve({ token, routeIndex }) };
}

function namedRoute(overrides: Partial<NamedRoute>): NamedRoute {
  const now = Date.now();
  return {
    name: 'North Loop',
    vehicleIds: ['1000067169'],
    windowStart: new Date(now - HOUR).toISOString(),
    windowEnd: new Date(now + HOUR).toISOString(),
    waypoints: [
      { label: 'Chicago Union Station', lat: 41.878988, lng: -87.639732 },
      { label: 'Wrigley Field', lat: 41.948437, lng: -87.655334 },
    ],
    route: {
      geometry: [
        [41.878988, -87.639704],
        [41.949033, -87.655348],
      ] as [number, number][],
      distanceMeters: 9489.6,
      durationSeconds: 917.9,
    },
    schedule: ['07:00', '14:30'],
    ...overrides,
  };
}

// The stored top-level fields on a routes link are derived aggregates
// (union of vehicles, min/max of windows) — the fixtures set them exactly
// as creation would, so a test can prove the endpoint ignores them.
function routesLink(routes: NamedRoute[]): TrackingLink {
  return {
    vehicleIds: [...new Set(routes.flatMap((route) => route.vehicleIds))],
    customerName: 'Smith Wedding',
    windowStart: routes
      .map((route) => route.windowStart)
      .reduce((min, value) => (value < min ? value : min)),
    windowEnd: routes
      .map((route) => route.windowEnd)
      .reduce((max, value) => (value > max ? value : max)),
    routes,
  };
}

function noRoutesLink(): TrackingLink {
  const now = Date.now();
  return {
    vehicleIds: ['1000067169'],
    customerName: 'Smith Wedding',
    windowStart: new Date(now - HOUR).toISOString(),
    windowEnd: new Date(now + HOUR).toISOString(),
  };
}

function vehicle(vehicleId: string): Vehicle {
  return {
    vehicleId,
    registrationNumber: `TRLY-${vehicleId.slice(-4)}`,
    description: 'Trolley',
    iconUrl: '',
    latitude: 41.88,
    longitude: -87.63,
    heading: 90,
    speed: 12,
    locationText: 'Michigan Ave',
    lastUpdatedAt: new Date().toISOString(),
  };
}

describe('GET /api/track/[token]/[routeIndex]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockResolvedValue({
      success: true,
      limit: 30,
      remaining: 29,
      reset: Date.now() + 60_000,
    });
  });

  // THE vehicle-exposure regression test for E3b: two routes on one link,
  // each granted a different vehicle. Even when the upstream response
  // contains BOTH grants (plus a stranger), route 0's endpoint must only
  // ever return route 0's vehicle — Phase 6's original HIGH fix, applied at
  // the route level instead of the link level.
  it('returns only the requested route\'s own vehicles, never a sibling route\'s', async () => {
    vi.mocked(getTrackingLink).mockResolvedValue(
      routesLink([
        namedRoute({ name: 'North Loop', vehicleIds: ['1000067169'] }),
        namedRoute({ name: 'South Loop', vehicleIds: ['1000074171'] }),
      ]),
    );
    vi.mocked(getLiveVehicles).mockResolvedValue([
      vehicle('1000067169'),
      vehicle('1000074171'),
      vehicle('9999999999'),
    ]);

    const response = await GET(makeRequest(), makeParams(TOKEN, '0'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('active');
    expect(body.vehicles.map((v: Vehicle) => v.vehicleId)).toEqual([
      '1000067169',
    ]);
    // And the upstream request itself only asks for this route's grant.
    expect(getLiveVehicles).toHaveBeenCalledWith(['1000067169']);
  });

  // The window-correctness fix: each route is gated by its OWN window, so
  // sibling routes on one link can be in three different states at the same
  // moment. The link-level aggregate (min start / max end) spans all three
  // and would report every route "active" — proving it is not consulted.
  it('gates each route by its own window: ended, active, and not_started siblings coexist', async () => {
    const now = Date.now();
    vi.mocked(getTrackingLink).mockResolvedValue(
      routesLink([
        namedRoute({
          name: 'Morning',
          windowStart: new Date(now - 3 * HOUR).toISOString(),
          windowEnd: new Date(now - 2 * HOUR).toISOString(),
        }),
        namedRoute({
          name: 'Midday',
          windowStart: new Date(now - HOUR).toISOString(),
          windowEnd: new Date(now + HOUR).toISOString(),
        }),
        namedRoute({
          name: 'Evening',
          windowStart: new Date(now + 2 * HOUR).toISOString(),
          windowEnd: new Date(now + 3 * HOUR).toISOString(),
        }),
      ]),
    );
    vi.mocked(getLiveVehicles).mockResolvedValue([vehicle('1000067169')]);

    const ended = await (await GET(makeRequest(), makeParams(TOKEN, '0'))).json();
    const active = await (await GET(makeRequest(), makeParams(TOKEN, '1'))).json();
    const notStarted = await (
      await GET(makeRequest(), makeParams(TOKEN, '2'))
    ).json();

    expect(ended.status).toBe('ended');
    expect(active.status).toBe('active');
    expect(notStarted.status).toBe('not_started');
  });

  it('returns the requested route\'s waypoints, geometry, and schedule — not a sibling\'s', async () => {
    const southWaypoints = [
      { label: 'Museum Campus', lat: 41.8663, lng: -87.6167 },
      { label: 'Hyde Park', lat: 41.7943, lng: -87.5907 },
    ];
    vi.mocked(getTrackingLink).mockResolvedValue(
      routesLink([
        namedRoute({ name: 'North Loop' }),
        namedRoute({
          name: 'South Loop',
          waypoints: southWaypoints,
          schedule: ['09:15'],
        }),
      ]),
    );
    vi.mocked(getLiveVehicles).mockResolvedValue([vehicle('1000067169')]);

    const body = await (await GET(makeRequest(), makeParams(TOKEN, '1'))).json();

    expect(body.status).toBe('active');
    expect(body.customerName).toBe('Smith Wedding');
    expect(body.waypoints).toEqual(southWaypoints);
    expect(body.schedule).toEqual(['09:15']);
    expect(body.route.distanceMeters).toBe(9489.6);
  });

  // Asserted against a 2-route link (and the non-default index) so a
  // hardcoded or sibling name can't pass trivially.
  it('includes the requested route\'s own name in the active response', async () => {
    vi.mocked(getTrackingLink).mockResolvedValue(
      routesLink([
        namedRoute({ name: 'North Loop' }),
        namedRoute({ name: 'South Loop' }),
      ]),
    );
    vi.mocked(getLiveVehicles).mockResolvedValue([vehicle('1000067169')]);

    const body = await (await GET(makeRequest(), makeParams(TOKEN, '1'))).json();

    expect(body.status).toBe('active');
    expect(body.name).toBe('South Loop');
  });

  // Minimal disclosure outside the window, same as the bare endpoint: status
  // and message only, and Quartix is never called.
  it('returns only status and message outside the window, without calling Quartix', async () => {
    const now = Date.now();
    vi.mocked(getTrackingLink).mockResolvedValue(
      routesLink([
        namedRoute({
          windowStart: new Date(now + HOUR).toISOString(),
          windowEnd: new Date(now + 2 * HOUR).toISOString(),
        }),
      ]),
    );

    const body = await (await GET(makeRequest(), makeParams(TOKEN, '0'))).json();

    expect(Object.keys(body).sort()).toEqual(['message', 'status']);
    expect(body.status).toBe('not_started');
    expect(getLiveVehicles).not.toHaveBeenCalled();
  });

  // All the "almost valid" shapes collapse into the one 404 an entirely
  // wrong token gets — the response never narrows a guess.
  it('returns identical 404s for wrong token, bad index shapes, out-of-range index, and no-routes links', async () => {
    vi.mocked(getTrackingLink).mockImplementation(async (token: string) =>
      token === TOKEN
        ? routesLink([namedRoute({}), namedRoute({ name: 'South Loop' })])
        : null,
    );

    const wrongToken = await GET(
      makeRequest(),
      makeParams('b1b2c3d4-1111-4222-8333-abcdefabcdef', '0'),
    );
    const nonNumeric = await GET(makeRequest(), makeParams(TOKEN, 'abc'));
    const negative = await GET(makeRequest(), makeParams(TOKEN, '-1'));
    const fractional = await GET(makeRequest(), makeParams(TOKEN, '1.5'));
    const outOfRange = await GET(makeRequest(), makeParams(TOKEN, '2'));

    vi.mocked(getTrackingLink).mockResolvedValue(noRoutesLink());
    const noRoutes = await GET(makeRequest(), makeParams(TOKEN, '0'));

    const baseline = await wrongToken.json();
    for (const response of [nonNumeric, negative, fractional, outOfRange, noRoutes]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(baseline);
    }
    expect(wrongToken.status).toBe(404);
  });

  it('rejects a malformed token with 404 before any Redis lookup', async () => {
    const response = await GET(
      makeRequest(),
      makeParams("not-a-uuid'; DROP TABLE", '0'),
    );

    expect(response.status).toBe(404);
    expect(getTrackingLink).not.toHaveBeenCalled();
  });

  it('rejects a malformed route index with 404 before any Redis lookup', async () => {
    const response = await GET(makeRequest(), makeParams(TOKEN, '0x1'));

    expect(response.status).toBe(404);
    expect(getTrackingLink).not.toHaveBeenCalled();
  });

  it('returns 429 without touching the token store when the limiter blocks the IP', async () => {
    limitMock.mockResolvedValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 30_000,
    });

    const response = await GET(makeRequest(), makeParams(TOKEN, '0'));

    expect(response.status).toBe(429);
    expect(getTrackingLink).not.toHaveBeenCalled();
  });

  it('shares the bare endpoint\'s 30-per-60s limit, keyed by IP', async () => {
    vi.mocked(getTrackingLink).mockResolvedValue(null);

    await GET(makeRequest(), makeParams(TOKEN, '0'));

    expect(slidingWindowCalls).toContainEqual([30, '60 s']);
    expect(limitMock).toHaveBeenCalledWith('1.2.3.4');
  });
});
