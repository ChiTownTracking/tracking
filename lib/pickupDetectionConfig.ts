// Phase N7: the three tunables behind live pickup-arrival detection —
// "was the vehicle actually at the first stop when it was supposed to be?"
//
// Deliberately its own tiny file rather than an addition to
// tripEstimateConfig.ts: that file exists to hold ONE number, the bus-vs-car
// duration buffer applied to Google's predictions, and says so. These three
// govern a different question entirely (geofence + time window around a
// scheduled arrival), and burying them under an estimate-buffer heading
// would make neither easy to find later. Same one-obvious-place-to-tune
// spirit, one file per concept.

// How close (great-circle metres, lib/routeGeometry.haversineMeters) the
// vehicle must be to the FIRST waypoint to count as "at the pickup".
// Widened from 50 m after live observation: a bus that had visibly pulled
// up at the stop was still measuring outside 50 m of the stored waypoint
// coordinate — kerb-to-pin offset, plus whatever slack is in the GPS fix.
export const PICKUP_DETECTION_RADIUS_METERS = 100;

// How many minutes BEFORE the scheduled arrival detection may start — an
// early bus still counts, but only this early.
export const PICKUP_EARLY_WINDOW_MINUTES = 5;

// How many minutes AFTER the scheduled arrival detection stops — past this
// cutoff the pickup is treated as unconfirmed, not late-detected.
export const PICKUP_LATE_WINDOW_MINUTES = 10;
