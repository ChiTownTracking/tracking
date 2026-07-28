import { z } from 'zod';
import {
  departureTimePattern,
  isoDateTime,
  waypointSchema,
} from './createLinkInput';

// Phase I1: ONE input schema for the ONE creation endpoint (routeInput.ts
// and its three schemas are gone). Shares the waypoint bounds and HH:mm
// regex with create-link — shared pieces, not re-invented ones.

// ONE vehicle's assignment as submitted. Phase O2 lifted this out of the
// creation schema so adding a vehicle to an EXISTING trip validates through
// the exact same rules rather than a second copy that could drift — a
// vehicle assignment means the same thing whichever door it comes in
// through.
export const vehicleAssignmentInputSchema = z.object({
  vehicleId: z.string().min(1),
  // Phase N4: optional customer-facing card prefix ("Route A"), trimmed
  // and capped at one line's worth — it renders before the vehicle number
  // on the trip card and must not wrap.
  cardLabel: z.string().trim().max(40).optional(),
  // At least one run per assigned vehicle — a vehicle with nothing
  // scheduled has no reason to be on the trip.
  schedule: z
    .array(
      z.object({
        arrivalTime: z
          .string()
          .regex(departureTimePattern, 'must be HH:mm (24-hour)'),
        waitMinutes: z.number().int().min(0),
      }),
    )
    .min(1),
});

export type VehicleAssignmentInput = z.infer<
  typeof vehicleAssignmentInputSchema
>;

export const createTripInputSchema = z
  .object({
    name: z.string().refine((value) => value.trim().length > 0, {
      message: 'name must not be empty',
    }),
    // Phase N3: the trip's active window (ISO datetimes) — required for all
    // new trips, same isoDateTime + end-after-start rule create-link uses
    // for its own window fields.
    windowStart: isoDateTime,
    windowEnd: isoDateTime,
    // Plain label/lat/lng — wait time is per-run (ScheduleEntry.waitMinutes),
    // never per-stop.
    waypoints: z.array(waypointSchema).min(2),
    vehicles: z.array(vehicleAssignmentInputSchema).min(1),
  })
  .refine(
    (input) =>
      new Date(input.windowEnd).getTime() >
      new Date(input.windowStart).getTime(),
    { message: 'windowEnd must be after windowStart' },
  );

export type CreateTripInput = z.infer<typeof createTripInputSchema>;

// Phase O1: editing an existing trip's name and/or active window. Every
// field is optional INDIVIDUALLY (staff may rename without touching the
// window, or shorten the window without renaming), but at least one must
// be present — a PATCH that changes nothing is a mistake, not a no-op.
//
// Deliberately NOT enforcing windowEnd > windowStart here: only ONE side
// may be in the body, and the real rule compares the merged result against
// what the trip already stores. That merge needs the trip document, which
// this schema has no access to, so the ordering check lives in the route
// (see validateWindowOrdering below) rather than being half-enforced twice.
export const updateTripInputSchema = z
  .object({
    name: z
      .string()
      .refine((value) => value.trim().length > 0, {
        message: 'name must not be empty',
      })
      .optional(),
    windowStart: isoDateTime.optional(),
    windowEnd: isoDateTime.optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.windowStart !== undefined ||
      input.windowEnd !== undefined,
    { message: 'at least one of name, windowStart, windowEnd is required' },
  );

export type UpdateTripInput = z.infer<typeof updateTripInputSchema>;

// The same end-after-start rule creation enforces, applied to the MERGED
// window (each side either newly supplied or the trip's stored value).
//
// Two deliberate non-rules:
//  - A window end in the PAST is valid. Moving windowEnd behind `now` is
//    how staff end a trip's public link early — the /trip/[token] gate
//    then reports "ended", which is the intended outcome, not an error.
//  - When either side is still absent (a pre-N3 trip that never had a
//    window, patched on one side only) there is nothing to compare, so
//    nothing is rejected. The public gate needs BOTH fields to gate at
//    all, so such a trip simply stays ungated until the other side is set
//    — the same absent-means-no-gating rule every read site already uses.
export function validateWindowOrdering(
  windowStart: string | undefined,
  windowEnd: string | undefined,
): boolean {
  if (windowStart === undefined || windowEnd === undefined) {
    return true;
  }
  return new Date(windowEnd).getTime() > new Date(windowStart).getTime();
}

// Same clean issue formatting create-link uses — path-prefixed messages,
// no raw zod internals in the response.
export function formatInputIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join('.')}: ${issue.message}`
        : issue.message,
    )
    .join('; ');
}
