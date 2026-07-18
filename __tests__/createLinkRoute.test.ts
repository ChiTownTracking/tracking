import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackingLink } from '@/lib/trackingTokens';

vi.mock('@/lib/vehicleRoster', () => ({ getVehicleRoster: vi.fn() }));

// Phase J3: the route now calls googleMapsClient — same field names, but
// legs carry their own geometry and there is no unroutable-point error
// class yet (every routing failure is the generic 502 until a real Google
// unroutable capture exists; see the TODO in the route).
vi.mock('@/lib/googleMapsClient', () => ({
  googleMapsClient: { geocode: vi.fn(), getRoute: vi.fn() },
}));

// In-memory store with a JSON round-trip, mirroring the serialization the
// real Redis-backed trackingTokens performs.
vi.mock('@/lib/trackingTokens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trackingTokens')>();
  const store = new Map<string, unknown>();
  return {
    ...actual,
    createTrackingLink: vi.fn(async (token: string, link: unknown) => {
      store.set(token, JSON.parse(JSON.stringify(link)));
    }),
    getTrackingLink: vi.fn(async (token: string) => store.get(token) ?? null),
    __reset: () => store.clear(),
  };
});

import { POST } from '@/app/api/internal/create-link/route';
import { googleMapsClient } from '@/lib/googleMapsClient';
import { createTrackingLink, getTrackingLink } from '@/lib/trackingTokens';
import { getVehicleRoster } from '@/lib/vehicleRoster';

const LOOP_WAYPOINTS = [
  { label: 'Chicago Union Station', lat: 41.878988, lng: -87.639732 },
  { label: 'Wrigley Field', lat: 41.948437, lng: -87.655334 },
];

const KENOSHA_WAYPOINTS = [
  { label: 'Kenosha Metra Station', lat: 42.5886, lng: -87.8214 },
  { label: 'Downtown Kenosha', lat: 42.5847, lng: -87.8212 },
  { label: 'Kenosha Harbor', lat: 42.589, lng: -87.813 },
];

// Google-shaped getRoute results: each leg carries its own geometry (this
// route only stores the whole-route geometry + totals, so the per-leg data
// is simply unused here).
const ROUTE_RESULT_A = {
  geometry: [
    [41.878988, -87.639704],
    [41.949033, -87.655348],
  ] as [number, number][],
  distanceMeters: 9489.6,
  durationSeconds: 917.9,
  legs: [
    {
      distanceMeters: 9489.6,
      durationSeconds: 917.9,
      geometry: [
        [41.878988, -87.639704],
        [41.949033, -87.655348],
      ] as [number, number][],
    },
  ],
};

const ROUTE_RESULT_B = {
  geometry: [
    [42.5886, -87.8213],
    [42.589, -87.8131],
  ] as [number, number][],
  distanceMeters: 1200.5,
  durationSeconds: 240.2,
  legs: [
    {
      distanceMeters: 700.3,
      durationSeconds: 140.1,
      geometry: [
        [42.5886, -87.8213],
        [42.5847, -87.8212],
      ] as [number, number][],
    },
    {
      distanceMeters: 500.2,
      durationSeconds: 100.1,
      geometry: [
        [42.5847, -87.8212],
        [42.589, -87.8131],
      ] as [number, number][],
    },
  ],
};

function validBody(extra: Record<string, unknown> = {}) {
  return {
    vehicleIds: ['1000067169'],
    customerName: 'Smith Wedding',
    windowStart: '2026-07-20T14:00:00.000Z',
    windowEnd: '2026-07-20T18:00:00.000Z',
    ...extra,
  };
}

function twoRoutes() {
  return [
    {
      name: 'Route A',
      vehicleIds: ['1000067169'],
      windowStart: '2026-07-20T14:00:00.000Z',
      windowEnd: '2026-07-20T18:00:00.000Z',
      waypoints: LOOP_WAYPOINTS,
      schedule: ['07:00', '14:30'],
    },
    {
      name: 'Route B',
      vehicleIds: ['1000074171'],
      windowStart: '2026-07-20T13:00:00.000Z',
      windowEnd: '2026-07-20T17:00:00.000Z',
      waypoints: KENOSHA_WAYPOINTS,
      schedule: [],
    },
  ];
}

