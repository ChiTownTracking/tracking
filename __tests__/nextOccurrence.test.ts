import { describe, expect, it } from 'vitest';
import { nextOccurrenceOf } from '@/lib/nextOccurrence';

// All instants chosen in July — Chicago is CDT (UTC-5), so e.g.
// 2026-07-17T12:00:00Z is 07:00:00 on Chicago's wall clock.
describe('nextOccurrenceOf', () => {
  it('returns today at the target time when it has not happened yet (Chicago)', () => {
    const now = new Date('2026-07-17T12:00:00Z'); // 07:00:00 Chicago
    const next = nextOccurrenceOf('08:30', now);
    expect(next.toISOString()).toBe('2026-07-17T13:30:00.000Z'); // 08:30 CDT today
  });

  it('returns tomorrow at the target time when it already passed today', () => {
    const now = new Date('2026-07-17T12:00:00Z'); // 07:00:00 Chicago
    const next = nextOccurrenceOf('06:00', now);
    expect(next.toISOString()).toBe('2026-07-18T11:00:00.000Z'); // 06:00 CDT tomorrow
  });

  it('treats now-inside-the-target-minute as "has not happened yet" — the chosen boundary convention', () => {
    // 07:00:30 Chicago vs a target of "07:00": minute-granularity comparison
    // says today, positioned exactly on 07:00:00 (30s behind now).
    const now = new Date('2026-07-17T12:00:30Z');
    const next = nextOccurrenceOf('07:00', now);
    expect(next.toISOString()).toBe('2026-07-17T12:00:00.000Z');
  });
});
