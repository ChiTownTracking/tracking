import { describe, expect, it } from 'vitest';
import {
  cumulativeDistances,
  haversineMeters,
  nearestPointOnRoute,
} from '@/lib/routeGeometry';

// Union Station → Wrigley Field, the same pair as the real orsRoute.json
// capture, whose road distance is 9489.6 m.
const UNION_STATION = { lat: 41.878988, lng: -87.639732 };
const WRIGLEY_FIELD = { lat: 41.948437, lng: -87.655334 };
const UNION_TO_WRIGLEY_ROAD_METERS = 9489.6;

// A simple synthetic polyline straight up a meridian: 4 points spaced
// 0.01° of latitude (~1112 m) apart. Easy to reason about projections on.
const MERIDIAN: [number, number][] = [
  [41.0, -87.65],
  [41.01, -87.65],
  [41.02, -87.65],
  [41.03, -87.65],
];

describe('haversineMeters', () => {
  it('is zero for identical points', () => {
    expect(haversineMeters(UNION_STATION, UNION_STATION)).toBe(0);
  });

  it('straight-line Union Station → Wrigley is meaningfully shorter than the real road distance', () => {
    const straightLine = haversineMeters(UNION_STATION, WRIGLEY_FIELD);
    // Roads wander: the great-circle distance must come in clearly under the
    // captured 9489.6 m road distance, but still in the same ballpark.
    expect(straightLine).toBeLessThan(UNION_TO_WRIGLEY_ROAD_METERS * 0.9);
    expect(straightLine).toBeGreaterThan(7000);
  });

  it('is symmetric', () => {
    expect(haversineMeters(UNION_STATION, WRIGLEY_FIELD)).toBe(
      haversineMeters(WRIGLEY_FIELD, UNION_STATION),
    );
  });
});

describe('cumulativeDistances', () => {
  it('starts at 0 and is strictly non-decreasing, one entry per point', () => {
    const cumulative = cumulativeDistances(MERIDIAN);

    expect(cumulative).toHaveLength(MERIDIAN.length);
    expect(cumulative[0]).toBe(0);
    for (let i = 1; i < cumulative.length; i++) {
      expect(cumulative[i]).toBeGreaterThanOrEqual(cumulative[i - 1]);
    }
  });

  it('each entry is the exact running sum of segment haversines', () => {
    const cumulative = cumulativeDistances(MERIDIAN);

    let runningTotal = 0;
    for (let i = 1; i < MERIDIAN.length; i++) {
      const [prevLat, prevLng] = MERIDIAN[i - 1];
      const [lat, lng] = MERIDIAN[i];
      runningTotal += haversineMeters(
        { lat: prevLat, lng: prevLng },
        { lat, lng },
      );
      expect(cumulative[i]).toBe(runningTotal);
    }
  });

  it('throws on an empty geometry', () => {
    expect(() => cumulativeDistances([])).toThrow(/non-empty geometry/);
  });
});

describe('nearestPointOnRoute', () => {
  it('a point exactly on a vertex: zero off-route distance, exact along-route distance', () => {
    const cumulative = cumulativeDistances(MERIDIAN);
    const result = nearestPointOnRoute({ lat: 41.02, lng: -87.65 }, MERIDIAN);

    expect(result.distanceFromRouteMeters).toBeCloseTo(0, 6);
    expect(result.distanceAlongRouteMeters).toBeCloseTo(cumulative[2], 6);
  });

  it('a point genuinely mid-segment projects onto it', () => {
    const cumulative = cumulativeDistances(MERIDIAN);
    // Offset ~838 m due west of the midpoint of segment 1 (41.01 → 41.02):
    // it should project onto (41.015, -87.65).
    const result = nearestPointOnRoute({ lat: 41.015, lng: -87.66 }, MERIDIAN);

    const expectedAlong = (cumulative[1] + cumulative[2]) / 2;
    expect(result.distanceAlongRouteMeters).toBeCloseTo(expectedAlong, 3);
    const expectedOffset = haversineMeters(
      { lat: 41.015, lng: -87.66 },
      { lat: 41.015, lng: -87.65 },
    );
    expect(result.distanceFromRouteMeters).toBeCloseTo(expectedOffset, 3);
  });

  it('a point far off the route reports a large off-route distance, clamped along-route', () => {
    const cumulative = cumulativeDistances(MERIDIAN);
    // ~250 km northwest of the whole polyline.
    const result = nearestPointOnRoute({ lat: 42.5, lng: -90.0 }, MERIDIAN);

    expect(result.distanceFromRouteMeters).toBeGreaterThan(100_000);
    expect(result.distanceAlongRouteMeters).toBeGreaterThanOrEqual(0);
    expect(result.distanceAlongRouteMeters).toBeLessThanOrEqual(
      cumulative[cumulative.length - 1],
    );
  });

  it('throws on fewer than 2 geometry points', () => {
    expect(() =>
      nearestPointOnRoute({ lat: 41.0, lng: -87.65 }, [[41.0, -87.65]]),
    ).toThrow(/at least 2 geometry points, got 1/);
  });
});
