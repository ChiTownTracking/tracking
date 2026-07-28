import { googleMapsClient } from './googleMapsClient';
import { nextOccurrenceOf } from './nextOccurrence';

// Phase O1: the ONE place that turns "these departure clocks need traffic
// predictions" into actual Google calls. Extracted verbatim from trip
// creation's inline block so per-run editing reuses the exact same
// behavior rather than growing a second, drifting copy of it — same
// discipline as the getStatusForOccurrence extraction in N6.
//
// Two rules, both inherited from creation and both load-bearing:
//
//  1. ONE call per clock, never per run. Several runs across several
//     vehicles sharing a departure time share a single prediction, so the
//     caller passes distinct clocks and anything already known via
//     existingClockPredictions costs nothing at all.
//  2. BEST-EFFORT, always. A failed prediction is logged server-side and
//     resolves to null for THAT clock only; this function never throws and
//     never lets one clock's failure affect another's. Callers store the
//     null as "no prediction" (absent fields), exactly as creation does —
//     a Google outage must not block creating or editing a trip.
//
// Both raw numbers come back exactly as Google returned them. The
// bus-vs-car buffer is a display-time adjustment (lib/departureTime +
// tripEstimateConfig), never baked into stored data.
export interface ClockPrediction {
  predictedDurationSeconds: number;
  staticDurationSeconds: number;
}

export async function resolvePredictionsForClocks(
  clocks: string[],
  firstWaypoint: { lat: number; lng: number },
  lastWaypoint: { lat: number; lng: number },
  // clock -> a prediction already known for it (a sibling run departing at
  // the same time, or creation's initially-empty map). Present means REUSE
  // it directly: no Google call is spent re-asking a question already
  // answered.
  existingClockPredictions: Map<string, ClockPrediction>,
  // Optional caller context for the failure log only (creation passes the
  // trip name, preserving its original message) — never affects behavior.
  logContext?: string,
): Promise<Map<string, ClockPrediction | null>> {
  const resolved = new Map<string, ClockPrediction | null>();
  // Defensive de-dup: rule 1 holds even if a caller passes a clock twice.
  const distinctClocks = [...new Set(clocks)];

  await Promise.all(
    distinctClocks.map(async (clock) => {
      const known = existingClockPredictions.get(clock);
      if (known !== undefined) {
        resolved.set(clock, known);
        return;
      }
      try {
        // First waypoint → last waypoint direct (no intermediates): this is
        // the single "estimated arrival at the final stop" number, not a
        // per-leg breakdown.
        const prediction = await googleMapsClient.predictArrival(
          { lat: firstWaypoint.lat, lng: firstWaypoint.lng },
          { lat: lastWaypoint.lat, lng: lastWaypoint.lng },
          nextOccurrenceOf(clock, new Date()),
        );
        resolved.set(clock, prediction);
      } catch (error) {
        console.error(
          `arrival prediction failed (${
            logContext !== undefined ? `${logContext}, ` : ''
          }departure ${clock}):`,
          error,
        );
        // Attempted and failed — distinct from "never asked", which is
        // simply an absent key.
        resolved.set(clock, null);
      }
    }),
  );

  return resolved;
}