// Routes-mode payloads carry NO top-level vehicleIds/window — matching what
// the UI sends once any route block exists.
function routesBody(routes: unknown[]) {
  return { customerName: 'Smith Wedding', routes };
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/internal/create-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/internal/create-link — routing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const mocked = (await import('@/lib/trackingTokens')) as unknown as {
      __reset: () => void;
    };
    mocked.__reset();
    vi.mocked(getVehicleRoster).mockResolvedValue([
      {
        vehicleId: '1000067169',
        registrationNumber: 'TRLY-7169',
        description: 'Trolley 1',
        iconUrl: '',
      },
      {
        vehicleId: '1000074171',
        registrationNumber: 'TRLY-4171',
        description: 'Trolley 2',
        iconUrl: '',
      },
    ]);
  });

  it('calls getRoute once per route, in order, each with its own waypoints', async () => {
    vi.mocked(googleMapsClient.getRoute)
      .mockResolvedValueOnce(ROUTE_RESULT_A)
      .mockResolvedValueOnce(ROUTE_RESULT_B);

    const response = await POST(makeRequest(routesBody(twoRoutes())));

    expect(response.status).toBe(200);
    expect(googleMapsClient.getRoute).toHaveBeenCalledTimes(2);
    expect(googleMapsClient.getRoute).toHaveBeenNthCalledWith(
      1,
      LOOP_WAYPOINTS.map(({ lat, lng }) => ({ lat, lng })),
    );
    expect(googleMapsClient.getRoute).toHaveBeenNthCalledWith(
      2,
      KENOSHA_WAYPOINTS.map(({ lat, lng }) => ({ lat, lng })),
    );
  });

  it('never calls getRoute when no routes field is submitted, and stores none', async () => {
    const response = await POST(makeRequest(validBody()));

    expect(response.status).toBe(200);
    expect(googleMapsClient.getRoute).not.toHaveBeenCalled();

    const { token } = await response.json();
    const stored = (await getTrackingLink(token)) as TrackingLink;
    expect(stored.routes).toBeUndefined();
  });

  // The regression test proving the loop doesn't short-circuit silently: the
  // FIRST route succeeding must not let a failure on the SECOND slip through.
  // Phase J3: any routing failure is the generic 502 now — ORS's unroutable
  // shape produced an actionable 400 naming the route, but no Google
  // equivalent has been captured yet (see the TODO in the route).
  it('a failure on the second route still blocks creation entirely', async () => {
    vi.mocked(googleMapsClient.getRoute)
      .mockResolvedValueOnce(ROUTE_RESULT_A)
      .mockRejectedValueOnce(
        new Error('Google request failed (400): location unreachable'),
      );

    const response = await POST(makeRequest(routesBody(twoRoutes())));

    expect(response.status).toBe(502);
    expect(createTrackingLink).not.toHaveBeenCalled();
  });

  it('returns the standard generic 502 on any getRoute failure, link not created', async () => {
    vi.mocked(googleMapsClient.getRoute).mockRejectedValue(
      new Error('Google request failed (403): quota exceeded'),
    );

    const response = await POST(makeRequest(routesBody(twoRoutes())));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'Unable to create tracking link',
    });
    expect(createTrackingLink).not.toHaveBeenCalled();
  });

  it('stores every route with its own vehicles, window, and computed geometry — round-trips intact, in order', async () => {
    vi.mocked(googleMapsClient.getRoute)
      .mockResolvedValueOnce(ROUTE_RESULT_A)
      .mockResolvedValueOnce(ROUTE_RESULT_B);

    const response = await POST(makeRequest(routesBody(twoRoutes())));
    const { token } = await response.json();

    const stored = (await getTrackingLink(token)) as TrackingLink;
    expect(stored.routes).toEqual([
      {
        name: 'Route A',
        vehicleIds: ['1000067169'],
        windowStart: '2026-07-20T14:00:00.000Z',
        windowEnd: '2026-07-20T18:00:00.000Z',
        waypoints: LOOP_WAYPOINTS,
        schedule: ['07:00', '14:30'],
        // StoredRoute keeps only geometry + totals — RouteResult's per-leg
        // breakdown (legs, added in F1a) is deliberately NOT stored on
        // tracking-link routes; only the standalone Route model keeps it.
        route: {
          geometry: ROUTE_RESULT_A.geometry,
          distanceMeters: ROUTE_RESULT_A.distanceMeters,
          durationSeconds: ROUTE_RESULT_A.durationSeconds,
        },
      },
      {
        name: 'Route B',
        vehicleIds: ['1000074171'],
        windowStart: '2026-07-20T13:00:00.000Z',
        windowEnd: '2026-07-20T17:00:00.000Z',
        waypoints: KENOSHA_WAYPOINTS,
        schedule: [],
        route: {
          geometry: ROUTE_RESULT_B.geometry,
          distanceMeters: ROUTE_RESULT_B.distanceMeters,
          durationSeconds: ROUTE_RESULT_B.durationSeconds,
        },
      },
    ]);
    // Top-level fields in routes mode are derived aggregates (readers
    // ignore them): vehicle union, earliest start, latest end.
    expect(stored.vehicleIds).toEqual(['1000067169', '1000074171']);
    expect(stored.windowStart).toBe('2026-07-20T13:00:00.000Z');
    expect(stored.windowEnd).toBe('2026-07-20T18:00:00.000Z');
  });

  it('rejects an unknown per-route vehicle id, naming the route, before any ORS call', async () => {
    const routes = twoRoutes();
    routes[1].vehicleIds = ['9999999999'];

    const response = await POST(makeRequest(routesBody(routes)));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Route B: vehicle 9999999999 does not exist.',
    });
    expect(googleMapsClient.getRoute).not.toHaveBeenCalled();
    expect(createTrackingLink).not.toHaveBeenCalled();
  });

  it('accumulates roster errors across routes rather than stopping at the first', async () => {
    const routes = twoRoutes();
    routes[0].vehicleIds = ['1111111111'];
    routes[1].vehicleIds = ['9999999999'];

    const response = await POST(makeRequest(routesBody(routes)));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Route A: vehicle 1111111111 does not exist.');
    expect(body.error).toContain('Route B: vehicle 9999999999 does not exist.');
  });

  // Regression: the original top-level roster check still guards the
  // no-routes case.
  it('still rejects an unknown top-level vehicle id when no routes are submitted', async () => {
    const response = await POST(
      makeRequest(validBody({ vehicleIds: ['4242424242'] })),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Unknown vehicle id(s): 4242424242',
    });
    expect(createTrackingLink).not.toHaveBeenCalled();
  });
});
