import { z } from 'zod';

// Accepts ISO datetimes with an offset/Z or without one (the create-link form
// normalizes datetime-local values to UTC ISO strings before submitting, but
// the schema tolerates both).
const isoDateTime = z.iso.datetime({ offset: true, local: true });

// One named stop on an optional route. Bounds are basic lat/lng sanity only —
// regional scoping (Midwest bounding box) lives in orsClient, not here. The
// label is validated non-empty-after-trim but stored exactly as submitted
// (refine, not .trim(): no silent normalization). Exported for reuse by the
// standalone Trip schema (lib/tripInput.ts).
export const waypointSchema = z.object({
  label: z.string().refine((value) => value.trim().length > 0, {
    message: 'label must not be empty',
  }),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

// "HH:mm", 24-hour — exactly what <input type="time"> produces. Exported for
// the same reuse.
export const departureTimePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

const namedRouteSchema = z
  .object({
    name: z.string().refine((value) => value.trim().length > 0, {
      message: 'name must not be empty',
    }),
    // Each route runs its own vehicles inside its own time window,
    // independently of every other route on the link.
    vehicleIds: z.array(z.string().min(1)).min(1),
    windowStart: isoDateTime,
    windowEnd: isoDateTime,
    // An ordered SEQUENCE of at least two stops (a single point isn't a
    // route), preserved exactly as submitted.
    waypoints: z.array(waypointSchema).min(2),
    // Daily departure times; empty is fine — a route needs no schedule to be
    // valid.
    schedule: z.array(
      z.string().regex(departureTimePattern, 'must be HH:mm (24-hour)'),
    ),
  })
  .refine(
    (route) =>
      new Date(route.windowEnd).getTime() >
      new Date(route.windowStart).getTime(),
    { message: 'windowEnd must be after windowStart' },
  );

// Top-level vehicleIds/windowStart/windowEnd are required exactly when NO
// routes are submitted (the original simple case). With 1+ routes, each
// route carries its own — the top-level fields may be omitted entirely and
// are ignored if sent. The superRefine below implements that conditionality;
// the per-route fields themselves are unconditionally required by
// namedRouteSchema.
export const createLinkInputSchema = z
  .object({
    vehicleIds: z.array(z.string().min(1)).min(1).optional(),
    customerName: z.string().min(1),
    windowStart: isoDateTime.optional(),
    windowEnd: isoDateTime.optional(),
    // Entirely optional at the link level; when present, at least one named
    // route. Names are labels, not keys — deliberately no uniqueness rule.
    routes: z.array(namedRouteSchema).min(1).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.routes && input.routes.length > 0) {
      // Routes mode: per-route validation (namedRouteSchema) is the whole
      // story; top-level fields are meaningless here.
      return;
    }
    if (input.vehicleIds === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['vehicleIds'],
        message: 'required when no routes are provided',
      });
    }
    if (input.windowStart === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['windowStart'],
        message: 'required when no routes are provided',
      });
    }
    if (input.windowEnd === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['windowEnd'],
        message: 'required when no routes are provided',
      });
    }
    if (
      input.windowStart !== undefined &&
      input.windowEnd !== undefined &&
      new Date(input.windowEnd).getTime() <=
        new Date(input.windowStart).getTime()
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'windowEnd must be after windowStart',
      });
    }
  });

export type CreateLinkInput = z.infer<typeof createLinkInputSchema>;
