import { z } from 'zod';
import { departureTimePattern } from '@/lib/createLinkInput';
import { computeDepartureClock } from '@/lib/departureTime';
import { computeOccurrenceValidity } from '@/lib/scheduleOccurrence';
import { isUuidShaped } from '@/lib/trackingTokens';
import {
  type ClockPrediction,
  resolvePredictionsForClocks,
} from '@/lib/tripPredictionResolver';
import { getTrip, saveTrip } from '@/lib/tripsStore';

// Staff-only (proxy.ts matches /api/internal/:path*). Phase O1: retime ONE
// run — its arrival at the first stop and its pickup wait. Nothing else on
// the trip moves: the path, the vehicle assignment, and every sibling run
// stay exactly as they are.
//
// Two runs are off-limits, for different reasons:
//  - A CANCELLED run is not a live run at all (Phase L1). Retiming one
//    would quietly resurrect it in the customer's schedule; staff who want
//    it back should say so explicitly, not get it as a side effect.
//  - A run currently IN PROGRESS is already happening. Moving its clock
//    out from under a bus mid-route would rewrite what customers are
//    watching in real time.
//
// The in-progress test is deliberately the N6 window-aware one, not a bare
// clock comparison: an occurrence outside the trip's active window never
// actually happens, so a run whose today-occurrence falls outside it is
// still editable even when the wall clock sits inside its span. That is
// exactly the same-evening-window case N6 fixed — a naive check here would
// reintroduce it as a spurious 400.
const scheduleEntryInputSchema = z.object({
  // Same HH:mm / non-negative-integer rules creation enforces — one
  // validation vocabulary for run times, shared, not re-invented.
  arrivalTime: z
    .string()
    .regex(departureTimePattern, 'must be HH:mm (24-hour)'),
  waitMinutes: z.number().int().min(0),
});

export async function PATCH(
  request: Request,
  {
    params,
  }: { params: Promise<{ id: string; vehicleId: string; entryId: string }> },
) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = scheduleEntryInputSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: 'arrivalTime (HH:mm) and waitMinutes are required' },
        { status: 400 },
      );
    }
    const { arrivalTime, waitMinutes } = parsed.data;

    const { id, vehicleId, entryId } = await params;
    if (!isUuidShaped(id)) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const trip = await getTrip(id);
    if (!trip) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const assignment = trip.vehicles.find((v) => v.vehicleId === vehicleId);
    if (!assignment) {
      return Response.json(
        { error: `Vehicle ${vehicleId} is not assigned to this trip.` },
        { status: 404 },
      );
    }
    const entry = assignment.schedule.find((run) => run.id === entryId);
    if (!entry) {
      return Response.json(
        { error: `Run ${entryId} is not on this vehicle's schedule.` },
        { status: 404 },
      );
    }
    if (entry.cancelled) {
      return Response.json(
        { error: 'Cannot edit a cancelled run.' },
        { status: 400 },
      );
    }

    // The run's span includes its own pickup wait plus the trip's driving
    // duration — the same status window every other caller uses. Checked
    // against the run's CURRENT time (dateOffsetDays 0, today): what's
    // in progress right now is what the edit would disturb.
    const now = new Date();
    const validity = computeOccurrenceValidity(
      entry,
      0,
      trip.windowStart,
      trip.windowEnd,
      entry.waitMinutes * 60 + trip.totalDurationSeconds,
      now,
    );
    if (validity.withinWindow && validity.status === 'in-progress') {
      return Response.json(
        { error: "Cannot edit a run that's currently in progress." },
        { status: 400 },
      );
    }

    // The new time means a new departure clock, and the old prediction
    // belonged to the OLD one. Before spending a Google call, look for a
    // sibling run — on any vehicle of this trip — that already departs at
    // the new clock and carries a prediction for it: same one-call-per-
    // distinct-clock rule creation follows, just applied to a trip that
    // already exists. The run being edited is excluded, since its own
    // stored prediction is precisely the stale one being replaced.
    const departureClock = computeDepartureClock(arrivalTime, waitMinutes);
    const existingClockPredictions = new Map<string, ClockPrediction>();
    for (const other of trip.vehicles.flatMap((v) => v.schedule)) {
      if (
        other.id === entryId ||
        other.predictedArrivalDurationSeconds === undefined ||
        other.predictedArrivalStaticDurationSeconds === undefined ||
        computeDepartureClock(other.arrivalTime, other.waitMinutes) !==
          departureClock
      ) {
        continue;
      }
      existingClockPredictions.set(departureClock, {
        predictedDurationSeconds: other.predictedArrivalDurationSeconds,
        staticDurationSeconds: other.predictedArrivalStaticDurationSeconds,
      });
      break;
    }

    const resolved = await resolvePredictionsForClocks(
      [departureClock],
      trip.waypoints[0],
      trip.waypoints[trip.waypoints.length - 1],
      existingClockPredictions,
      trip.name,
    );
    const prediction = resolved.get(departureClock) ?? null;

    const vehicles = trip.vehicles.map((current) => {
      if (current.vehicleId !== vehicleId) {
        return current;
      }
      return {
        ...current,
        schedule: current.schedule.map((run) => {
          if (run.id !== entryId) {
            return run;
          }
          // Rebuild WITHOUT the old prediction fields, then re-add only a
          // freshly resolved one: a prediction for the previous time must
          // never linger on the new one, and a failed call leaves both
          // fields absent (never zero/null) per the ScheduleEntry contract.
          const {
            predictedArrivalDurationSeconds: _stalePredicted,
            predictedArrivalStaticDurationSeconds: _staleStatic,
            ...rest
          } = run;
          return {
            ...rest,
            arrivalTime,
            waitMinutes,
            ...(prediction !== null
              ? {
                  predictedArrivalDurationSeconds:
                    prediction.predictedDurationSeconds,
                  predictedArrivalStaticDurationSeconds:
                    prediction.staticDurationSeconds,
                }
              : {}),
          };
        }),
      };
    });

    await saveTrip({ ...trip, vehicles });

    const updated = vehicles
      .find((v) => v.vehicleId === vehicleId)
      ?.schedule.find((run) => run.id === entryId);
    return Response.json({ entry: updated, departureClock });
  } catch (error) {
    console.error('schedule entry route failed:', error);
    return Response.json(
      { error: 'Unable to update run' },
      { status: 502 },
    );
  }
}
