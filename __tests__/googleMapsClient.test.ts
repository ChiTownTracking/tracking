import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleMapsClient } from '@/lib/googleMapsClient';
import { haversineMeters } from '@/lib/routeGeometry';
import googleGeocodeUnionStation from '@/__fixtures__/googleGeocodeUnionStation.json';
import googleGeocodeNavyPier from '@/__fixtures__/googleGeocodeNavyPier.json';
import googleRoute from '@/__fixtures__/googleRoute.json';
import googleRouteMultileg from '@/__fixtures__/googleRouteMultileg.json';
import googleRoutePredicted from '@/__fixtures__/googleRoutePredicted.json';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function makeClient(): GoogleMapsClient {
  return new GoogleMapsClient({ apiKey: 'test-key' });
}

describe('GoogleMapsClient.geocode', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('POSTs the query with the capture-verified field mask and Chicago bias', async () => {
    fetchMock.mockResolvedValue(jsonResponse(googleGeocodeUnionStation));

    await makeClient().geocode('Union Station, Chicago, IL');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('test-key');
    expect(headers['X-Goog-FieldMask']).toBe(
      'places.id,places.displayName,places.formattedAddress,places.location,places.types',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      textQuery: 'Union Station, Chicago, IL',
      locationBias: {
        circle: {
          center: { latitude: 41.8781, longitude: -87.6298 },
          radius: 50000,
        },
      },
    });
  });

  it('parses the real Union Station capture: 5 candidates in Google order', async () => {
    fetchMock.mockResolvedValue(jsonResponse(googleGeocodeUnionStation));

    const candidates = await makeClient().geocode('Union Station, Chicago, IL');

    expect(candidates).toHaveLength(5);
    // Multiple results → fixed conservative confidence, 'match' for real
    // street addresses.
    expect(candidates[0]).toEqual({
      label: 'Chicago Union Station',
      lat: 41.8786902,
      lng: -87.640312,
      matchType: 'match',
      confidence: 0.6,
      distanceKm: 0.873,
    });
    // The capture's one city-only result ("Chicago, IL, USA" — no street,
    // no digits) is the derived 'fallback' case.
    expect(candidates[2]).toEqual({
      label: 'Union Station',
      lat: 41.8786738,
      lng: -87.6403334,
      matchType: 'fallback',
      confidence: 0.6,
      distanceKm: 0.874,
    });
  });

  it('computes distanceKm via the shared haversine against the Chicago focus point', async () => {
    fetchMock.mockResolvedValue(jsonResponse(googleGeocodeUnionStation));

    const candidates = await makeClient().geocode('Union Station, Chicago, IL');

    for (const candidate of candidates) {
      const expectedKm =
        Math.round(
          haversineMeters(
            { lat: 41.8781, lng: -87.6298 },
            { lat: candidate.lat, lng: candidate.lng },
          ),
        ) / 1000;
      expect(candidate.distanceKm).toBe(expectedKm);
    }
  });

  it('parses the real Navy Pier capture: the single result is an exact match', async () => {
    fetchMock.mockResolvedValue(jsonResponse(googleGeocodeNavyPier));

    const candidates = await makeClient().geocode('Navy Pier, Chicago, IL');

    // The query ORS famously resolved to Glenview, 28.5 km away — Google
    // returns exactly one confident, correct place.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      label: 'Navy Pier',
      lat: 41.8918633,
      lng: -87.6050944,
      matchType: 'exact',
      confidence: 1,
      distanceKm: 2.554,
    });
  });

  it('returns [] when Google omits places entirely (zero results)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    const candidates = await makeClient().geocode('zzzz nowhere');

    expect(candidates).toEqual([]);
  });
});

