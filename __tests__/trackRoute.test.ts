import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { Vehicle } from '@/lib/liveVehicles';
import type { TrackingLink } from '@/lib/trackingTokens';

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

// isUuidShaped stays real — the route's token-shape gate is under test here.
vi.mock('@/lib/trackingTokens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trackingTokens')>();
  return { ...actual, getTrackingLink: vi.fn() };
});

vi.mock('@/lib/liveVehicles', () => ({
  getLiveVehicles: vi.fn(),
}));

import { GET } from '@/app/api/track/[token]/route';
import { getLiveVehicles } from '@/lib/liveVehicles';
import { getTrackingLink } from '@/lib/trackingTokens';

const TOKEN = 'a1b2c3d4-1111-4222-8333-abcdefabcdef';

function makeRequest(): NextRequest {
  return new Request(`http://localhost/api/track/${TOKEN}`, {
    headers: { 'x-forwarded-for': '1.2.3.4' },
  }) as unknown as NextRequest;
}

function makeParams(token: string): { params: Promise<{ token: string }> } {
  return { params: Promise.resolve({ token }) };
}

function activeLink(
  vehicleIds: string[],
  overrides: Partial<TrackingLink> = {},
): TrackingLink {
  const now = Date.now();
  return {
    vehicleIds,
    customerName: 'Smith Wedding',
    windowStart: new Date(now - 60 * 60 * 1000).toISOString(),
    windowEnd: new Date(now + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

const NAMED_ROUTES = [
  {
    name: 'North Loop',
    vehicleIds: ['1000067169'],
    windowStart: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    windowEnd: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
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
  },
  {
    name: 'South Loop',
    vehicleIds: ['1000074171'],
    windowStart: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    windowEnd: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    waypoints: [
      { label: 'Museum Campus', lat: 41.8663, lng: -87.6167 },
      { label: 'Hyde Park', lat: 41.7943, lng: -87.5907 },
    ],
    route: {
      geometry: [
        [41.866299, -87.616702],
        [41.794301, -87.590701],
      ] as [number, number][],
      distanceMeters: 11201.3,
      durationSeconds: 1104.6,
    },
    schedule: ['09:15'],
  },
];

// Legacy flat fields from before the named-routes schema change — some
// stored links still carry these in Redis.
const LEGACY_FIELDS = {
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
};

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

describe('GET /api/track/[token]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockResolvedValue({
      success: true,
      limit: 30,
      remaining: 29,
      reset: Date.now() + 60_000,
    });
  });

  // THE regression test for "don't just trust Quartix's VehicleIDList
  // filtering": even when the upstream response contains a vehicle the link
  // was never created for, it must not reach the customer.
  it('excludes vehicles not in link.vehicleIds even when getLiveVehicles returns them', async () => {
    vi.mocked(getTrackingLink).mockResolvedValue(
      activeLink(['1000067169', '1000074171']),
    );
    vi.mocked(getLiveVehicles).mockResolvedValue([
      vehicle('1000067169'),
      vehicle('1000074171'),
      vehicle('9999999999'),
    ]);

    const response = await GET(makeRequest(), makeParams(TOKEN));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('active');
    expect(body.vehicles.map((v: Vehicle) => v.vehicleId)).toEqual([
      '1000067169',
      '1000074171',
    ]);
  });

  it('rejects a token that is not UUID-shaped with 404, before any Redis lookup', async () => {
    const response = await GET(
      makeRequest(),
      makeParams("not-a-uuid'; DROP TABLE"),
    );

    expect(response.status).toBe(404);
    expect(getTrackingLink).not.toHaveBeenCalled();
  });

  it('returns an identical 404 for malformed and valid-shaped-but-unknown tokens', async () => {
    vi.mocked(getTrackingLink).mockResolvedValue(null);

    const malformed = await GET(makeRequest(), makeParams('garbage'));
    const unknown = await GET(makeRequest(), makeParams(TOKEN));

    expect(malformed.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await malformed.json()).toEqual(await unknown.json());
  });

  it('returns 429 without touching the token store when the limiter blocks the IP', async () => {
    limitMock.mockResolvedValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 30_000,
    });

    const response = await GET(makeRequest(), makeParams(TOKEN));

    expect(response.status).toBe(429);
    expect(getTrackingLink).not.toHaveBeenCalled();
  });

  // Phase E3b (ADAPTED from the E2-era "includes routes in the active-window
  // response" test): the bare endpoint is now only a directory for a routes
  // link — index + name per route, nothing else. Full route data lives at
  // /api/track/[token]/[routeIndex].
  it('returns only a name directory for a routes link — no vehicles, windows, or route data', async () => {
    vi.mocked(getTrackingLink).mockResolvedValue(
      activeLink(['1000067169'], { routes: NAMED_ROUTES }),
    );
    vi.mocked(getLiveVehicles).mockResolvedValue([vehicle('1000067169')]);

    const response = await GET(makeRequest(), makeParams(TOKEN));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      routes: [
        { index: 0, name: 'North Loop' },
        { index: 1, name: 'South Loop' },
      ],
    });
    // No vehicle/window logic runs for this path at all.
    expect(getLiveVehicles).not.toHaveBeenCalled();
  });

  // ADAPTED from the E2-era "omits routes outside the window" tests: route
  // names are low-sensitivity staff-chosen labels, so the directory is
  // deliberately NOT window-gated — the per-route endpoints gate everything
  // sensitive by each route's own window instead.
  it('returns the directory regardless of window state, still without vehicle data', async () => {
    const future = Date.now() + 60 * 60 * 1000;
    vi.mocked(getTrackingLink).mockResolvedValue(
      activeLink(['1000067169'], {
        windowStart: new Date(future).toISOString(),
        windowEnd: new Date(future + 60 * 60 * 1000).toISOString(),
        routes: NAMED_ROUTES,
      }),
    );

    const body = await (await GET(makeRequest(), makeParams(TOKEN))).json();

    expect(body.routes.map((r: { name: string }) => r.name)).toEqual([
      'North Loop',
      'South Loop',
    ]);
    expect('status' in body).toBe(false);
    expect('customerName' in body).toBe(false);
    expect('vehicles' in body).toBe(false);
    expect(getLiveVehicles).not.toHaveBeenCalled();
  });

  // Regression: a link created without routes responds exactly as before.
  it('omits the routes field entirely for a link created without routes', async () => {
    vi.mocked(getTrackingLink).mockResolvedValue(activeLink(['1000067169']));
    vi.mocked(getLiveVehicles).mockResolvedValue([vehicle('1000067169')]);

    const body = await (await GET(makeRequest(), makeParams(TOKEN))).json();

    expect(body.status).toBe('active');
    expect('routes' in body).toBe(false);
  });

  // A link stored before the named-routes schema change still carries the
  // legacy flat waypoints/route fields in Redis — they must never leak into
  // the public response.
  it('never exposes legacy flat waypoints/route fields from old stored links', async () => {
    vi.mocked(getTrackingLink).mockResolvedValue({
      ...activeLink(['1000067169']),
      ...LEGACY_FIELDS,
    } as TrackingLink);
    vi.mocked(getLiveVehicles).mockResolvedValue([vehicle('1000067169')]);

    const body = await (await GET(makeRequest(), makeParams(TOKEN))).json();

    expect(body.status).toBe('active');
    expect('waypoints' in body).toBe(false);
    expect('route' in body).toBe(false);
  });

  it('keeps the public tracking limit at 30 requests per 60 seconds, keyed by IP', async () => {
    vi.mocked(getTrackingLink).mockResolvedValue(null);

    await GET(makeRequest(), makeParams(TOKEN));

    expect(slidingWindowCalls).toContainEqual([30, '60 s']);
    expect(limitMock).toHaveBeenCalledWith('1.2.3.4');
  });
});
