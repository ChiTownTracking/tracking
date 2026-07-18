// Pure derivation for the board page's trip cards: status line, per-stop
// chip state, and per-stop chip time. Extracted from the page (Phase G2) so
// the data-shaping is testable — the JSX only paints what these return.
//
// Typed structurally (just the fields these functions read) rather than
// importing the component's response mirrors — lib stays free of component
// imports.

export interface StopEta {
  arrival: string | null;
  departure: string | null;
}

export interface TripProgressLike {
  position: object | null;
  nextStopIndex: number | null;
  stopEtas: StopEta[] | null;
}

export type StopChipState = 'passed' | 'current' | 'upcoming';

// ISO timestamp → "2:14 PM", the same 12-hour convention as the recurring
// schedule chips (ScheduleTimeline.formatDeparture), fed by a Date instead
// of a stored "HH:mm".
export function formatBoardTime(iso: string): string {
  const date = new Date(iso);
  const hours = date.getHours();
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(date.getMinutes()).padStart(2, '0')} ${suffix}`;
}

// The status line under each card's title, derived from live progress.
// "arrival passed, departure hasn't" IS a reachable client-side state: ETAs
// are stamped server-side at fetch time, and the page's clock keeps moving
// between 30-second polls.
export function boardStatusLine(
  trip: TripProgressLike,
  stopLabels: string[],
  now: Date,
): string {
  if (!trip.position) {
    return 'Position unavailable';
  }
  // G2 fix: a null stopEtas with a live position means the ESTIMATE is
  // unavailable (degraded route data), not that the vehicle finished its
  // route — the old code lumped this into "At the final stop", which was
  // simply false. Say what's actually known.
  if (!trip.stopEtas) {
    return 'Live position shown — arrival times unavailable';
  }
  if (trip.nextStopIndex === null) {
    return 'At the final stop';
  }
  const stopLabel = stopLabels[trip.nextStopIndex] ?? 'the next stop';
  const eta = trip.stopEtas[trip.nextStopIndex];
  const arrival = eta?.arrival ? new Date(eta.arrival) : null;
  const departure = eta?.departure ? new Date(eta.departure) : null;
  if (arrival && arrival > now) {
    return `En route to ${stopLabel} · arriving ${formatBoardTime(eta.arrival!)}`;
  }
  if (departure && departure > now) {
    return `At ${stopLabel} · departs ${formatBoardTime(eta.departure!)}`;
  }
  // Both times already behind the clock (a stale estimate between polls) —
  // still honest, just without a time promise.
  return `En route to ${stopLabel}`;
}

// Three-state chip logic, same visual language as ScheduleTimeline: no live
// data at all → every stop is a quiet upcoming chip; with data, a null-times
// entry means the vehicle already passed it.
export function stopChipState(
  stopEtas: StopEta[] | null,
  nextStopIndex: number | null,
  index: number,
): StopChipState {
  if (!stopEtas) {
    return 'upcoming';
  }
  const eta = stopEtas[index];
  if (!eta?.arrival && !eta?.departure) {
    return 'passed';
  }
  return index === nextStopIndex ? 'current' : 'upcoming';
}

// The one time a chip shows: the arrival while it's still ahead, then the
// departure once the arrival has passed (the dwell window). Null when the
// stop has no times at all (passed, or no estimate) — the chip keeps its
// label either way.
export function stopChipTime(eta: StopEta | null, now: Date): string | null {
  if (!eta) {
    return null;
  }
  if (eta.arrival && new Date(eta.arrival) > now) {
    return formatBoardTime(eta.arrival);
  }
  if (eta.departure) {
    return formatBoardTime(eta.departure);
  }
  return eta.arrival ? formatBoardTime(eta.arrival) : null;
}
