import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Vehicle } from '@/lib/liveVehicles';
import type { Trip } from '@/lib/trips';

vi.mock('@/lib/liveVehicles', () => ({
  getLiveVehicles: vi.fn(),
}));

vi.mock('@/lib/vehicleRoster', () => ({
  getVehicleRoster: vi.fn(),
}));

// estimateTripProgress and getTripStatus stay REAL — progress and run
// statuses should come from the actual math, not a mock's echo.

import { getLiveVehicles } from '@/lib/liveVehicles';
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
    expect(a.schedule.map((run) => run.status)).toEqual([
      'completed',
      'in-progress',
      'upcoming',
    ]);
    expect(b.schedule.map((run) => run.status)).toEqual(['upcoming']);
  });

  // The multi-run mirror of the old sibling-window tests: one vehicle's
  // runs carry all three states simultaneously, each judged on its own
  // clock window (which includes its own pickup wait).
  it('a vehicle with multiple runs shows completed/in-progress/upcoming all at once', async () => {
    vi.mocked(getLiveVehicles).mockResolvedValue([
      liveVehicle('1000067169', 41.005, 12),
      liveVehicle('1000074171', 41.015, 20),
    ]);

    const detail = await buildTripDetailResponse(TRIP);

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
