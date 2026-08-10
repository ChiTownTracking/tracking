// Chicago-anchored calendar-date and wall-clock helpers, extracted from
// tripDetail.ts's formatActiveRunDate (Phase N7) the moment a second caller
// needed the same "which REAL calendar day is this occurrence on?" answer.
//
// Pickup detection (lib/pickupDetection.ts) stamps a detection with the
// occurrence's date, and lib/tripDetail.ts decides whether a stored stamp
// belongs to the occurrence it's about to display. Those two answers must
// agree exactly, so there is one implementation here rather than a second
// (and a third) copy of the same Intl dance.
//
// Same technique as scheduleStatus/nextOccurrence/scheduleOccurrence:
// Intl.DateTimeFormat with an explicit timeZone, never local-timezone Date
// math — the server runs in UTC.

// en-CA renders "2026-07-17" natively, which IS the "YYYY-MM-DD" storage
// format, so no manual joining is needed.
const chicagoYmd = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// A Date that FORMATS as the Chicago calendar day dateOffsetDays away from
// `now` (0 = today, 1 = tomorrow — the same offset convention as
// ActiveScheduleSelection.dateOffsetDays).
//
// Offset 0 is `now` itself. Any other offset advances the Chicago calendar
// date and re-anchors at UTC noon — well clear of the 2 AM DST switch, and
// Date normalizes month/year rollover — so a DST boundary can never
// mis-date it.
export function chicagoCalendarAnchor(now: Date, dateOffsetDays: number): Date {
  if (dateOffsetDays === 0) {
    return now;
  }
  const parts = chicagoYmd.formatToParts(now);
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return new Date(
    Date.UTC(read('year'), read('month') - 1, read('day') + dateOffsetDays, 12),
  );
}

// "YYYY-MM-DD" for that same day — the date-scoping key stored alongside a
// pickup detection.
export function chicagoDateLabel(now: Date, dateOffsetDays: number): string {
  return chicagoYmd.format(chicagoCalendarAnchor(now, dateOffsetDays));
}

const chicagoClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
});

// A real instant (e.g. a stored ISO detection timestamp) → its Chicago
// wall clock as "HH:mm" — the SAME storage format every schedule field
// uses, so lib/clockFormat.formatClock12Hour stays the app's one and only
// 12-hour renderer instead of gaining a rival. (boardStatus.formatBoardTime
// reads an ISO string with local-timezone getHours(); that's fine for its
// browser-side callers, but wrong on a UTC server, which is why this exists
// rather than reusing it.)
export function chicagoClock24(instant: Date): string {
  return chicagoClock.format(instant);
}
