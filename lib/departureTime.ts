import { BUS_DURATION_BUFFER } from './tripEstimateConfig';

// Phase K1/K2: pure wrap-safe clock math for schedule-derived times. All
// functions share one helper: total minutes modulo 24h, so late-night times
// wrap past midnight instead of producing "24:15" — the same math as the
// create-trip UI's live "→ departs 07:30" preview (computeDeparture in
// dashboard/trips/new), mirrored, not diverged.
function addMinutesToClock(clock: string, minutesToAdd: number): string {
  const [hours, minutes] = clock.split(':').map(Number);
  const total = (hours * 60 + minutes + minutesToAdd) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(
    total % 60,
  ).padStart(2, '0')}`;
}

// Arrival-at-first-stop + wait = the run's actual departure clock time.
export function computeDepartureClock(
  arrivalTime: string,
  waitMinutes: number,
): string {
  return addMinutesToClock(arrivalTime, waitMinutes);
}

// Departure + predicted drive time = predicted arrival at the final stop
// (Phase K2). Seconds round to the nearest whole minute (90s → +2, not +1)
// — clock display has no half-minutes, and rounding beats truncating for an
// arrival promise.
export function computePredictedArrivalClock(
  departureClock: string,
  durationSeconds: number,
): string {
  return addMinutesToClock(departureClock, Math.round(durationSeconds / 60));
}

// The displayed arrival RANGE: Google's traffic prediction and traffic-free
// baseline, each stretched by the bus-vs-car buffer (buses aren't the
// passenger car DRIVE models — see tripEstimateConfig), then ordered by
// Math.min/Math.max — the traffic prediction is routinely the SMALLER
// number (light-traffic departures beat the baseline), so neither raw field
// can be assumed to be the early end. Buffer applies to BOTH ends: the
// range is bus-adjusted throughout, not car-fast on one side.
export function computePredictedArrivalRange(
  departureClock: string,
  predictedDurationSeconds: number,
  staticDurationSeconds: number,
): { early: string; late: string } {
  const buffered = (seconds: number) =>
    Math.round(seconds * BUS_DURATION_BUFFER);
  const bufferedPredicted = buffered(predictedDurationSeconds);
  const bufferedStatic = buffered(staticDurationSeconds);
  return {
    early: computePredictedArrivalClock(
      departureClock,
      Math.min(bufferedPredicted, bufferedStatic),
    ),
    late: computePredictedArrivalClock(
      departureClock,
      Math.max(bufferedPredicted, bufferedStatic),
    ),
  };
}