describe('GoogleMapsClient.getRoute', () => {
  // Union Station → Wrigley Field, matching the real captured route.
  const POINTS = [
    { lat: 41.878988, lng: -87.639732 },
    { lat: 41.948441, lng: -87.655361 },
  ];
  // Union Station → Wrigley Field → 2600 Navy Boulevard, Glenview — the
  // exact points of the googleRouteMultileg.json capture.
  const THREE_POINTS = [
    { lat: 41.878988, lng: -87.639732 },
    { lat: 41.948437, lng: -87.655334 },
    { lat: 42.089919, lng: -87.823623 },
  ];

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('POSTs origin/destination waypoints with the confirmed field mask, no intermediates for 2 points', async () => {
    fetchMock.mockResolvedValue(jsonResponse(googleRoute));

    await makeClient().getRoute(POINTS);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
    );
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('test-key');
    expect(headers['X-Goog-FieldMask']).toBe(
      'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,' +
        'routes.legs.polyline.encodedPolyline,routes.legs.distanceMeters,routes.legs.duration',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      origin: {
        location: { latLng: { latitude: 41.878988, longitude: -87.639732 } },
      },
      destination: {
        location: { latLng: { latitude: 41.948441, longitude: -87.655361 } },
      },
      travelMode: 'DRIVE',
    });
  });

  it('sends middle points as intermediates, in order', async () => {
    fetchMock.mockResolvedValue(jsonResponse(googleRouteMultileg));

    await makeClient().getRoute(THREE_POINTS);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.origin.location.latLng.latitude).toBe(41.878988);
    expect(body.intermediates).toEqual([
      {
        location: { latLng: { latitude: 41.948437, longitude: -87.655334 } },
      },
    ]);
    expect(body.destination.location.latLng.latitude).toBe(42.089919);
  });

  it('parses the real 2-point capture: decoded geometry, numeric duration, one leg', async () => {
    fetchMock.mockResolvedValue(jsonResponse(googleRoute));

    const route = await makeClient().getRoute(POINTS);

    // Exact values from the real capture; "1235s" parsed to a number.
    expect(route.distanceMeters).toBe(12793);
    expect(route.durationSeconds).toBe(1235);
    // Decoded polyline spot-checked against the capture's real
    // startLocation/endLocation (41.878991,-87.6395833 → 41.9490412,
    // -87.655372) at the codec's 1e-5 precision.
    expect(route.geometry).toHaveLength(110);
    expect(route.geometry[0]).toEqual([41.87899, -87.63958]);
    expect(route.geometry[route.geometry.length - 1]).toEqual([
      41.94904, -87.65537,
    ]);
    expect(route.legs).toHaveLength(1);
    expect(route.legs[0].distanceMeters).toBe(12794);
    expect(route.legs[0].durationSeconds).toBe(1236);
  });

  it('parses the real 3-point capture: two legs, each with its own independently decoded geometry', async () => {
    fetchMock.mockResolvedValue(jsonResponse(googleRouteMultileg));

    const route = await makeClient().getRoute(THREE_POINTS);

    // Exact real per-leg values from the capture.
    expect(route.legs).toHaveLength(2);
    expect(route.legs[0].distanceMeters).toBe(12796);
    expect(route.legs[0].durationSeconds).toBe(1236);
    expect(route.legs[1].distanceMeters).toBe(29337);
    expect(route.legs[1].durationSeconds).toBe(2256);

    // Each leg's geometry is its own decoding: the Wrigley boundary point
    // appears at BOTH leg0's end and leg1's start, so the two legs together
    // hold one more point (109 + 201 = 310) than the whole-route polyline
    // (309) — a slice of the route geometry could never produce this.
    expect(route.geometry).toHaveLength(309);
    expect(route.legs[0].geometry).toHaveLength(109);
    expect(route.legs[1].geometry).toHaveLength(201);
    const leg0End = route.legs[0].geometry[route.legs[0].geometry.length - 1];
    expect(route.legs[1].geometry[0]).toEqual(leg0End);
    expect(leg0End).toEqual([41.94904, -87.65535]);
    expect(route.legs[1].geometry[200]).toEqual([42.08998, -87.82342]);
  });

  it('reads the total from the route level — Google leg sums do NOT equal it', async () => {
    fetchMock.mockResolvedValue(jsonResponse(googleRouteMultileg));

    const route = await makeClient().getRoute(THREE_POINTS);

    // Pins the real 1m/1s rounding mismatch (42132 ≠ 12796 + 29337 = 42133;
    // 3491 ≠ 1236 + 2256 = 3492): Google rounds each field independently, so
    // a "total" must always be read from the route level, never derived by
    // summing legs. If a refactor makes totals sum-based, this fails.
    expect(route.distanceMeters).toBe(42132);
    expect(route.durationSeconds).toBe(3491);
    expect(route.distanceMeters).not.toBe(
      route.legs[0].distanceMeters + route.legs[1].distanceMeters,
    );
    expect(route.durationSeconds).not.toBe(
      route.legs[0].durationSeconds + route.legs[1].durationSeconds,
    );
  });

  it('throws before calling fetch on fewer than 2 points', async () => {
    await expect(
      makeClient().getRoute([{ lat: 41.878988, lng: -87.639732 }]),
    ).rejects.toThrow(/requires at least 2 points, got 1/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws with status and body on an HTTP error response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: 'API key not valid' } }, 403),
    );

    await expect(makeClient().getRoute(POINTS)).rejects.toThrow(
      /Google request failed \(403\).*API key not valid/,
    );
  });

  it('throws on a response missing routes', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await expect(makeClient().getRoute(POINTS)).rejects.toThrow(
      /unexpected shape/,
    );
  });
});

