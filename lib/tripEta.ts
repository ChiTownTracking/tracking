import { cumulativeDistances, nearestPointOnRoute } from './routeGeometry';

// Phase F3: live trip-progress estimation. Pure computation — the caller
// (F4's public API) supplies the stored Route data plus a live vehicle fix,
// and decides for itself what to do with a low-confidence result
// (distanceFromRouteMeters is reported honestly, never hidden).

const MPH_TO_METERS_PER_SECOND = 0.44704;

// Below this the speed reading means "stopped/idling at a light or a stop",
// not a trustworthy forward-progress signal — fall back to the leg's own
// average pace instead of projecting a near-zero crawl to the next stop.
const MIN_MOVING_SPEED_MPH = 3;

// Float slack (in meters) when deciding whether a stop has been reached:
// distance-along-route is rebuilt from a segment projection, so "exactly at
// the stop" can land an ulp short of the stop's own cumulative distance.
const STOP_REACHED_EPSILON_METERS = 1e-6;

export interface TripProgressInput {
  legDistancesMeters: number[];
  legDurationsSeconds: number[];
  // Per stop, same order as legBoundaryIndices.
  dwellMinutes: number[];
  // [lat, lng] pairs, same convention as the stored Route.
  geometry: [number, number][];
  legBoundaryIndices: number[];
  vehiclePosition: { lat: number; lng: number };
  vehicleSpeedMph: number | null;
  now: Date;
}

export interface TripProgressEstimate {
  distanceAlongRouteMeters: number;
  distanceFromRouteMeters: number;
  // null once at/past the final stop.
  nextStopIndex: number | null;
  // One entry per stop; both null for already-passed stops.
  stopEtas: { arrival: Date | null; departure: Date | null }[];
}

export function estimateTripProgress(
  input: TripProgressInput,
): TripProgressEstimate {
  const {
    legDistancesMeters,
    legDurationsSeconds,
    dwellMinutes,
    geometry,
    legBoundaryIndices,
    vehiclePosition,
    vehicleSpeedMph,
    now,
  } = input;

  const stopCount = legBoundaryIndices.length;
  // Fail loudly on inconsistent route data — an off-by-one here would produce
  // ETAs for the wrong stops, which is worse than no ETA.
  if (
    dwellMinutes.length !== stopCount ||
    legDistancesMeters.length !== stopCount - 1 ||
    legDurationsSeconds.length !== stopCount - 1
  ) {
    throw new Error(
      `estimateTripProgress: inconsistent route data (${stopCount} stops, ` +
        `${dwellMinutes.length} dwells, ${legDistancesMeters.length} leg ` +
        `distances, ${legDurationsSeconds.length} leg durations)`,
    );
  }

  const { distanceAlongRouteMeters, distanceFromRouteMeters } =
    nearestPointOnRoute(vehiclePosition, geometry);
  const cumulative = cumulativeDistances(geometry);
  const stopDistances = legBoundaryIndices.map((index) => cumulative[index]);

  // First stop strictly ahead of the vehicle. Stop 0 sits at distance 0, so
  // this is always >= 1 (a vehicle at the very start has "reached" stop 0
  // and is heading to stop 1); null means at/past the final stop.
  let nextStopIndex: number | null = null;
  for (let stop = 0; stop < stopCount; stop++) {
    if (stopDistances[stop] > distanceAlongRouteMeters + STOP_REACHED_EPSILON_METERS) {
      nextStopIndex = stop;
      break;
    }
  }

  const stopEtas: { arrival: Date | null; departure: Date | null }[] =
    Array.from({ length: stopCount }, () => ({ arrival: null, departure: null }));

  if (nextStopIndex !== null) {
    // Live speed if the vehicle is genuinely moving; otherwise the current
    // leg's own static average pace (nextStopIndex >= 1, so the leg leading
    // into it is legs[nextStopIndex - 1]).
    const currentLeg = nextStopIndex - 1;
    const effectiveSpeedMetersPerSecond =
      vehicleSpeedMph !== null && vehicleSpeedMph > MIN_MOVING_SPEED_MPH
        ? vehicleSpeedMph * MPH_TO_METERS_PER_SECOND
        : legDistancesMeters[currentLeg] / legDurationsSeconds[currentLeg];

    const remainingMeters =
      stopDistances[nextStopIndex] - distanceAlongRouteMeters;
    const arrival = new Date(
      now.getTime() + (remainingMeters / effectiveSpeedMetersPerSecond) * 1000,
    );
    stopEtas[nextStopIndex] = {
      arrival,
      departure: new Date(
        arrival.getTime() + dwellMinutes[nextStopIndex] * 60 * 1000,
      ),
    };

    // Every stop past the next one runs on static leg durations — the live
    // signal only informs the leg actually being driven.
    for (let stop = nextStopIndex + 1; stop < stopCount; stop++) {
      const previousDeparture = stopEtas[stop - 1].departure as Date;
      const stopArrival = new Date(
        previousDeparture.getTime() + legDurationsSeconds[stop - 1] * 1000,
      );
      stopEtas[stop] = {
        arrival: stopArrival,
        departure: new Date(
          stopArrival.getTime() + dwellMinutes[stop] * 60 * 1000,
        ),
      };
    }
  }

  return {
    distanceAlongRouteMeters,
    distanceFromRouteMeters,
    nextStopIndex,
    stopEtas,
  };
}
