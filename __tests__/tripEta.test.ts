import { describe, expect, it } from 'vitest';
import { cumulativeDistances } from '@/lib/routeGeometry';
import { estimateTripProgress } from '@/lib/tripEta';

const MPH_TO_MPS = 0.44704;

// A 3-stop route straight up a meridian: 5 geometry points spaced 0.01° of
// latitude (~1112 m) apart, stops at geometry indices 0, 2, 4 — so each leg
// spans two geometry segments (~2224 m).
const GEOMETRY: [number, number][] = [
  [41.0, -87.65],
  [41.01, -87.65],
  [41.02, -87.65],
  [41.03, -87.65],
  [41.04, -87.65],
];
const LEG_BOUNDARY_INDICES = [0, 2, 4];
const CUMULATIVE = cumulativeDistances(GEOMETRY);

// Leg distances derived from the same geometry (as ORS's would be); leg
// durations deliberately DIFFERENT paces (leg 0 ~3.7 m/s, leg 1 ~1.85 m/s)
// so a test using the wrong leg's average would fail.
const LEG_DISTANCES = [CUMULATIVE[2], CUMULATIVE[4] - CUMULATIVE[2]];
const LEG_DURATIONS = [600, 1200];
const DWELL_MINUTES = [0, 5, 0];
const NOW = new Date('2026-07-17T15:00:00.000Z');

function estimate(
  vehiclePosition: { lat: number; lng: number },
  vehicleSpeedMph: number | null,
) {
  return estimateTripProgress({
    legDistancesMeters: LEG_DISTANCES,
    legDurationsSeconds: LEG_DURATIONS,
    dwellMinutes: DWELL_MINUTES,
    geometry: GEOMETRY,
    legBoundaryIndices: LEG_BOUNDARY_INDICES,
    vehiclePosition,
    vehicleSpeedMph,
    now: NOW,
  });
}

describe('estimateTripProgress', () => {
  it('vehicle at the very start: heading to stop 1, later stops from static leg durations', () => {
    const result = estimate({ lat: 41.0, lng: -87.65 }, 20);

    expect(result.distanceAlongRouteMeters).toBe(0);
    expect(result.distanceFromRouteMeters).toBeCloseTo(0, 6);
    expect(result.nextStopIndex).toBe(1);
    // Stop 0 is where the vehicle is — already reached, no ETA.
    expect(result.stopEtas[0]).toEqual({ arrival: null, departure: null });

    // Stop 1: live 20 mph over the full first leg.
    const expectedArrival1 =
      NOW.getTime() + (LEG_DISTANCES[0] / (20 * MPH_TO_MPS)) * 1000;
    expect(result.stopEtas[1].arrival?.getTime()).toBe(
      new Date(expectedArrival1).getTime(),
    );
    const departure1 = result.stopEtas[1].departure as Date;
    expect(departure1.getTime()).toBe(
      (result.stopEtas[1].arrival as Date).getTime() +
        DWELL_MINUTES[1] * 60 * 1000,
    );

    // Stop 2: previous departure + leg 1's STATIC duration, not any live
    // recomputation; its own dwell is 0 so departure equals arrival.
    const arrival2 = result.stopEtas[2].arrival as Date;
    expect(arrival2.getTime()).toBe(
      departure1.getTime() + LEG_DURATIONS[1] * 1000,
    );
    expect((result.stopEtas[2].departure as Date).getTime()).toBe(
      arrival2.getTime(),
    );
  });

  it('vehicle mid-leg with a real live speed: arrival reflects that speed, not the static average', () => {
    // Halfway up the first geometry segment — a quarter of the way through
    // leg 0.
    const result = estimate({ lat: 41.005, lng: -87.65 }, 25);

    expect(result.nextStopIndex).toBe(1);
    const remaining = CUMULATIVE[2] - result.distanceAlongRouteMeters;
    const liveArrival = new Date(
      NOW.getTime() + (remaining / (25 * MPH_TO_MPS)) * 1000,
    );
    expect(result.stopEtas[1].arrival?.getTime()).toBe(liveArrival.getTime());

    // And it genuinely differs from what the static leg average would say.
    const staticArrival = new Date(
      NOW.getTime() + (remaining / (LEG_DISTANCES[0] / LEG_DURATIONS[0])) * 1000,
    );
    expect(liveArrival.getTime()).not.toBe(staticArrival.getTime());
  });

  it('vehicle stopped or speed unknown: falls back to the current leg average, exactly', () => {
    const position = { lat: 41.005, lng: -87.65 };

    for (const speed of [null, 0, 2, 3]) {
      const result = estimate(position, speed);

      expect(result.nextStopIndex).toBe(1);
      const remaining = CUMULATIVE[2] - result.distanceAlongRouteMeters;
      const fallbackPace = LEG_DISTANCES[0] / LEG_DURATIONS[0];
      const expectedArrival = new Date(
        NOW.getTime() + (remaining / fallbackPace) * 1000,
      );
      expect(result.stopEtas[1].arrival?.getTime()).toBe(
        expectedArrival.getTime(),
      );
      expect(result.stopEtas[1].departure?.getTime()).toBe(
        expectedArrival.getTime() + DWELL_MINUTES[1] * 60 * 1000,
      );
    }
  });

  it('vehicle at the final stop: nextStopIndex null, every ETA null', () => {
    const result = estimate({ lat: 41.04, lng: -87.65 }, 20);

    expect(result.distanceAlongRouteMeters).toBeCloseTo(
      CUMULATIVE[CUMULATIVE.length - 1],
      6,
    );
    expect(result.nextStopIndex).toBeNull();
    expect(result.stopEtas).toEqual([
      { arrival: null, departure: null },
      { arrival: null, departure: null },
      { arrival: null, departure: null },
    ]);
  });

  it('vehicle far off the route: large off-route distance reported, estimate still returned', () => {
    // ~8 km due west of a point midway through leg 1.
    const result = estimate({ lat: 41.025, lng: -87.75 }, 20);

    expect(result.distanceFromRouteMeters).toBeGreaterThan(5000);
    // The estimate itself is still produced honestly — deciding whether to
    // trust/flag it is F4's job, not this layer's.
    expect(result.nextStopIndex).toBe(2);
    expect(result.stopEtas[2].arrival).toBeInstanceOf(Date);
  });

  it('throws loudly on inconsistent leg/stop/dwell counts', () => {
    expect(() =>
      estimateTripProgress({
        legDistancesMeters: LEG_DISTANCES,
        legDurationsSeconds: LEG_DURATIONS,
        dwellMinutes: [0, 5], // one dwell short for 3 stops
        geometry: GEOMETRY,
        legBoundaryIndices: LEG_BOUNDARY_INDICES,
        vehiclePosition: { lat: 41.0, lng: -87.65 },
        vehicleSpeedMph: null,
        now: NOW,
      }),
    ).toThrow(/inconsistent route data/);
  });
});
