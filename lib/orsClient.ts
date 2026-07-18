import { parseEnv } from './env';
import { orsEnvSchema } from './orsEnv';

export interface OrsClientConfig {
  apiKey: string;
}

// One geocoding candidate, in ORS's own relevance order. Deliberately NOT
// collapsed to a single "best guess": matchType/confidence/distanceKm exist
// so callers can see (and surface) when ORS fell back to something far away —
// e.g. the real "Navy Pier" query that matched "Navy Boulevard, Glenview"
// 28.5 km out (__fixtures__/orsGeocodeFallback.json).
export interface GeocodeCandidate {
  label: string;
  lat: number;
  lng: number;
  matchType: string;
  confidence: number;
  distanceKm: number | null;
}

export interface RouteResult {
  // [lat, lng] pairs — flipped from ORS's GeoJSON [lng, lat] order.
  geometry: [number, number][];
  // Whole-route totals, exactly as before.
  distanceMeters: number;
  durationSeconds: number;
  // One entry per consecutive waypoint pair, in order — ORS's
  // properties.segments, confirmed per-leg against the real 3-point capture
  // (__fixtures__/orsRouteMultileg.json: 2 segments whose distances/
  // durations sum exactly to the summary totals).
  legs: { distanceMeters: number; durationSeconds: number }[];
  // Index into geometry where each waypoint sits — ORS's top-level
  // properties.way_points (sibling to segments/summary), one entry per input
  // point, confirmed real in __fixtures__/orsRouteMultileg.json as
  // [0, 177, 584]. Lets callers map "distance along the geometry" back to
  // "which stop is next" without re-deriving stop positions.
  legBoundaryIndices: number[];
}

// ORS error code 2010: "could not find routable point" — a pin dropped
// somewhere with no road access within snapping distance (observed for real
// off a bad coordinate near O'Hare; see
// __fixtures__/orsRouteUnreachable.json). This is an expected user-facing
// case, not a system failure — callers can catch it specifically and show a
// useful message. ORS's original message is preserved for server-side logs.
export class OrsUnroutablePointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrsUnroutablePointError';
  }
}

const UNROUTABLE_POINT_CODE = 2010;

function toUnroutableError(
  status: number,
  bodyText: string,
): OrsUnroutablePointError | null {
  if (status !== 404) {
    return null;
  }
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { code?: number; message?: string };
    };
    if (parsed.error?.code === UNROUTABLE_POINT_CODE) {
      return new OrsUnroutablePointError(
        parsed.error.message ?? 'ORS could not find a routable point',
      );
    }
  } catch {
    // Not JSON — fall through to the generic error path.
  }
  return null;
}

const ORS_BASE = 'https://api.openrouteservice.org';
const MAX_CANDIDATES = 5;

// Geocoding bias verified against real captures: focus on the Chicago Loop
// (disambiguates same-named venues), hard-bounded to a Midwest box covering
// IL/WI/IN/MI plus padding so far-away homonyms can never come back at all.
const FOCUS_LAT = '41.8781';
const FOCUS_LON = '-87.6298';
const BOUNDARY_MIN_LON = '-93.5';
const BOUNDARY_MAX_LON = '-82.0';
const BOUNDARY_MIN_LAT = '36.5';
const BOUNDARY_MAX_LAT = '47.5';

// Real /geocode/search response shape — a GeoJSON FeatureCollection whose
// coordinates are [lon, lat] (longitude FIRST), confirmed against live
// captures in __fixtures__/orsGeocode.json and orsGeocodeFallback.json.
// "distance" (km from the focus point) is optional per Pelias docs, hence
// the null mapping.
interface OrsGeocodeFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    label: string;
    match_type: string;
    confidence: number;
    distance?: number;
  };
}

// Real /v2/directions/driving-car/geojson response shape — one Feature whose
// LineString coordinates are [lng, lat] and whose summary carries meters/
// seconds, confirmed against the live captures in __fixtures__/orsRoute.json
// and orsRouteMultileg.json. segments is per-leg: N-1 entries for N points,
// each with its own distance/duration (meters/seconds, same units as
// summary), in waypoint order.
interface OrsDirectionsResponse {
  features?: Array<{
    geometry?: { coordinates?: [number, number][] };
    properties?: {
      summary?: { distance?: number; duration?: number };
      segments?: Array<{ distance?: number; duration?: number }>;
      way_points?: number[];
    };
  }>;
}

export class OrsClient {
  private config: OrsClientConfig;

  constructor(config: OrsClientConfig) {
    this.config = config;
  }

