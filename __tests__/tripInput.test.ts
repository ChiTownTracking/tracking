import { describe, expect, it } from 'vitest';
import { createTripInputSchema } from '@/lib/tripInput';

// A minimal valid trip-creation payload — two stops, one vehicle with one
// run, and the Phase N3 active window.
const valid = {
  name: 'North Shore Run',
  windowStart: '2026-07-20T14:00:00.000Z',
  windowEnd: '2026-07-27T14:00:00.000Z',
  waypoints: [
    { label: 'Chicago Union Station', lat: 41.878988, lng: -87.639732 },
    { label: 'Wrigley Field', lat: 41.948437, lng: -87.655334 },
  ],
  vehicles: [
    {
      vehicleId: '1000067169',
      schedule: [{ arrivalTime: '07:00', waitMinutes: 10 }],
    },
  ],
};

describe('createTripInputSchema (Phase N3 window)', () => {
  it('accepts a valid payload with a window', () => {
    expect(createTripInputSchema.safeParse(valid).success).toBe(true);
  });

  it('requires windowStart', () => {
    const { windowStart: _omitted, ...withoutStart } = valid;
    expect(createTripInputSchema.safeParse(withoutStart).success).toBe(false);
  });

  it('requires windowEnd', () => {
    const { windowEnd: _omitted, ...withoutEnd } = valid;
    expect(createTripInputSchema.safeParse(withoutEnd).success).toBe(false);
  });

  it('rejects a non-ISO windowStart', () => {
    const result = createTripInputSchema.safeParse({
      ...valid,
      windowStart: 'next tuesday',
    });
    expect(result.success).toBe(false);
  });

  it('rejects windowEnd equal to windowStart (strictly after required)', () => {
    const result = createTripInputSchema.safeParse({
      ...valid,
      windowStart: valid.windowStart,
      windowEnd: valid.windowStart,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        'windowEnd must be after windowStart',
      );
    }
  });

  it('rejects windowEnd before windowStart via the refine', () => {
    const result = createTripInputSchema.safeParse({
      ...valid,
      windowStart: valid.windowEnd,
      windowEnd: valid.windowStart,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        'windowEnd must be after windowStart',
      );
    }
  });

  it('still enforces the pre-existing rules (>=2 waypoints)', () => {
    const result = createTripInputSchema.safeParse({
      ...valid,
      waypoints: [valid.waypoints[0]],
    });
    expect(result.success).toBe(false);
  });
});
