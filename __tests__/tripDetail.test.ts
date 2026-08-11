import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Vehicle } from '@/lib/liveVehicles';
import type { ScheduleEntry, Trip } from '@/lib/trips';

vi.mock('@/lib/liveVehicles', () => ({
  getLiveVehicles: vi.fn(),
}));

vi.mock('@/lib/vehicleRoster', () => ({
  getVehicleRoster: vi.fn(),
}));

// estimateTripProgress and getTripStatus stay REAL — progress and run
// statuses should come from the actual math, not a mock's echo.

import { getLiveVehicles } from '@/lib/liveVehicles';
import { selectActiveFromDailyPools } from '@/lib/scheduleEntry';
import { buildTripDetailResponse } from '@/lib/tripDetail';
import { getVehicleRoster } from '@/lib/vehicleRoster';

// A 2-stop trip straight up a meridian (~2224 m, 600s drive), stops at
// geometry indices 0 and 2 — enough real shape for estimateTripProgress.
const TRIP: Trip = {
  id: 'trip-1',
  token: 'trip-1-token',
  name: 'North Shore Run',
  waypoints: [
    { label: 'Stop A', lat: 41.0, lng: -87.65 },
    { label: 'Stop B', lat: 41.02, lng: -87.65 },
  ],
  geometry: [
    [41.0, -87.65],
    [41.01, -87.65],
    [41.02, -87.65],
  ],
  legs: [{ distanceMeters: 2223.9, durationSeconds: 600 }],
  legBoundaryIndices: [0, 2],
  totalDistanceMeters: 2223.9,
  totalDurationSeconds: 600,
  vehicles: [
    {
      vehicleId: '1000067169',
      // Three runs straddling noon Chicago: 09:00 done, 11:55 (+10min wait
      // +10min drive → ends 12:15) in progress, 14:00 still ahead.
      schedule: [
        { id: 'run-a1', arrivalTime: '09:00', waitMinutes: 10 },
        { id: 'run-a2', arrivalTime: '11:55', waitMinutes: 10 },
        { id: 'run-a3', arrivalTime: '14:00', waitMinutes: 0 },
      ],
    },
    {
      vehicleId: '1000074171',
      schedule: [{ id: 'run-b1', arrivalTime: '13:00', waitMinutes: 5 }],
    },
  ],
  createdAt: '2026-07-17T15:00:00.000Z',
};

const ROSTER = [
  {
    vehicleId: '1000067169',
    registrationNumber: 'TRLY-7169',
    description: 'Trolley 1',
    iconUrl: '',
  },
  {
    vehicleId: '1000074171',
    // Empty registration: the label must fall back to the description.
    registrationNumber: '',
    description: 'Trolley 2',
    iconUrl: '',
  },
];

function liveVehicle(
  vehicleId: string,
  latitude: number,
  speed: number,
): Vehicle {
  return {
    vehicleId,
    registrationNumber: `TRLY-${vehicleId.slice(-4)}`,
    description: 'Trolley',
    iconUrl: '',
    latitude,
    longitude: -87.65,
    heading: 355,
    speed,
    locationText: 'Clark St',
    lastUpdatedAt: '2026-07-17T17:00:00.000Z',
  };
}

