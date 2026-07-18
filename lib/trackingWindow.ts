// Pure window logic for customer tracking links. Inclusive on both ends:
// a request landing exactly on windowStart or windowEnd is still in-window.

// Customer-facing copy for the out-of-window states, shared by the bare
// track endpoint and the per-route endpoint so the wording can't drift.
export const WINDOW_MESSAGES = {
  not_started:
    'Tracking for this trip has not started yet. Check back closer to your pickup time.',
  ended: 'Tracking for this trip has ended. We hope you enjoyed the ride!',
} as const;

export function isWithinWindow(
  windowStart: string,
  windowEnd: string,
  now: Date = new Date(),
): boolean {
  const time = now.getTime();
  return (
    time >= new Date(windowStart).getTime() &&
    time <= new Date(windowEnd).getTime()
  );
}

export function getWindowStatus(
  windowStart: string,
  windowEnd: string,
  now: Date = new Date(),
): 'not_started' | 'active' | 'ended' {
  const time = now.getTime();
  if (time < new Date(windowStart).getTime()) {
    return 'not_started';
  }
  if (time > new Date(windowEnd).getTime()) {
    return 'ended';
  }
  return 'active';
}
