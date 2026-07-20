// Formats a Date into the "YYYY-MM-DDTHH:mm" shape <input type="datetime-local">
// expects: LOCAL wall-clock time (matching how the browser itself reads
// and displays these strings — the same interpretation createLinkInput's
// `new Date(windowStart)` relies on to convert back to UTC), truncated to
// the minute by simply omitting seconds/ms — datetime-local has no
// seconds field by default, so this drops them rather than rounding.
export function toDatetimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

// A window-field default START of "now". Each call reads a fresh
// `new Date()`, so calling this again later (e.g. for a new route block
// added mid-form) reflects that real moment, not page-load time.
export function defaultWindowStart(): string {
  return toDatetimeLocalValue(new Date());
}

// The matching END, `hoursFromStart` hours after now. One function shared
// by both callers instead of near-duplicates: create-link passes 12 (a
// same-day booking window), trip creation passes 24 * 7 (a week). Same
// fresh-`Date` semantics as the start.
export function defaultWindowEnd(hoursFromStart: number): string {
  return toDatetimeLocalValue(
    new Date(Date.now() + hoursFromStart * 60 * 60 * 1000),
  );
}
