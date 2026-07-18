// Phase F3: pure geometry primitives for live ETA estimation. No I/O — every
// function here is deterministic math over coordinates, [lat, lng] order
// throughout (same convention as everywhere above orsClient).

const EARTH_RADIUS_METERS = 6371000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

// Great-circle distance between two points, standard haversine formula.
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

// Running total distance from geometry[0] to each point: result[0] is 0,
// result[i] is the along-the-polyline distance to geometry[i]. Same length
// as the input.
export function cumulativeDistances(geometry: [number, number][]): number[] {
  if (geometry.length === 0) {
    throw new Error('cumulativeDistances requires a non-empty geometry');
  }
  const distances = [0];
  for (let i = 1; i < geometry.length; i++) {
    const [prevLat, prevLng] = geometry[i - 1];
    const [lat, lng] = geometry[i];
    distances.push(
      distances[i - 1] +
        haversineMeters({ lat: prevLat, lng: prevLng }, { lat, lng }),
    );
  }
  return distances;
}

// Finds the closest point on the route polyline to the given position.
// Returns how far along the whole route that projected point is, and how far
// the actual position sits from the route itself. The second number is the
// honesty signal: a vehicle way off the mapped route shouldn't produce a
// confident-looking ETA, and callers decide that — this function just
// reports both.
export function nearestPointOnRoute(
  position: { lat: number; lng: number },
  geometry: [number, number][],
): { distanceAlongRouteMeters: number; distanceFromRouteMeters: number } {
  if (geometry.length < 2) {
    throw new Error(
      `nearestPointOnRoute requires at least 2 geometry points, got ${geometry.length}`,
    );
  }

  const cumulative = cumulativeDistances(geometry);

  // Each segment is treated as locally flat: these are short urban road
  // segments (tens of meters), nowhere near long enough for great-circle
  // curvature to matter. Project into a local equirectangular plane (meters
  // east/north of the segment start, with longitude scaled by cos(lat)) and
  // do ordinary point-to-segment projection there.
  const cosLat = Math.cos(toRadians(position.lat));
  const metersPerDegree = (Math.PI / 180) * EARTH_RADIUS_METERS;

  let best: {
    distanceAlongRouteMeters: number;
    distanceFromRouteMeters: number;
  } | null = null;

  for (let i = 0; i < geometry.length - 1; i++) {
    const [aLat, aLng] = geometry[i];
    const [bLat, bLng] = geometry[i + 1];

    const abX = (bLng - aLng) * cosLat * metersPerDegree;
    const abY = (bLat - aLat) * metersPerDegree;
    const apX = (position.lng - aLng) * cosLat * metersPerDegree;
    const apY = (position.lat - aLat) * metersPerDegree;

    const segmentLengthSq = abX * abX + abY * abY;
    // Clamp the projection to the segment; a zero-length segment (duplicate
    // consecutive points) degenerates to its start point.
    const t =
      segmentLengthSq === 0
        ? 0
        : Math.min(1, Math.max(0, (apX * abX + apY * abY) / segmentLengthSq));

    const projected = {
      lat: aLat + t * (bLat - aLat),
      lng: aLng + t * (bLng - aLng),
    };
    const distanceFromRouteMeters = haversineMeters(position, projected);

    if (best === null || distanceFromRouteMeters < best.distanceFromRouteMeters) {
      best = {
        distanceAlongRouteMeters:
          cumulative[i] + t * (cumulative[i + 1] - cumulative[i]),
        distanceFromRouteMeters,
      };
    }
  }

  // geometry.length >= 2 guarantees at least one segment was examined.
  return best as {
    distanceAlongRouteMeters: number;
    distanceFromRouteMeters: number;
  };
}
