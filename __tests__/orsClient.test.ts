import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GeocodeCandidate,
  OrsClient,
  orsClient,
  OrsUnroutablePointError,
} from '@/lib/orsClient';
import orsGeocode from '@/__fixtures__/orsGeocode.json';
import orsGeocodeFallback from '@/__fixtures__/orsGeocodeFallback.json';
import orsRoute from '@/__fixtures__/orsRoute.json';
import orsRouteMultileg from '@/__fixtures__/orsRouteMultileg.json';
import orsRouteUnreachable from '@/__fixtures__/orsRouteUnreachable.json';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function makeClient(): OrsClient {
  return new OrsClient({ apiKey: 'test-key' });
}

describe('OrsClient.geocode', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('sends the query, key, and verified bias params to /geocode/search', async () => {
    fetchMock.mockResolvedValue(jsonResponse(orsGeocode));

    await makeClient().geocode('Union Station, Chicago, IL');

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/geocode/search');
    expect(url.searchParams.get('text')).toBe('Union Station, Chicago, IL');
    expect(url.searchParams.get('api_key')).toBe('test-key');
    expect(url.searchParams.get('focus.point.lat')).toBe('41.8781');
    expect(url.searchParams.get('boundary.rect.min_lon')).toBe('-93.5');
    expect(url.searchParams.get('layers')).toBe('venue,address');
    expect(url.searchParams.get('size')).toBe('5');
  });

  it('parses the real exact-match capture, flipping [lon, lat] to lat/lng', async () => {
    fetchMock.mockResolvedValue(jsonResponse(orsGeocode));

    const candidates = await makeClient().geocode('Union Station, Chicago, IL');

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({
      label: 'Chicago Union Station, West Side, Chicago, IL, USA',
      // Real capture's coordinates are [-87.639732, 41.878988] — lon first.
      lat: 41.878988,
      lng: -87.639732,
      matchType: 'exact',
      confidence: 1,
      distanceKm: 0.829,
    } satisfies GeocodeCandidate);
  });

  // THE regression test for the Navy Pier bug: a fallback match must come
  // through clearly labeled as a fallback, with its distance visible — never
  // silently promoted to look like a confident hit.
  it('passes a fallback match through with matchType and distanceKm intact', async () => {
    fetchMock.mockResolvedValue(jsonResponse(orsGeocodeFallback));

    const candidates = await makeClient().geocode('Navy Pier, Chicago, IL');

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({
      label: '2600 Navy Boulevard, Glenview, IL, USA',
      lat: 42.089919,
      lng: -87.823623,
      matchType: 'fallback',
      confidence: 0.8,
      distanceKm: 28.517,
    } satisfies GeocodeCandidate);
  });

  it('maps a missing distance property to distanceKm: null', async () => {
    const feature = structuredClone(orsGeocode.features[0]) as Record<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >;
    delete feature.properties.distance;
    fetchMock.mockResolvedValue(
      jsonResponse({ ...orsGeocode, features: [feature] }),
    );

    const [candidate] = await makeClient().geocode('Union Station');
    expect(candidate.distanceKm).toBeNull();
  });

  it('caps the result at 5 candidates, preserving ORS relevance order', async () => {
    const features = Array.from({ length: 7 }, (_, i) => {
      const feature = structuredClone(orsGeocode.features[0]);
      feature.properties.label = `Candidate ${i}`;
      return feature;
    });
    fetchMock.mockResolvedValue(jsonResponse({ ...orsGeocode, features }));

    const candidates = await makeClient().geocode('Union Station');

    expect(candidates).toHaveLength(5);
    expect(candidates.map((c) => c.label)).toEqual([
      'Candidate 0',
      'Candidate 1',
      'Candidate 2',
      'Candidate 3',
      'Candidate 4',
    ]);
  });

  it('returns an empty array — not an error — for zero results', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...orsGeocode, features: [] }));

    await expect(makeClient().geocode('zzzz no such place')).resolves.toEqual(
      [],
    );
  });

  it('throws with status and body on an HTTP error response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'Rate limit exceeded' }, 403),
    );

    await expect(makeClient().geocode('Union Station')).rejects.toThrow(
      /ORS geocode failed \(403\).*Rate limit exceeded/,
    );
  });

  it('throws a useful message when the response has no features array', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ unexpected: 'shape' }));

    await expect(makeClient().geocode('Union Station')).rejects.toThrow(
      /unexpected shape.*missing features array/,
    );
  });
});

