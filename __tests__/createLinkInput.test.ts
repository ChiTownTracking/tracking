import { describe, expect, it } from 'vitest';
import { createLinkInputSchema } from '@/lib/createLinkInput';

const valid = {
  vehicleIds: ['1000067169', '1000074171'],
  customerName: 'Smith Wedding',
  windowStart: '2026-07-20T14:00:00.000Z',
  windowEnd: '2026-07-20T18:00:00.000Z',
};

describe('createLinkInputSchema', () => {
  it('accepts valid input', () => {
    const result = createLinkInputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects an empty vehicleIds array', () => {
    const result = createLinkInputSchema.safeParse({
      ...valid,
      vehicleIds: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects windowEnd before windowStart via the refine', () => {
    const result = createLinkInputSchema.safeParse({
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

  it('rejects a missing customerName', () => {
    const { customerName: _omitted, ...withoutName } = valid;
    const result = createLinkInputSchema.safeParse(withoutName);
    expect(result.success).toBe(false);
  });

  describe('routes (optional)', () => {
    const unionStation = {
      label: 'Chicago Union Station',
      lat: 41.878988,
      lng: -87.639732,
    };
    const kenosha = { label: 'Kenosha Metra Station', lat: 42.5886, lng: -87.8214 };
    const milwaukee = { label: 'Milwaukee Intermodal', lat: 43.0344, lng: -87.9164 };

    function makeRoute(overrides: Record<string, unknown> = {}) {
      return {
        name: 'Route A',
        vehicleIds: ['1000067169'],
        windowStart: '2026-07-20T13:00:00.000Z',
        windowEnd: '2026-07-20T17:00:00.000Z',
        waypoints: [unionStation, kenosha],
        schedule: ['07:00', '14:30'],
        ...overrides,
      };
    }

    // Payload shape the UI sends in routes mode: NO top-level vehicleIds/
    // windowStart/windowEnd at all.
    function routesOnlyBody(routes: unknown[]) {
      return { customerName: 'Smith Wedding', routes };
    }

    // THE regression test for this phase: adding the routes field must not
    // silently start requiring it — a link with no routes validates exactly
    // as before.
    it('still accepts input with no routes field at all', () => {
      const result = createLinkInputSchema.safeParse(valid);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.routes).toBeUndefined();
      }
    });

    // The no-routes case still REQUIRES the top-level fields — making them
    // schema-optional for routes mode must not loosen the simple case.
    it.each(['vehicleIds', 'windowStart', 'windowEnd'])(
      'still requires top-level %s when no routes are provided',
      (field) => {
        const body: Record<string, unknown> = { ...valid };
        delete body[field];
        expect(createLinkInputSchema.safeParse(body).success).toBe(false);
      },
    );

    it('accepts a routes-mode payload with NO top-level vehicleIds/window at all', () => {
      const result = createLinkInputSchema.safeParse(
        routesOnlyBody([makeRoute()]),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.vehicleIds).toBeUndefined();
        expect(result.data.windowStart).toBeUndefined();
        expect(result.data.windowEnd).toBeUndefined();
      }
    });

    it.each(['vehicleIds', 'windowStart', 'windowEnd'])(
      'rejects a route missing its own %s',
      (field) => {
        const route: Record<string, unknown> = makeRoute();
        delete route[field];
        expect(
          createLinkInputSchema.safeParse(routesOnlyBody([route])).success,
        ).toBe(false);
      },
    );

    it('rejects a route with an empty vehicleIds array', () => {
      expect(
        createLinkInputSchema.safeParse(
          routesOnlyBody([makeRoute({ vehicleIds: [] })]),
        ).success,
      ).toBe(false);
    });

    it('rejects a per-route windowEnd at or before windowStart, same as the top level', () => {
      const result = createLinkInputSchema.safeParse(
        routesOnlyBody([
          makeRoute({
            windowStart: '2026-07-20T17:00:00.000Z',
            windowEnd: '2026-07-20T13:00:00.000Z',
          }),
        ]),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.message)).toContain(
          'windowEnd must be after windowStart',
        );
      }
    });

    it('accepts multiple named routes, preserving route and waypoint order', () => {
      const routes = [
        makeRoute({ name: 'North Loop', waypoints: [kenosha, unionStation, milwaukee] }),
        makeRoute({ name: 'South Loop', waypoints: [milwaukee, unionStation] }),
      ];
      const result = createLinkInputSchema.safeParse({ ...valid, routes });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.routes?.map((route) => route.name)).toEqual([
          'North Loop',
          'South Loop',
        ]);
        // A sequence, not a set: waypoint order survives exactly as submitted.
        expect(result.data.routes?.[0].waypoints).toEqual([
          kenosha,
          unionStation,
          milwaukee,
        ]);
      }
    });

    it('allows duplicate route names — labels, not keys', () => {
      const result = createLinkInputSchema.safeParse({
        ...valid,
        routes: [makeRoute({ name: 'Shuttle' }), makeRoute({ name: 'Shuttle' })],
      });
      expect(result.success).toBe(true);
    });

    it('rejects an empty routes array — omit the field instead', () => {
      const result = createLinkInputSchema.safeParse({ ...valid, routes: [] });
      expect(result.success).toBe(false);
    });

    it('rejects an empty or whitespace-only route name', () => {
      for (const name of ['', '   ']) {
        const result = createLinkInputSchema.safeParse({
          ...valid,
          routes: [makeRoute({ name })],
        });
        expect(result.success).toBe(false);
      }
    });

    it('rejects a route with a single waypoint — one point is not a route', () => {
      const result = createLinkInputSchema.safeParse({
        ...valid,
        routes: [makeRoute({ waypoints: [unionStation] })],
      });
      expect(result.success).toBe(false);
    });

    it('rejects an out-of-range latitude or longitude inside a route', () => {
      for (const bad of [{ ...kenosha, lat: 90.001 }, { ...kenosha, lng: -180.5 }]) {
        const result = createLinkInputSchema.safeParse({
          ...valid,
          routes: [makeRoute({ waypoints: [unionStation, bad] })],
        });
        expect(result.success).toBe(false);
      }
    });

    it('rejects an empty or whitespace-only waypoint label', () => {
      for (const label of ['', '   ', '\t\n']) {
        const result = createLinkInputSchema.safeParse({
          ...valid,
          routes: [makeRoute({ waypoints: [unionStation, { ...kenosha, label }] })],
        });
        expect(result.success).toBe(false);
      }
    });

    it('does not normalize labels — a padded label survives as submitted', () => {
      const padded = { ...kenosha, label: '  Kenosha Metra Station  ' };
      const result = createLinkInputSchema.safeParse({
        ...valid,
        routes: [makeRoute({ waypoints: [unionStation, padded] })],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.routes?.[0].waypoints[1].label).toBe(
          '  Kenosha Metra Station  ',
        );
      }
    });

    it('accepts an empty schedule — a route needs no departures to be valid', () => {
      const result = createLinkInputSchema.safeParse({
        ...valid,
        routes: [makeRoute({ schedule: [] })],
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid HH:mm departure times across the 24-hour range', () => {
      const result = createLinkInputSchema.safeParse({
        ...valid,
        routes: [makeRoute({ schedule: ['00:00', '07:05', '19:30', '23:59'] })],
      });
      expect(result.success).toBe(true);
    });

    it.each([
      ['12-hour without padding', '7:00'],
      ['hour out of range', '24:00'],
      ['minute out of range', '12:60'],
      ['missing minute digit', '12:5'],
      ['with seconds', '12:30:00'],
      ['plain words', 'noon'],
    ])('rejects a %s departure time (%s)', (_label, time) => {
      const result = createLinkInputSchema.safeParse({
        ...valid,
        routes: [makeRoute({ schedule: [time] })],
      });
      expect(result.success).toBe(false);
    });
  });
});
