import { decode } from '@googlemaps/polyline-codec';
import { parseEnv } from './env';
import { googleMapsEnvSchema } from './googleMapsEnv';
import { GeocodeCandidate } from './orsClient';
import { haversineMeters } from './routeGeometry';

// Phase J2: Google Places (New) + Routes API client, built strictly against
// the real captures in __fixtures__/googleGeocode*.json and
// __fixtures__/googleRoute*.json. Same constructor-injection pattern as
// OrsClient/QuartixClient — no process.env reads inside the class.

export interface GoogleMapsClientConfig {
  apiKey: string;
}

// Same return shape as OrsClient.getRoute minus legBoundaryIndices — Google
// returns real per-leg geometry directly (each leg carries its own encoded
// polyline, confirmed in __fixtures__/googleRouteMultileg.json), so there is
// no boundary-index-into-the-whole-route concept in this client at all.
// Instead, each leg carries its own decoded geometry.
export interface GoogleRouteResult {
  // [lat, lng] pairs, decoded from the route-level encoded polyline.
  geometry: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  // One entry per consecutive waypoint pair, in order. Each leg's geometry
  // is decoded from that leg's OWN polyline — never sliced out of the
  // whole-route geometry. NOTE: leg distances/durations do NOT sum exactly
  // to the route totals (real capture shows a 1m/1s rounding mismatch —
  // Google rounds each field independently); anything needing a total must
  // read the route-level fields, never sum the legs.
  legs: {
    distanceMeters: number;
    durationSeconds: number;
    geometry: [number, number][];
  }[];
}

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

// Exact field masks the real captures were made with — Google returns only
// what is asked for, so widening/narrowing these changes the response shape.
const PLACES_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.types';
const ROUTES_FIELD_MASK =
  'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,' +
  'routes.legs.polyline.encodedPolyline,routes.legs.distanceMeters,routes.legs.duration';
// predictArrival answers "how long, total, first point to last" — no
// geometry/legs/waypoints, just the two durations. routes.staticDuration
// confirmed real as a top-level field by the verify-departure-time capture
// (__fixtures__/googleRoutePredicted.json).
const PREDICT_FIELD_MASK = 'routes.duration,routes.staticDuration';

const MAX_CANDIDATES = 5;

// Same Chicago Loop focus point as orsClient's geocode bias; Places has no
// ORS-style hard boundary rect in this request shape, so this is a soft
// bias only (locationBias, not locationRestriction) — mirroring how the
// capture was made.
const FOCUS = { lat: 41.8781, lng: -87.6298 };
const BIAS_RADIUS_METERS = 50000;

// Real places:searchText response shape (X-Goog-FieldMask above), confirmed
// against __fixtures__/googleGeocodeUnionStation.json and
// googleGeocodeNavyPier.json. `places` is absent entirely on zero results.
interface GooglePlace {
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  displayName?: { text?: string };
}

// Real computeRoutes response shape, confirmed against
// __fixtures__/googleRoute.json and googleRouteMultileg.json. duration is a
// string like "1235s" at EVERY level it appears.
interface GoogleRoutesResponse {
  routes?: Array<{
    distanceMeters?: number;
    duration?: string;
    polyline?: { encodedPolyline?: string };
    legs?: Array<{
      distanceMeters?: number;
      duration?: string;
      polyline?: { encodedPolyline?: string };
    }>;
  }>;
}

// "1235s" → 1235. Google encodes seconds as a string with a trailing 's'
// at every level (route and each leg) — fail loudly on anything else rather
// than silently producing NaN.
function parseDurationSeconds(raw: unknown): number {
  if (typeof raw === 'string') {
    const match = raw.match(/^(\d+(?:\.\d+)?)s$/);
    if (match) {
      return Number(match[1]);
    }
  }
  throw new Error(
    `Google routes returned an unexpected duration: ${JSON.stringify(raw)}`,
  );
}

