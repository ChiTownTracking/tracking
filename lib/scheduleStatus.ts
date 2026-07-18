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

export function getTripStatus(
  scheduledTime: string,
  durationSeconds: number,
  now: Date,
): TripStatus {
  const [hours, minutes] = scheduledTime.split(':').map(Number);
  const startSeconds = hours * 3600 + minutes * 60;
  const endSeconds = startSeconds + durationSeconds;
  const nowSeconds = chicagoSecondsOfDay(now);

  // Both boundaries are inclusive on the later state: exactly at departure
  // is in-progress, exactly at departure + duration is completed.
  if (nowSeconds < startSeconds) {
    return 'upcoming';
  }
  if (nowSeconds < endSeconds) {
    return 'in-progress';
  }
  return 'completed';
}