  async geocode(query: string): Promise<GeocodeCandidate[]> {
    const url = new URL(`${ORS_BASE}/geocode/search`);
    url.searchParams.set('api_key', this.config.apiKey);
    url.searchParams.set('text', query);
    url.searchParams.set('focus.point.lat', FOCUS_LAT);
    url.searchParams.set('focus.point.lon', FOCUS_LON);
    url.searchParams.set('boundary.rect.min_lon', BOUNDARY_MIN_LON);
    url.searchParams.set('boundary.rect.max_lon', BOUNDARY_MAX_LON);
    url.searchParams.set('boundary.rect.min_lat', BOUNDARY_MIN_LAT);
    url.searchParams.set('boundary.rect.max_lat', BOUNDARY_MAX_LAT);
    url.searchParams.set('layers', 'venue,address');
    url.searchParams.set('size', String(MAX_CANDIDATES));

    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ORS geocode failed (${res.status}): ${body}`);
    }

    const body = (await res.json()) as { features?: OrsGeocodeFeature[] };
    if (!Array.isArray(body.features)) {
      throw new Error(
        'ORS geocode returned an unexpected shape: missing features array',
      );
    }

    // Zero features is a valid outcome (bad/ambiguous user input), not an
    // error. Order is ORS's relevance order — never re-ranked here.
    return body.features.slice(0, MAX_CANDIDATES).map((feature) => ({
      label: feature.properties.label,
      // ORS returns GeoJSON [lon, lat]; flip to lat/lng HERE so the raw
      // coordinate order never leaks above this layer.
      lat: feature.geometry.coordinates[1],
      lng: feature.geometry.coordinates[0],
      matchType: feature.properties.match_type,
      confidence: feature.properties.confidence,
      distanceKm: feature.properties.distance ?? null,
    }));
  }

  async getRoute(points: { lat: number; lng: number }[]): Promise<RouteResult> {
    // A route needs at least two points — reject before spending an ORS call.
    if (points.length < 2) {
      throw new Error(
        `ORS getRoute requires at least 2 points, got ${points.length}`,
      );
    }

    const res = await fetch(`${ORS_BASE}/v2/directions/driving-car/geojson`, {
      method: 'POST',
      headers: {
        Authorization: this.config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Same flip as geocode(), opposite direction: ORS speaks [lng, lat],
        // and this client is the one place that ever handles that order.
        coordinates: points.map((point) => [point.lng, point.lat]),
        // Shortest distance, not fastest time — verified against a real
        // side-by-side capture (Loop → Lincoln Park: 8592 m/1282 s shortest
        // vs 9750 m/938 s default). Response shape is identical either way.
        preference: 'shortest',
      }),
    });

    if (!res.ok) {
      const bodyText = await res.text();
      const unroutable = toUnroutableError(res.status, bodyText);
      if (unroutable) {
        throw unroutable;
      }
      throw new Error(`ORS directions failed (${res.status}): ${bodyText}`);
    }

    const body = (await res.json()) as OrsDirectionsResponse;
    const feature = body.features?.[0];
    const coordinates = feature?.geometry?.coordinates;
    const summary = feature?.properties?.summary;
    const segments = feature?.properties?.segments;
    if (
      !Array.isArray(coordinates) ||
      !Array.isArray(segments) ||
      typeof summary?.distance !== 'number' ||
      typeof summary?.duration !== 'number'
    ) {
      throw new Error(
        'ORS directions returned an unexpected shape: missing geometry coordinates, segments, or summary',
      );
    }

    // Same fail-loudly rule for way_points: one geometry index per input
    // point, or the response can't be trusted for stop-boundary math.
    const wayPoints = feature?.properties?.way_points;
    if (
      !Array.isArray(wayPoints) ||
      wayPoints.length !== points.length ||
      !wayPoints.every((index) => typeof index === 'number')
    ) {
      throw new Error(
        'ORS directions returned an unexpected shape: way_points missing or not one index per waypoint',
      );
    }

    return {
      geometry: coordinates.map(([lng, lat]) => [lat, lng]),
      distanceMeters: summary.distance,
      durationSeconds: summary.duration,
      // Per-leg, in waypoint order. Fail loudly on a malformed segment —
      // silently dropping a leg would corrupt downstream schedule math.
      legs: segments.map((segment) => {
        if (
          typeof segment?.distance !== 'number' ||
          typeof segment?.duration !== 'number'
        ) {
          throw new Error(
            'ORS directions returned an unexpected shape: segment without numeric distance/duration',
          );
        }
        return {
          distanceMeters: segment.distance,
          durationSeconds: segment.duration,
        };
      }),
      legBoundaryIndices: wayPoints,
    };
  }
}

// Real singleton — the ONLY place real env vars get read. Initialization is
// deferred to first use (rather than module load) so that importing OrsClient
// in tests, or evaluating this module during `next build`, doesn't require
// ORS_API_KEY to exist. A missing key still fails loudly via parseEnv on the
// first actual call.
let singleton: OrsClient | null = null;

function resolveSingleton(): OrsClient {
  if (!singleton) {
    const env = parseEnv(orsEnvSchema, process.env);
    singleton = new OrsClient({ apiKey: env.ORS_API_KEY });
  }
  return singleton;
}

export const orsClient: OrsClient = new Proxy({} as OrsClient, {
  get(_target, prop) {
    const client = resolveSingleton();
    const value = Reflect.get(client, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