function decodePolyline(encoded: string): [number, number][] {
  // polyline-codec decodes to [lat, lng] tuples already — no flip needed,
  // unlike ORS's GeoJSON [lng, lat] order.
  return decode(encoded).map(([lat, lng]) => [lat, lng]);
}

// "Suspiciously generic" address heuristic for matchType: the real Union
// Station capture's odd result is "Chicago, IL, USA" — city-only, no street,
// and (unlike every street-level result, which carries a zip code) no digits
// anywhere. Conservative on purpose: Google provides no exact/fallback
// signal, so this only flags the clearly-generic case.
function isGenericAddress(formattedAddress: string): boolean {
  return !/\d/.test(formattedAddress);
}

export class GoogleMapsClient {
  private config: GoogleMapsClientConfig;

  constructor(config: GoogleMapsClientConfig) {
    this.config = config;
  }

  private async post(
    url: string,
    fieldMask: string,
    body: unknown,
  ): Promise<unknown> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.config.apiKey,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const bodyText = await res.text();
      throw new Error(`Google request failed (${res.status}): ${bodyText}`);
    }
    return res.json();
  }

  async geocode(query: string): Promise<GeocodeCandidate[]> {
    const body = (await this.post(PLACES_URL, PLACES_FIELD_MASK, {
      textQuery: query,
      locationBias: {
        circle: {
          center: { latitude: FOCUS.lat, longitude: FOCUS.lng },
          radius: BIAS_RADIUS_METERS,
        },
      },
    })) as { places?: GooglePlace[] };

    // Zero results is a valid outcome (Google omits `places` entirely), not
    // an error — same convention as orsClient.
    const places = body.places;
    if (places === undefined) {
      return [];
    }
    if (!Array.isArray(places)) {
      throw new Error(
        'Google places returned an unexpected shape: places is not an array',
      );
    }

    return places.slice(0, MAX_CANDIDATES).map((place) => {
      const lat = place.location?.latitude;
      const lng = place.location?.longitude;
      const formattedAddress = place.formattedAddress;
      if (
        typeof lat !== 'number' ||
        typeof lng !== 'number' ||
        typeof formattedAddress !== 'string'
      ) {
        throw new Error(
          'Google places returned an unexpected shape: place without location/formattedAddress',
        );
      }
      // Google returns no ORS-style match_type/confidence at all — derive a
      // conservative equivalent instead of fabricating precision:
      // - exactly one result → 'exact' / 1 (mirrors the real Navy Pier
      //   capture, where Google's single answer was the right one);
      // - multiple results → fixed 0.6, 'fallback' only for the clearly
      //   generic city-only address, 'match' otherwise.
      const single = places.length === 1;
      return {
        label: place.displayName?.text ?? formattedAddress,
        lat,
        lng,
        matchType: single
          ? 'exact'
          : isGenericAddress(formattedAddress)
            ? 'fallback'
            : 'match',
        confidence: single ? 1 : 0.6,
        // Same km-with-3-decimals convention as ORS's `distance` field,
        // computed against the same focus point via the shared haversine.
        distanceKm:
          Math.round(haversineMeters(FOCUS, { lat, lng })) / 1000,
      };
    });
  }

  async getRoute(
    points: { lat: number; lng: number }[],
  ): Promise<GoogleRouteResult> {
    // A route needs at least two points — reject before spending a call.
    if (points.length < 2) {
      throw new Error(
        `Google getRoute requires at least 2 points, got ${points.length}`,
      );
    }

    const toWaypoint = (point: { lat: number; lng: number }) => ({
      location: { latLng: { latitude: point.lat, longitude: point.lng } },
    });
    const intermediates = points.slice(1, -1);

    const body = (await this.post(ROUTES_URL, ROUTES_FIELD_MASK, {
      origin: toWaypoint(points[0]),
      // `intermediates` omitted entirely on a 2-point route, matching the
      // shape the real 2-point capture was made with.
      ...(intermediates.length > 0
        ? { intermediates: intermediates.map(toWaypoint) }
        : {}),
      destination: toWaypoint(points[points.length - 1]),
      travelMode: 'DRIVE',
    })) as GoogleRoutesResponse;

    const route = body.routes?.[0];
    const encodedPolyline = route?.polyline?.encodedPolyline;
    const legs = route?.legs;
    if (
      !route ||
      typeof route.distanceMeters !== 'number' ||
      typeof encodedPolyline !== 'string' ||
      !Array.isArray(legs) ||
      legs.length !== points.length - 1
    ) {
      throw new Error(
        'Google routes returned an unexpected shape: missing route, distanceMeters, polyline, or one leg per waypoint pair',
      );
    }

    return {
      geometry: decodePolyline(encodedPolyline),
      distanceMeters: route.distanceMeters,
      durationSeconds: parseDurationSeconds(route.duration),
      legs: legs.map((leg) => {
        const legPolyline = leg?.polyline?.encodedPolyline;
        if (
          typeof leg?.distanceMeters !== 'number' ||
          typeof legPolyline !== 'string'
        ) {
          throw new Error(
            'Google routes returned an unexpected shape: leg without numeric distanceMeters or polyline',
          );
        }
        return {
          distanceMeters: leg.distanceMeters,
          durationSeconds: parseDurationSeconds(leg.duration),
          // Each leg's own polyline, decoded independently — NOT a slice of
          // the whole-route geometry (the leg-boundary point is repeated in
          // both adjacent legs, so slicing could never reproduce this).
          geometry: decodePolyline(legPolyline),
        };
      }),
    };
  }

  // Traffic-aware total-duration prediction for a future departure (Phase
  // K1). Origin/destination ONLY — no intermediates even on a multi-stop
  // trip, because this answers the design brief's single "estimated arrival
  // at the final stop" number. routingPreference TRAFFIC_AWARE is
  // MANDATORY: the real capture proved the default (TRAFFIC_UNAWARE) mode
  // hard-rejects any departureTime with a 400. `duration` is the
  // traffic-predicted figure for that departure; `staticDuration` is the
  // traffic-free baseline — both confirmed present at the route level in
  // __fixtures__/googleRoutePredicted.json.
  async predictArrival(
    origin: { lat: number; lng: number },
    destination: { lat: number; lng: number },
    departureTime: Date,
  ): Promise<{
    predictedDurationSeconds: number;
    staticDurationSeconds: number;
  }> {
    const body = (await this.post(ROUTES_URL, PREDICT_FIELD_MASK, {
      origin: {
        location: { latLng: { latitude: origin.lat, longitude: origin.lng } },
      },
      destination: {
        location: {
          latLng: { latitude: destination.lat, longitude: destination.lng },
        },
      },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      // RFC3339 UTC, the only format Google accepts.
      departureTime: departureTime.toISOString(),
    })) as {
      routes?: Array<{ duration?: string; staticDuration?: string }>;
    };

    const route = body.routes?.[0];
    if (!route) {
      throw new Error(
        'Google routes returned an unexpected shape: missing routes for arrival prediction',
      );
    }
    return {
      predictedDurationSeconds: parseDurationSeconds(route.duration),
      staticDurationSeconds: parseDurationSeconds(route.staticDuration),
    };
  }
}

// Real singleton — the ONLY place real env vars get read, deferred to first
// use for the same build/test reasons as orsClient's singleton. A missing
// GOOGLE_MAPS_API_KEY fails loudly via parseEnv on the first actual call.
let singleton: GoogleMapsClient | null = null;

function resolveSingleton(): GoogleMapsClient {
  if (!singleton) {
    const env = parseEnv(googleMapsEnvSchema, process.env);
    singleton = new GoogleMapsClient({ apiKey: env.GOOGLE_MAPS_API_KEY });
  }
  return singleton;
}

export const googleMapsClient: GoogleMapsClient = new Proxy(
  {} as GoogleMapsClient,
  {
    get(_target, prop) {
      const client = resolveSingleton();
      const value = Reflect.get(client, prop, client);
      return typeof value === 'function' ? value.bind(client) : value;
    },
  },
);
