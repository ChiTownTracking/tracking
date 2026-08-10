// Google's Routes API has no bus/heavy-vehicle travel mode — DRIVE models a
// standard passenger car. This is a manual placeholder buffer, not sourced
// data, chosen because a real bus-vs-car comparison doesn't exist yet. Once
// real trips have run, compare actual arrival times against Google's
// predictions and adjust this number based on real observed data, not
// guesswork.
//
// Deliberately its own tiny file: the single obvious place to find and tune
// this later.
export const BUS_DURATION_BUFFER = 1.1; // 10% starting estimate

// Phase P: how long past a run's ESTIMATED finish to wait before calling
// the drop-off complete on time alone, when the vehicle never reports
// within range of the last waypoint (a dark fix, a stop short of the pin,
// a drop-off point a little off the stored coordinate).
//
// It belongs in this file rather than with the geofence constants because
// it is grace on top of a travel-duration ESTIMATE, which is what this
// file is for — and the estimate it pads is measured from the REAL
// observed departure (lib/trips.ScheduleEntry.actualDepartureAt), never
// from a scheduled time plus an assumed wait. That anchoring is the same
// correction that produced departure detection itself: start the clock
// from something that actually happened.
export const DROPOFF_FALLBACK_MINUTES_AFTER_ESTIMATE = 5;
