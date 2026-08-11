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

// The absolute ceiling on how long a schedule row may keep reading "In
// progress" (lib/dailySchedule.resolveDisplayStatus): a run can never
// still be under way more than this long past its scheduled instant plus
// its own travel duration, whatever the stored facts do or don't say.
//
// Deliberately INDEPENDENT of the grace periods above and of the pickup
// geofence windows (lib/pickupDetectionConfig.ts) — those exist to decide
// whether something really happened, and they are unchanged and still do
// exactly that job. This one decides nothing about reality: it is a
// display guarantee, tuned purely for how long a stale "In progress" is
// tolerable on screen. Tuning one must never mean tuning the other, which
// is why it is its own number rather than a reuse of
// DROPOFF_FALLBACK_MINUTES_AFTER_ESTIMATE despite currently sharing its
// value.
export const IN_PROGRESS_ABSOLUTE_GRACE_MINUTES = 5;
