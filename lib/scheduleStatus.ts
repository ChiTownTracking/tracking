export type TripStatus = 'upcoming' | 'in-progress' | 'completed';

// Interprets a "HH:mm" departure time as America/Chicago wall-clock time for
// TODAY, regardless of where the server or the viewer's browser thinks it
// is: `now` is converted to Chicago's current wall clock via
// Intl.DateTimeFormat with an explicit timeZone, never via local-timezone
// Date math. hourCycle 'h23' pins midnight to "00", not "24".
const chicagoClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function chicagoSecondsOfDay(now: Date): number {
  const parts = chicagoClock.formatToParts(now);
  const read = (type: 'hour' | 'minute' | 'second'): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return read('hour') * 3600 + read('minute') * 60 + read('second');
}

// Phase N6: the lower-level primitive — status of a CONCRETE occurrence
// (a real instant), rather than one derived internally from "today at
// HH:mm." lib/scheduleOccurrence.ts calls this once it has resolved
// exactly which calendar day's occurrence is in question (today,
// tomorrow, ...); getTripStatus below is now just this function's
// "today" special case, kept as-is for its many existing callers.
export function getStatusForOccurrence(
  occurrenceStart: Date,
  durationSeconds: number,
  now: Date,
): TripStatus {
  const startMs = occurrenceStart.getTime();
  const endMs = startMs + durationSeconds * 1000;
  const nowMs = now.getTime();

  // Both boundaries are inclusive on the later state: exactly at departure
  // is in-progress, exactly at departure + duration is completed.
  if (nowMs < startMs) {
    return 'upcoming';
  }
  if (nowMs < endMs) {
    return 'in-progress';
  }
  return 'completed';
}

export function getTripStatus(
  scheduledTime: string,
  durationSeconds: number,
  now: Date,
): TripStatus {
  const [hours, minutes] = scheduledTime.split(':').map(Number);
  const targetSeconds = hours * 3600 + minutes * 60;
  const nowSeconds = chicagoSecondsOfDay(now);
  // "Today at scheduledTime" as a real instant: `now` shifted by the
  // difference between the target clock time and now's own clock time.
  // Algebraically identical to the original raw-seconds-of-day comparison
  // this replaced — the shift cancels out on both sides of
  // getStatusForOccurrence's comparisons — so existing behavior (and every
  // existing test) is unchanged.
  const occurrenceStart = new Date(
    now.getTime() + (targetSeconds - nowSeconds) * 1000,
  );
  return getStatusForOccurrence(occurrenceStart, durationSeconds, now);
}