describe('GoogleMapsClient.predictArrival', () => {
  const ORIGIN = { lat: 41.878988, lng: -87.639732 };
  const DESTINATION = { lat: 41.948441, lng: -87.655361 };
  // The exact departure of the real capture: tomorrow-at-time-of-capture,
  // 07:00 America/Chicago as RFC3339 UTC.
  const DEPARTURE = new Date('2026-07-19T12:00:00.000Z');

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('POSTs TRAFFIC_AWARE with the RFC3339 departure and the duration-only field mask', async () => {
    fetchMock.mockResolvedValue(jsonResponse(googleRoutePredicted));

    await makeClient().predictArrival(ORIGIN, DESTINATION, DEPARTURE);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
    );
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Goog-FieldMask']).toBe(
      'routes.duration,routes.staticDuration',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      origin: {
        location: { latLng: { latitude: 41.878988, longitude: -87.639732 } },
      },
      destination: {
        location: { latLng: { latitude: 41.948441, longitude: -87.655361 } },
      },
      travelMode: 'DRIVE',
      // Mandatory: the real capture proved TRAFFIC_UNAWARE (the default)
      // hard-rejects any departureTime with a 400.
      routingPreference: 'TRAFFIC_AWARE',
      departureTime: '2026-07-19T12:00:00.000Z',
    });
  });

  it('parses the real capture: predicted and static durations as numbers', async () => {
    fetchMock.mockResolvedValue(jsonResponse(googleRoutePredicted));

    const prediction = await makeClient().predictArrival(
      ORIGIN,
      DESTINATION,
      DEPARTURE,
    );

    // Exact values from the real Sunday-7am capture — traffic-predicted
    // FASTER than the static baseline, proving the two are distinguishable.
    expect(prediction).toEqual({
      predictedDurationSeconds: 1061,
      staticDurationSeconds: 1332,
    });
  });

  it('throws with status and body on a non-200 response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 400,
            message: 'Timestamp cannot be set for TRAFFIC_UNAWARE routing mode.',
          },
        },
        400,
      ),
    );

    await expect(
      makeClient().predictArrival(ORIGIN, DESTINATION, DEPARTURE),
    ).rejects.toThrow(/Google request failed \(400\).*Timestamp cannot be set/);
  });

  it('throws on a response missing routes', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await expect(
      makeClient().predictArrival(ORIGIN, DESTINATION, DEPARTURE),
    ).rejects.toThrow(/unexpected shape.*arrival prediction/);
  });
});