describe('OrsClient.getRoute', () => {
  // Union Station → Wrigley Field, matching the real captured route.
  const POINTS = [
    { lat: 41.878988, lng: -87.639732 },
    { lat: 41.948437, lng: -87.655334 },
  ];

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('POSTs the points flipped to [lng, lat] with the Authorization header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(orsRoute));

    await makeClient().getRoute(POINTS);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.openrouteservice.org/v2/directions/driving-car/geojson',
    );
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'test-key',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      coordinates: [
        [-87.639732, 41.878988],
        [-87.655334, 41.948437],
      ],
      preference: 'shortest',
    });
  });

  it('parses the real capture: geometry flipped to [lat, lng], exact distance and duration', async () => {
    fetchMock.mockResolvedValue(jsonResponse(orsRoute));

    const route = await makeClient().getRoute(POINTS);

    // Exact values from the real capture — no rounding.
    expect(route.distanceMeters).toBe(9489.6);
    expect(route.durationSeconds).toBe(917.9);
    expect(route.geometry).toHaveLength(178);
    // Real capture's first/last coordinates are [-87.639704, 41.878988] and
    // [-87.655348, 41.949033] — lon first; flipped here.
    expect(route.geometry[0]).toEqual([41.878988, -87.639704]);
    expect(route.geometry[route.geometry.length - 1]).toEqual([
      41.949033, -87.655348,
    ]);
  });

  it('parses per-leg timings from the real 3-point capture: one leg per waypoint pair', async () => {
    // Union Station → Wrigley Field → 2600 Navy Boulevard, Glenview — the
    // exact points of the orsRouteMultileg.json capture.
    const threePoints = [
      { lat: 41.878988, lng: -87.639732 },
      { lat: 41.948437, lng: -87.655334 },
      { lat: 42.089919, lng: -87.823623 },
    ];
    fetchMock.mockResolvedValue(jsonResponse(orsRouteMultileg));

    const route = await makeClient().getRoute(threePoints);

    expect(route.legs).toHaveLength(threePoints.length - 1);
    // Exact per-leg values from the real capture — no rounding. Leg 0 is
    // byte-identical to the 2-point orsRoute.json capture (same leg), which
    // cross-validates that segments are real leg data, not a re-estimate.
    expect(route.legs).toEqual([
      { distanceMeters: 9489.6, durationSeconds: 917.9 },
      { distanceMeters: 29286.1, durationSeconds: 2219.7 },
    ]);
    // The existing fields stay whole-route totals, untouched by legs.
    expect(route.distanceMeters).toBe(38775.7);
    expect(route.durationSeconds).toBe(3137.6);
    expect(route.geometry).toHaveLength(585);
    // way_points from the same capture — the geometry index of each of the
    // 3 waypoints, exactly as ORS returned them.
    expect(route.legBoundaryIndices).toEqual([0, 177, 584]);
  });

  it('throws a useful message when way_points is missing or the wrong length', async () => {
    const missing = structuredClone(orsRouteMultileg) as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      features: Array<{ properties: Record<string, any> }>;
    };
    delete missing.features[0].properties.way_points;
    fetchMock.mockResolvedValue(jsonResponse(missing));

    // 2 points against the 3-waypoint capture: way_points present but its
    // length doesn't match the request — also rejected.
    await expect(makeClient().getRoute(POINTS)).rejects.toThrow(
      /unexpected shape.*way_points/,
    );

    fetchMock.mockResolvedValue(jsonResponse(orsRouteMultileg));
    await expect(makeClient().getRoute(POINTS)).rejects.toThrow(
      /unexpected shape.*way_points/,
    );
  });

  it('throws OrsUnroutablePointError on the real code-2010 404, preserving the ORS message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(orsRouteUnreachable, 404));

    const error: unknown = await makeClient()
      .getRoute(POINTS)
      .catch((thrown) => thrown);

    expect(error).toBeInstanceOf(OrsUnroutablePointError);
    expect((error as Error).message).toBe(
      'Could not find routable point within a radius of 350.0 meters of specified coordinate 1: -87.9260000 41.9660000.',
    );
  });

  it('throws before calling fetch on fewer than 2 points', async () => {
    await expect(makeClient().getRoute([POINTS[0]])).rejects.toThrow(
      /at least 2 points, got 1/,
    );
    await expect(makeClient().getRoute([])).rejects.toThrow(
      /at least 2 points, got 0/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a generic error response throws a plain Error, never OrsUnroutablePointError', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'Rate limit exceeded' }, 403),
    );

    const error: unknown = await makeClient()
      .getRoute(POINTS)
      .catch((thrown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(OrsUnroutablePointError);
    expect((error as Error).message).toMatch(
      /ORS directions failed \(403\).*Rate limit exceeded/,
    );
  });

  it('a 404 with a non-2010 code also stays a plain Error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 2004, message: 'Request exceeds limit' } },
        404,
      ),
    );

    const error: unknown = await makeClient()
      .getRoute(POINTS)
      .catch((thrown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(OrsUnroutablePointError);
    expect((error as Error).message).toMatch(/ORS directions failed \(404\)/);
  });

  it('throws a useful message on a 200 with an unexpected shape', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ features: [{}] }));

    await expect(makeClient().getRoute(POINTS)).rejects.toThrow(
      /unexpected shape.*missing geometry coordinates, segments, or summary/,
    );
  });
});

describe('orsClient singleton', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The import at the top of this file already proves the module loads
  // without ORS_API_KEY; this pins down the loud failure on first real use.
  it('throws on first use when ORS_API_KEY is missing', () => {
    vi.stubEnv('ORS_API_KEY', '');
    expect(() => orsClient.geocode).toThrow();
  });
});
