// Phase K1: turns a "HH:mm" Chicago wall-clock time into the real future
// instant of its next occurrence — the Date that traffic-aware arrival
// prediction sends Google as departureTime.
//
// Same Chicago-anchoring technique as scheduleStatus.ts: `now` is read as
// Chicago's current wall clock via Intl.DateTimeFormat with an explicit
// timeZone (never local-timezone Date math), hourCycle 'h23' so midnight is
// "00", not "24".
const chicagoClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function chicagoClockParts(now: Date): {
  hour: number;
  minute: number;
  second: number;
} {
  const parts = chicagoClock.formatToParts(now);
  const read = (type: 'hour' | 'minute' | 'second'): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return { hour: read('hour'), minute: read('minute'), second: read('second') };
}

const DAY_SECONDS = 24 * 3600;

// If the given HH:mm hasn't happened yet today (Chicago time), returns
// today at that time; already passed → tomorrow at that time. Chosen
// convention, pinned by test: when `now` is INSIDE the target minute
// (07:00:30 vs "07:00"), that counts as "hasn't happened yet" — the
// comparison is at minute granularity, so it returns today's 07:00:00.
export function nextOccurrenceOf(time: string, now: Date): Date {
  const [hours, minutes] = time.split(':').map(Number);
  const targetSeconds = hours * 3600 + minutes * 60;

  const clock = chicagoClockParts(now);
  const nowSeconds = clock.hour * 3600 + clock.minute * 60 + clock.second;
  // Minute-truncated for the today-vs-tomorrow decision (the boundary
  // convention above); the full seconds value positions the result exactly
  // on HH:mm:00.
  const nowMinuteSeconds = clock.hour * 3600 + clock.minute * 60;

  const dayOffset = targetSeconds >= nowMinuteSeconds ? 0 : DAY_SECONDS;
  return new Date(
    now.getTime() + (targetSeconds + dayOffset - nowSeconds) * 1000,
  );
}
