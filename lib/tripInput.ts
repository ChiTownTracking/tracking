import { z } from 'zod';
import {
  departureTimePattern,
  isoDateTime,
  waypointSchema,
} from './createLinkInput';

// Phase I1: ONE input schema for the ONE creation endpoint (routeInput.ts
// and its three schemas are gone). Shares the waypoint bounds and HH:mm
// regex with create-link — shared pieces, not re-invented ones.

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
    vehicles: z
      .array(
        z.object({
          vehicleId: z.string().min(1),
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
        }),
      )
      .min(1),
  })
  .refine(
    (input) =>
      new Date(input.windowEnd).getTime() >
      new Date(input.windowStart).getTime(),
    { message: 'windowEnd must be after windowStart' },
  );

export type CreateTripInput = z.infer<typeof createTripInputSchema>;

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
