import type { Vehicle } from './liveVehicles';
import { estimateTripProgress } from './tripEta';

// One live fix + one trip's static path → the ETA summary, degraded
// honestly to null when the estimate can't run. dwellMinutes arrives from
// the caller because wait time is per-RUN now (Phase I1): the active
// schedule entry's pickup wait at stop 0, zeros everywhere after.

// A real vehicle drifts from the mapped polyline (GPS noise, a minor
// detour), so "on route" needs slack. 200m is a starting threshold, not a
// researched figure — adjustable like the public rate limits. Only the
// boolean leaves this module: a public page can say "less reliable" without
// handing out precise vehicle-tracking-accuracy internals.
const POSITION_CONFIDENCE_MAX_DRIFT_METERS = 200;

// Just the static-path fields the estimator needs — structural, so callers
// can pass a Trip without this module importing its type.
export interface TripPath {
  legs: { distanceMeters: number; durationSeconds: number }[];
  geometry: [number, number][];
  legBoundaryIndices: number[];
}

export interface LiveProgressSummary {
  // true = within the off-route drift threshold of the mapped polyline;
  // false = far enough off that the ETA deserves a "may be less reliable"
  // note; null = the estimate itself was unavailable.
  positionConfident: boolean | null;
  nextStopIndex: number | null;
  stopEtas: { arrival: string | null; departure: string | null }[] | null;
}

export function summarizeLiveProgress(
  path: TripPath,
  dwellMinutes: number[],
  live: Vehicle,
  tripId: string,
): LiveProgressSummary {
  try {
    const progress = estimateTripProgress({
      legDistancesMeters: path.legs.map((leg) => leg.distanceMeters),
      legDurationsSeconds: path.legs.map((leg) => leg.durationSeconds),
      dwellMinutes,
      geometry: path.geometry,
      legBoundaryIndices: path.legBoundaryIndices,
      vehiclePosition: { lat: live.latitude, lng: live.longitude },
      vehicleSpeedMph: live.speed ?? null,
      now: new Date(),
    });
    return {
      positionConfident:
        progress.distanceFromRouteMeters < POSITION_CONFIDENCE_MAX_DRIFT_METERS,
      nextStopIndex: progress.nextStopIndex,
      stopEtas: progress.stopEtas.map((eta) => ({
        arrival: eta.arrival?.toISOString() ?? null,
        departure: eta.departure?.toISOString() ?? null,
      })),
    };
  } catch (error) {
    // Bad trip data (estimateTripProgress fails loudly on inconsistency)
    // degrades this vehicle's progress to null; the caller's position and
    // speed come straight from the live fix and stay usable.
    console.warn(`live progress estimate failed for trip ${tripId}:`, error);
    return { positionConfident: null, nextStopIndex: null, stopEtas: null };
  }
}
