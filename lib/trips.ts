import type { Waypoint } from './trackingTokens';

// Phase I1: Route collapsed INTO Trip — one entity, one name (lib/routes.ts
// is gone). A Trip is one physical path (waypoints + ORS geometry) run by
// one or more vehicles, each on its own schedule of runs. The old
// Route/Trip split earned its keep when several trips shared a route's
// geometry; with multi-vehicle assignments living on the trip itself, the
// indirection had nothing left to do.

// One run: the vehicle arrives at the FIRST waypoint at arrivalTime and
// waits there waitMinutes before departing. Wait time is per-RUN, not
// per-stop — the old per-waypoint dwellMinutes is deliberately gone, so
// there is exactly one source of wait truth and no stale second copy.
export interface ScheduleEntry {
  id: string;
  // "HH:mm" wall-clock arrival at the first waypoint (24-hour,
  // America/Chicago) — same format and validation as every schedule field
  // before it.
  arrivalTime: string;
  waitMinutes: number;
  // Phase K1: Google's traffic-aware first-to-last-waypoint duration for
  // this run's departure time, computed best-effort at creation. ABSENT
  // (never zero/null) when no prediction exists — a failed Google call
  // doesn't block trip creation.
  predictedArrivalDurationSeconds?: number;
  // The same response's traffic-free baseline (Google's staticDuration),
  // stored RAW alongside the prediction — the two bound the display-time
  // arrival range. Same absent-not-null convention; set and absent
  // together with predictedArrivalDurationSeconds (one Google response
  // carries both).
  predictedArrivalStaticDurationSeconds?: number;
  // Phase L1: true = this run was cancelled by staff. Absent means normal
  // — never store false explicitly, same absent-means-default convention
  // as every optional field in this file.
  cancelled?: boolean;
}

// One vehicle's runs on this trip — always at least one entry at CREATION
// (enforced at the API layer). Phase L1's replace flow can later leave an
// assignment with an empty schedule: the assignment stays as the history
// record (and serviceNote holder) for runs that already happened on it.
export interface VehicleAssignment {
  vehicleId: string;
  schedule: ScheduleEntry[];
  // Phase L1: staff-facing explanation attached by cancel/replace ("bus
  // broke down", "swapped for maintenance"). Absent when never set.
  serviceNote?: string;
}

export interface Trip {
  id: string;
  // The trip-link credential: a 122-bit random UUID, same
  // entropy/generation as tracking-link tokens. Minted at creation.
  token: string;
  name: string;
  // Plain label/lat/lng waypoints — see the ScheduleEntry note for why no
  // per-waypoint dwell exists anymore.
  waypoints: Waypoint[];
  // [lat, lng] pairs, same convention as everywhere above orsClient.
  geometry: [number, number][];
  // One entry per consecutive waypoint pair, in order — ORS's per-leg
  // properties.segments.
  legs: { distanceMeters: number; durationSeconds: number }[];
  // Index into geometry where each waypoint sits — ORS's way_points.
  legBoundaryIndices: number[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  vehicles: VehicleAssignment[];
  createdAt: string;
}