describe('buildTripDetailResponse (multi-vehicle)', () => {
  beforeEach(() => {
    // Noon Chicago (CDT, UTC-5): run statuses become deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T17:00:00Z'));
    vi.mocked(getVehicleRoster).mockResolvedValue(ROSTER);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('each vehicle gets its OWN live progress and its OWN run statuses, not cross-contaminated', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([
      liveVehicle('1000067169', 41.005, 12), // quarter of the way, 12 mph
      liveVehicle('1000074171', 41.015, 20), // three quarters, 20 mph
    ]);

    const detail = await buildTripDetailResponse(TRIP);

    // One batched live call with the deduped id set, roster read once.
    expect(getLiveVehicles).toHaveBeenCalledTimes(1);
    expect(getLiveVehicles).toHaveBeenCalledWith(['1000067169', '1000074171']);
    expect(getVehicleRoster).toHaveBeenCalledTimes(1);

    const [a, b] = detail.vehicles;
    expect(a.vehicleId).toBe('1000067169');
    expect(a.vehicleLabel).toBe('TRLY-7169');
    expect(b.vehicleLabel).toBe('Trolley 2');

    // Independent positions and progress.
    expect(a.position?.lat).toBe(41.005);
    expect(b.position?.lat).toBe(41.015);
    expect(a.nextStopIndex).toBe(1);
    expect(b.nextStopIndex).toBe(1);
    // Different positions + different speeds → different ETAs; identical
    // values would smell of shared state.
    expect(a.stopEtas?.[1].arrival).not.toBe(b.stopEtas?.[1].arrival);

    // Independent schedule statuses: A straddles noon, B is all ahead.
    // Phase Q: A's 11:55 run is mid-window by the clock but its pickup
    // was never confirmed, so it reads 'upcoming', not 'in-progress' —
    // the statuses are still per-vehicle and independent, which is what
    // this case is about.
    expect(a.schedule.map((run) => run.status)).toEqual([
      'completed',
      'upcoming',
      'upcoming',
    ]);
    expect(b.schedule.map((run) => run.status)).toEqual(['upcoming']);
  });

  // The multi-run mirror of the old sibling-window tests: one vehicle's
  // runs carry all three states simultaneously, each judged on its own
  // window (which includes its own pickup wait).
  //
  // Phase Q: reaching 'in-progress' takes a confirmed pickup whose
  // scheduled instant has arrived, so the middle run carries one (plus
  // the departure that realistically follows it — incidental to the
  // status now, but it keeps the fixture a state the detectors could
  // actually produce). Without the pickup the same three runs would read
  // completed/upcoming/upcoming, as asserted in the sibling case above.
  it('a vehicle with multiple runs shows completed/in-progress/upcoming all at once', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([
      liveVehicle('1000067169', 41.005, 12),
      liveVehicle('1000074171', 41.015, 20),
    ]);

    const detail = await buildTripDetailResponse({
      ...TRIP,
      vehicles: [
        {
          ...TRIP.vehicles[0],
          schedule: TRIP.vehicles[0].schedule.map((run) =>
            run.id === 'run-a2'
              ? {
                  ...run,
                  actualPickupAt: '2026-07-17T16:57:00.000Z',
                  actualPickupDate: '2026-07-17',
                  actualDepartureAt: '2026-07-17T16:59:00.000Z',
                  actualDepartureDate: '2026-07-17',
                }
              : run,
          ),
        },
        TRIP.vehicles[1],
      ],
    });

    const runs = detail.vehicles[0].schedule;
    expect(runs).toEqual([
      {
        id: 'run-a1',
        arrivalTime: '09:00',
        waitMinutes: 10,
        status: 'completed',
        departureClock: '09:10',
        // No stored prediction on this trip: null, never fabricated.
        predictedArrivalRange: null,
      },
      {
        id: 'run-a2',
        arrivalTime: '11:55',
        waitMinutes: 10,
        status: 'in-progress',
        departureClock: '12:05',
        // Comes with the departure: a run can't have observably left a
        // pickup it never observably reached, so the fixture carries the
        // realistic pair and the row reports both.
        actualPickupClock: '11:57 AM',
        predictedArrivalRange: null,
      },
      {
        id: 'run-a3',
        arrivalTime: '14:00',
        waitMinutes: 0,
        status: 'upcoming',
        departureClock: '14:00',
        predictedArrivalRange: null,
      },
    ]);
  });

  // K1's stored raw pair becomes a display-ready, bus-buffered, ordered
  // 12-hour range — and neither the raw seconds nor the buffer multiplier
  // ever reach the public shape.
  it('formats stored predictions into a buffered, ordered arrival range; absent stays null', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);
    const tripWithPrediction: Trip = {
      ...TRIP,
      vehicles: [
        {
          vehicleId: '1000067169',
          schedule: [
            // The real captured pair. From the 12:05 departure:
            // 1061 × 1.1 → 1167s → +19 min → 12:24 PM (early);
            // 1332 × 1.1 → 1465s → +24 min → 12:29 PM (late).
            {
              id: 'run-p1',
              arrivalTime: '11:55',
              waitMinutes: 10,
              predictedArrivalDurationSeconds: 1061,
              predictedArrivalStaticDurationSeconds: 1332,
            },
            // No prediction stored (the K1 failure case) → null, no crash.
            { id: 'run-p2', arrivalTime: '14:00', waitMinutes: 0 },
          ],
        },
      ],
    };

    const detail = await buildTripDetailResponse(tripWithPrediction);

    const [withPrediction, without] = detail.vehicles[0].schedule;
    expect(withPrediction.departureClock).toBe('12:05');
    expect(withPrediction.predictedArrivalRange).toEqual({
      early: '12:24 PM',
      late: '12:29 PM',
    });
    expect(without.predictedArrivalRange).toBeNull();
    // Neither raw duration reaches the response — only the two formatted
    // clock strings.
    expect(withPrediction).not.toHaveProperty(
      'predictedArrivalDurationSeconds',
    );
    expect(withPrediction).not.toHaveProperty(
      'predictedArrivalStaticDurationSeconds',
    );
  });

  it('a dark vehicle returns its full static schedule with every live field null', async () => {
    // Only the first vehicle reports.
    vi.mocked(getLiveVehicles).mockResolvedValue([
      liveVehicle('1000067169', 41.005, 12),
    ]);

    const detail = await buildTripDetailResponse(TRIP);

    const dark = detail.vehicles[1];
    expect(dark).toMatchObject({
      vehicleId: '1000074171',
      vehicleLabel: 'Trolley 2',
      position: null,
      positionConfident: null,
      positionUpdatedAt: null,
      speedMph: null,
      nextStopIndex: null,
      stopEtas: null,
    });
    // Static runs still fully present, statuses included.
    expect(dark.schedule).toEqual([
      {
        id: 'run-b1',
        arrivalTime: '13:00',
        waitMinutes: 5,
        status: 'upcoming',
        departureClock: '13:05',
        predictedArrivalRange: null,
      },
    ]);

    // The reporting vehicle is unaffected by its dark sibling, and carries
    // its live fix's freshness timestamp (Phase K2).
    expect(detail.vehicles[0].position).not.toBeNull();
    expect(detail.vehicles[0].positionUpdatedAt).toBe(
      '2026-07-17T17:00:00.000Z',
    );
    expect(detail.vehicles[0].stopEtas).toHaveLength(2);
  });

  // Phase L3: cancelled runs and service notes reach the public shape —
  // and a cancelled run stops being treated as a real one.
  it('passes serviceNote through when present and omits it entirely when absent', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);
    const tripWithNote: Trip = {
      ...TRIP,
      vehicles: [
        { ...TRIP.vehicles[0], serviceNote: 'Bus swapped for maintenance' },
        TRIP.vehicles[1],
      ],
    };

    const detail = await buildTripDetailResponse(tripWithNote);

    expect(detail.vehicles[0].serviceNote).toBe('Bus swapped for maintenance');
    expect(detail.vehicles[1]).not.toHaveProperty('serviceNote');
  });

  // Phase N4: the optional card-label prefix follows the same present-or-
  // omitted convention as serviceNote.
  it('passes cardLabel through when present and omits it entirely when absent', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);
    const tripWithLabel: Trip = {
      ...TRIP,
      vehicles: [
        { ...TRIP.vehicles[0], cardLabel: 'Route A' },
        TRIP.vehicles[1],
      ],
    };

    const detail = await buildTripDetailResponse(tripWithLabel);

    expect(detail.vehicles[0].cardLabel).toBe('Route A');
    // Absent, not null, not empty string.
    expect(detail.vehicles[1]).not.toHaveProperty('cardLabel');
  });

  // Phase N5: the active run's real calendar date, Chicago-anchored. The
  // clock is pinned to noon Chicago (Fri, Jul 17) in beforeEach.
  it('an in-progress run today produces TODAY\'s date label', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);

    const detail = await buildTripDetailResponse(TRIP);

    // vehicles[0]'s 11:55 run is in progress at noon → today.
    expect(detail.vehicles[0].activeRunDateLabel).toBe('Fri, Jul 17');
  });

  it("the all-completed fallback produces TOMORROW's date label", async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);
    const allDoneTrip: Trip = {
      ...TRIP,
      vehicles: [
        {
          vehicleId: '1000067169',
          // Both ended well before noon → the fallback anchors on the last
          // one, whose next real occurrence is tomorrow.
          schedule: [
            { id: 'done-1', arrivalTime: '07:00', waitMinutes: 10 },
            { id: 'done-2', arrivalTime: '08:30', waitMinutes: 0 },
          ],
        },
      ],
    };

    const detail = await buildTripDetailResponse(allDoneTrip);

    expect(detail.vehicles[0].activeRunDateLabel).toBe('Sat, Jul 18');
  });

  it('omits activeRunDateLabel entirely for an emptied assignment (nothing scheduled)', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);
    const emptied: Trip = {
      ...TRIP,
      vehicles: [{ vehicleId: '1000067169', schedule: [] }],
    };

    const detail = await buildTripDetailResponse(emptied);

    expect(detail.vehicles[0]).not.toHaveProperty('activeRunDateLabel');
  });

  // Phase N6: THE reported bug's regression test, at the full API layer.
  // A trip whose active window opens the same evening it's created
  // (windowStart = Jul 22, 7:06 PM Chicago), with an early-morning daily
  // schedule (7:30/8:00/8:30/9:00 AM). `now` is Jul 22, ~7:30 PM Chicago —
  // TODAY's occurrences of every entry precede the window opening; the
  // real next occurrences are all tomorrow.
  it('REGRESSION: a same-evening window with early-morning times — empty today, tomorrow has all four upcoming', async () => {
    vi.setSystemTime(new Date('2026-07-23T00:30:00.000Z')); // Jul 22, 7:30 PM Chicago
    vi.mocked(getLiveVehicles).mockResolvedValue([]);
    const sameEveningTrip: Trip = {
      ...TRIP,
      windowStart: '2026-07-23T00:06:00.000Z', // Jul 22, 7:06 PM Chicago
      windowEnd: '2026-07-30T00:06:00.000Z',
      vehicles: [
        {
          vehicleId: '1000067169',
          schedule: [
            { id: 'run-0900', arrivalTime: '09:00', waitMinutes: 0 },
            { id: 'run-0730', arrivalTime: '07:30', waitMinutes: 0 },
            { id: 'run-0830', arrivalTime: '08:30', waitMinutes: 0 },
            { id: 'run-0800', arrivalTime: '08:00', waitMinutes: 0 },
          ],
        },
      ],
    };

    const detail = await buildTripDetailResponse(sameEveningTrip);
    const vehicle = detail.vehicles[0];

    // Nothing valid today — the whole point of the fix.
    expect(vehicle.schedule).toEqual([]);
    // Tomorrow has all four, each upcoming, in chronological order.
    expect(vehicle.tomorrowSchedule.map((entry) => entry.id)).toEqual([
      'run-0730',
      'run-0800',
      'run-0830',
      'run-0900',
    ]);
    expect(
      vehicle.tomorrowSchedule.every((entry) => entry.status === 'upcoming'),
    ).toBe(true);
    // The active run really is 07:30 AM tomorrow — not 9:00 AM (today's
    // last entry, what the old unwindowed algorithm wrongly anchored on).
    expect(vehicle.tomorrowSchedule[0].arrivalTime).toBe('07:30');
    expect(vehicle.activeRunDateLabel).toBe('Thu, Jul 23');
  });

  it('marks cancelled runs (flag present only when true) and strips their prediction', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([
      liveVehicle('1000067169', 41.005, 12),
    ]);
    const tripWithCancellation: Trip = {
      ...TRIP,
      vehicles: [
        {
          vehicleId: '1000067169',
          serviceNote: 'Trolley out of service today',
          schedule: [
            { id: 'run-done', arrivalTime: '09:00', waitMinutes: 10 },
            // The ONLY still-relevant run, cancelled — and inside what
            // would be its in-progress window at noon, with a stored
            // prediction that must NOT surface.
            {
              id: 'run-cancelled',
              arrivalTime: '11:55',
              waitMinutes: 10,
              cancelled: true,
              predictedArrivalDurationSeconds: 1061,
              predictedArrivalStaticDurationSeconds: 1332,
            },
          ],
        },
      ],
    };

    const detail = await buildTripDetailResponse(tripWithCancellation);

    // The FULL schedule still comes back, accurately flagged.
    const [done, cancelled] = detail.vehicles[0].schedule;
    expect(detail.vehicles[0].schedule).toHaveLength(2);
    expect(done).not.toHaveProperty('cancelled');
    expect(cancelled.cancelled).toBe(true);
    // No prediction for a run that isn't happening — nothing for the
    // card's emphasized block to render.
    expect(cancelled.predictedArrivalRange).toBeNull();
    // The raw stored values still never leak.
    expect(cancelled).not.toHaveProperty('predictedArrivalDurationSeconds');
    expect(detail.vehicles[0].serviceNote).toBe(
      'Trolley out of service today',
    );
  });

  // An L1 replace can leave an assignment with zero runs; the public
  // response must survive that (zero dwell, empty schedule), live position
  // or not.
  it('handles a live vehicle whose schedule was fully replaced away (empty schedule)', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([
      liveVehicle('1000067169', 41.005, 12),
    ]);
    const tripReplacedAway: Trip = {
      ...TRIP,
      vehicles: [
        {
          vehicleId: '1000067169',
          schedule: [],
          serviceNote: 'Replaced by a spare vehicle',
        },
      ],
    };

    const detail = await buildTripDetailResponse(tripReplacedAway);

    expect(detail.vehicles[0].schedule).toEqual([]);
    expect(detail.vehicles[0].serviceNote).toBe('Replaced by a spare vehicle');
    // Live fields still honest — the vehicle exists and reports.
    expect(detail.vehicles[0].position).not.toBeNull();
  });

  // Phase N7's READ step: detected / missed / pending for the ACTIVE run,
  // against the same pinned noon-Chicago clock (Fri, Jul 17 2026 — which is
  // "2026-07-17" as a Chicago-anchored date stamp).
  //
  // One vehicle, one run, so "the active run" is never in question. 11:55 +
  // 10 min wait + 10 min drive is in progress at noon; its detection window
  // closes at 12:05, five minutes after `now`.
  function tripWithActiveRun(overrides: Partial<ScheduleEntry> = {}): Trip {
    return {
      ...TRIP,
      vehicles: [
        {
          vehicleId: '1000067169',
          schedule: [
            { id: 'run-a2', arrivalTime: '11:55', waitMinutes: 10, ...overrides },
          ],
        },
      ],
    };
  }

  it('DETECTED: a same-date stored detection surfaces as a formatted 12-hour clock', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);

    const detail = await buildTripDetailResponse(
      tripWithActiveRun({
        actualPickupAt: '2026-07-17T16:57:00.000Z', // 11:57 AM Chicago
        actualPickupDate: '2026-07-17',
      }),
    );

    expect(detail.vehicles[0].actualPickupClock).toBe('11:57 AM');
    // Detected is not missed — the two states are exclusive.
    expect(detail.vehicles[0]).not.toHaveProperty('pickupMissed');
  });

  it('a stale detection from a DIFFERENT date is PENDING, not detected', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);

    // Yesterday's stamp on the same daily-recurring run: today's occurrence
    // has NOT been confirmed, and must not inherit it.
    const detail = await buildTripDetailResponse(
      tripWithActiveRun({
        actualPickupAt: '2026-07-16T16:57:00.000Z',
        actualPickupDate: '2026-07-16',
      }),
    );

    expect(detail.vehicles[0]).not.toHaveProperty('actualPickupClock');
    // Still inside today's window (closes 12:05) — pending, not missed.
    expect(detail.vehicles[0]).not.toHaveProperty('pickupMissed');
  });

  it('MISSED: past the 10-minute cutoff with nothing detected', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);
    // 11:45 arrival → the detection window closed at 11:55, five minutes
    // before `now`; the run itself is still in progress until 12:05.
    const detail = await buildTripDetailResponse({
      ...TRIP,
      vehicles: [
        {
          vehicleId: '1000067169',
          schedule: [{ id: 'run-late', arrivalTime: '11:45', waitMinutes: 10 }],
        },
      ],
    });

    expect(detail.vehicles[0].pickupMissed).toBe(true);
    expect(detail.vehicles[0]).not.toHaveProperty('actualPickupClock');
  });

  it('PENDING: well inside the window with nothing detected yet stays pending (no early MISSED)', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);

    const detail = await buildTripDetailResponse(tripWithActiveRun());

    // Neither field: the card keeps its existing predicted-arrival display,
    // exactly as before this phase.
    expect(detail.vehicles[0]).not.toHaveProperty('actualPickupClock');
    expect(detail.vehicles[0]).not.toHaveProperty('pickupMissed');
  });

  // Phase N7: the schedule ROWS carry each run's own confirmed pickup —
  // and the emphasized active-run block's predicted RANGE, a separate
  // concern rendered only while a run is in progress, is untouched by that
  // swap. Both live on the same row object, so this pins them apart.
  it('schedule rows carry actualPickupClock while the active-run predicted RANGE stays intact', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);

    const detail = await buildTripDetailResponse({
      ...TRIP,
      vehicles: [
        {
          vehicleId: '1000067169',
          schedule: [
            // In progress at noon, detected at 11:57 today, AND carrying
            // the same real prediction pair the range test above uses.
            {
              id: 'run-a2',
              arrivalTime: '11:55',
              waitMinutes: 10,
              actualPickupAt: '2026-07-17T16:57:00.000Z',
              actualPickupDate: '2026-07-17',
              predictedArrivalDurationSeconds: 1061,
              predictedArrivalStaticDurationSeconds: 1332,
            },
            // Later today, nothing detected — the row stays blank rather
            // than borrowing anything.
            { id: 'run-a3', arrivalTime: '14:00', waitMinutes: 0 },
          ],
        },
      ],
    });

    const [detected, undetected] = detail.vehicles[0].schedule;
    expect(detected.actualPickupClock).toBe('11:57 AM');
    expect(undetected).not.toHaveProperty('actualPickupClock');

    // Unaffected: still the buffered early/late pair from the 12:05
    // departure, exactly as before this change.
    expect(detected.predictedArrivalRange).toEqual({
      early: '12:24 PM',
      late: '12:29 PM',
    });

    // And the headline agrees with its own row — one date-matching check
    // behind both.
    expect(detail.vehicles[0].actualPickupClock).toBe('11:57 AM');
  });

  it("TOMORROW's rows never inherit today's detection", async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);

    const detail = await buildTripDetailResponse({
      ...TRIP,
      vehicles: [
        {
          vehicleId: '1000067169',
          schedule: [
            {
              id: 'run-a2',
              arrivalTime: '11:55',
              waitMinutes: 10,
              actualPickupAt: '2026-07-17T16:57:00.000Z',
              actualPickupDate: '2026-07-17',
            },
          ],
        },
      ],
    });

    const vehicle = detail.vehicles[0];
    expect(vehicle.schedule[0].actualPickupClock).toBe('11:57 AM');
    // The SAME entry, one day on: not detected, not yet.
    expect(vehicle.tomorrowSchedule[0]).not.toHaveProperty('actualPickupClock');
  });

  // Phase P: departedPickup, read from the STORED departure stamp rather
  // than from the current fix. Stop A is 41.0/-87.65; the live helper puts
  // a vehicle on that same meridian, so latitude alone sets the distance.
  // 41.0002 is ~22 m (inside the 100 m radius), 41.005 is ~555 m (well
  // outside). At noon the 11:55 run's window is still open until 12:05,
  // so live position is the only thing varying below — which is exactly
  // what must NOT move this flag.
  const ARRIVED_TODAY = {
    actualPickupAt: '2026-07-17T16:57:00.000Z', // 11:57 AM Chicago
    actualPickupDate: '2026-07-17',
  };
  const DEPARTED_TODAY = {
    actualDepartureAt: '2026-07-17T16:59:00.000Z', // 11:59 AM Chicago
    actualDepartureDate: '2026-07-17',
  };

  // Deliberately NO default stamps: every caller states exactly which
  // lifecycle facts exist, so a stage called "nothing confirmed" really
  // has nothing on it.
  function tripWithRun(stamps: Partial<ScheduleEntry> = {}): Trip {
    return {
      ...TRIP,
      vehicles: [
        {
          vehicleId: '1000067169',
          schedule: [
            {
              id: 'run-a2',
              arrivalTime: '11:55',
              waitMinutes: 10,
              ...stamps,
            },
          ],
        },
      ],
    };
  }

  it('an arrived run with no departure stamp is not departed — the card stays present-tense', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([
      liveVehicle('1000067169', 41.0002, 0),
    ]);

    const vehicle = (await buildTripDetailResponse(tripWithRun(ARRIVED_TODAY)))
      .vehicles[0];

    expect(vehicle.departedPickup).toBe(false);
    expect(vehicle.actualPickupClock).toBe('11:57 AM');
    expect(vehicle).not.toHaveProperty('pickupMissed');
  });

  it('a stored departure makes it departed while the arrival timestamp survives untouched', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([
      liveVehicle('1000067169', 41.005, 20),
    ]);

    const vehicle = (await buildTripDetailResponse(tripWithRun({ ...ARRIVED_TODAY, ...DEPARTED_TODAY })))
      .vehicles[0];

    expect(vehicle.departedPickup).toBe(true);
    // The arrival record does NOT go away with the bus — this is what the
    // card shows past-tense as "Picked up at 11:57 AM".
    expect(vehicle.actualPickupClock).toBe('11:57 AM');
  });

  // THE regression this phase exists for: the sticky stored fact beats any
  // live re-check, so a wandering fix can't bounce the display backwards.
  it('REGRESSION: a departed vehicle that drifts back INSIDE the radius stays departed', async () => {
    // Physically back at the stop, well inside the window — every live
    // signal says "at the pickup" again. The stored fact says otherwise,
    // and the stored fact is the one that counts.
    vi.mocked(getLiveVehicles).mockResolvedValue([
      liveVehicle('1000067169', 41.0002, 0),
    ]);

    const vehicle = (await buildTripDetailResponse(tripWithRun({ ...ARRIVED_TODAY, ...DEPARTED_TODAY })))
      .vehicles[0];

    expect(vehicle.departedPickup).toBe(true);
    expect(vehicle.actualPickupClock).toBe('11:57 AM');
  });

  it("a departure stamp from a DIFFERENT date doesn't count for today's run", async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);

    const vehicle = (
      await buildTripDetailResponse(
        tripWithRun({
          ...ARRIVED_TODAY,
          actualDepartureAt: '2026-07-16T16:59:00.000Z',
          actualDepartureDate: '2026-07-16',
        }),
      )
    ).vehicles[0];

    expect(vehicle.departedPickup).toBe(false);
  });

  it('a dark vehicle still reports the stored departure — it needs no live fix to be true', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);

    const vehicle = (await buildTripDetailResponse(tripWithRun({ ...ARRIVED_TODAY, ...DEPARTED_TODAY })))
      .vehicles[0];

    expect(vehicle.departedPickup).toBe(true);
    expect(vehicle.actualPickupClock).toBe('11:57 AM');
  });

  // Phase P: markerStatus walks the three stored stamps and nothing else.
  // The vehicle sits inside the pickup radius throughout — position never
  // changes across the four stages, so anything that moved would have to
  // be coming from a live recheck rather than the stored facts.
  it('markerStatus follows the full run cycle: general → at-pickup → en-route → general', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([
      liveVehicle('1000067169', 41.0002, 0),
    ]);

    const stages: [string, Partial<ScheduleEntry>][] = [
      ['nothing confirmed', {}],
      ['picked up', ARRIVED_TODAY],
      ['departed', { ...ARRIVED_TODAY, ...DEPARTED_TODAY }],
      [
        'dropped off',
        {
          ...ARRIVED_TODAY,
          ...DEPARTED_TODAY,
          actualDropoffAt: '2026-07-17T17:09:00.000Z',
          actualDropoffDate: '2026-07-17',
        },
      ],
    ];

    const observed: string[] = [];
    for (const [, overrides] of stages) {
      const detail = await buildTripDetailResponse(tripWithRun(overrides));
      const vehicle = detail.vehicles[0];
      observed.push(vehicle.markerStatus);

      // The drop-off pair is INTERNAL: it must not surface at any stage,
      // in the vehicle shape or in any schedule row.
      expect(vehicle).not.toHaveProperty('actualDropoffAt');
      expect(vehicle).not.toHaveProperty('actualDropoffDate');
      for (const row of [...vehicle.schedule, ...vehicle.tomorrowSchedule]) {
        expect(row).not.toHaveProperty('actualDropoffAt');
        expect(row).not.toHaveProperty('actualDropoffDate');
      }
      // Nor do the raw departure stamps — only the derived booleans.
      expect(vehicle).not.toHaveProperty('actualDepartureAt');
    }

    expect(observed).toEqual([
      'general', // before anything is confirmed
      'at-pickup', // arrived, not yet away
      'en-route', // away, not yet finished
      'general', // finished — the marker retires
    ]);
  });

  it('a completed run reports departedPickup true even though its marker has gone neutral', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);

    const vehicle = (
      await buildTripDetailResponse(
        tripWithRun({
          ...ARRIVED_TODAY,
          ...DEPARTED_TODAY,
          actualDropoffAt: '2026-07-17T17:09:00.000Z',
          actualDropoffDate: '2026-07-17',
        }),
      )
    ).vehicles[0];

    // The card still says "Picked up at 11:57 AM" — the run finishing
    // doesn't retract the fact that it happened.
    expect(vehicle.markerStatus).toBe('general');
    expect(vehicle.departedPickup).toBe(true);
    expect(vehicle.actualPickupClock).toBe('11:57 AM');
  });

  it("a dropoff stamp from a DIFFERENT date leaves the marker en-route", async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);

    const vehicle = (
      await buildTripDetailResponse(
        tripWithRun({
          ...ARRIVED_TODAY,
          ...DEPARTED_TODAY,
          actualDropoffAt: '2026-07-16T17:09:00.000Z',
          actualDropoffDate: '2026-07-16',
        }),
      )
    ).vehicles[0];

    expect(vehicle.markerStatus).toBe('en-route');
  });

  // Phase Q — THE disconnect regression. Both surfaces are fed the exact
  // same response and must describe the SAME run:
  //   • the schedule row's label comes from resolveDisplayStatus,
  //     server-side, per row;
  //   • the card's headline picks its run with selectActiveFromDailyPools
  //     (called here exactly as TripStatusCard calls it) and then reads
  //     that row's own status and pickup clock.
  //
  // The scenario is the reported screenshot, reproduced precisely: a run
  // whose pickup was confirmed and whose CLOCK window has since closed,
  // with a later run still ahead of it. The row said "In progress" while
  // the headline had already skipped to the next run's "Arrives…",
  // because the headline's run was chosen by clock arithmetic that knew
  // nothing about the stored facts.
  it('REGRESSION: the schedule row and the card headline describe the same run', async () => {
    // 12:07 PM Chicago — past the 11:55 run's clock window (11:55 + 0 min
    // wait + 10 min drive = 12:05), so the bare clock calls it completed
    // and would hand the headline to the 14:00 run.
    //
    // Phase R re-timed this fixture. It used to run a 10-minute pickup
    // wait at 12:20, but the absolute ceiling (scheduled + drive + 5 min
    // grace, so 12:10 here) does not count that wait, and with a wait
    // longer than the grace the ceiling now closes the run BEFORE its own
    // clock window does — leaving no instant where a fact-based
    // in-progress outlives the clock. A 0-minute wait puts the clock
    // window's close (12:05) back inside the ceiling (12:10), which is
    // the gap this regression needs in order to test anything.
    vi.setSystemTime(new Date('2026-07-17T17:07:00.000Z'));
    vi.mocked(getLiveVehicles).mockResolvedValue([]);

    const detail = await buildTripDetailResponse({
      ...TRIP,
      vehicles: [
        {
          vehicleId: '1000067169',
          schedule: [
            {
              id: 'run-a2',
              arrivalTime: '11:55',
              waitMinutes: 0,
              actualPickupAt: '2026-07-17T16:57:00.000Z', // 11:57 AM
              actualPickupDate: '2026-07-17',
            },
            { id: 'run-a3', arrivalTime: '14:00', waitMinutes: 0 },
          ],
        },
      ],
    });
    const vehicle = detail.vehicles[0];

    // The ROW: in progress, from the stored pickup.
    const row = vehicle.schedule.find((entry) => entry.id === 'run-a2');
    expect(row?.status).toBe('in-progress');

    // The HEADLINE: the same selection call the card makes.
    const selection = selectActiveFromDailyPools(
      vehicle.schedule,
      vehicle.tomorrowSchedule,
      TRIP.totalDurationSeconds,
      new Date(),
    );

    // Same run — not the 14:00 one the clock alone would have picked.
    expect(selection?.entry.id).toBe('run-a2');
    // Same status, so the headline renders "Arrived … at 11:57 AM"
    // rather than "Arrives … at 2:00 PM".
    expect(selection?.entry.status).toBe(row?.status);
    expect(selection?.entry.actualPickupClock).toBe('11:57 AM');
    // And the row it agrees with is the very object the list labels.
    expect(selection?.entry).toBe(row);
  });

  it('exposes the trip essentials without the token', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([]);

    const detail = await buildTripDetailResponse(TRIP);

    expect(detail.trip).toEqual({
      id: 'trip-1',
      name: 'North Shore Run',
      geometry: TRIP.geometry,
      stops: [
        { label: 'Stop A', lat: 41.0, lng: -87.65 },
        { label: 'Stop B', lat: 41.02, lng: -87.65 },
      ],
      totalDistanceMeters: 2223.9,
      totalDurationSeconds: 600,
    });
    expect(detail.trip).not.toHaveProperty('token');
  });
});
