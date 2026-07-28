import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trip } from '@/lib/trips';
import type { RosterVehicle } from '@/lib/vehicleRoster';

vi.mock('@/lib/tripsStore', () => ({
  getTrip: vi.fn(),
  saveTrip: vi.fn(),
}));

vi.mock('@/lib/googleMapsClient', () => ({
  googleMapsClient: { predictArrival: vi.fn() },
}));

vi.mock('@/lib/vehicleRoster', () => ({ getVehicleRoster: vi.fn() }));

// isUuidShaped and the prediction resolver stay real — the id-shape gate
// and the reuse-vs-fetch decision are what this route is made of.

import { POST } from '@/app/api/internal/trips/[id]/vehicles/route';
import { googleMapsClient } from '@/lib/googleMapsClient';
import { getTrip, saveTrip } from '@/lib/tripsStore';
import { getVehicleRoster } from '@/lib/vehicleRoster';

const TRIP_ID = 'aaaaaaaa-1111-4222-8333-abcdefabcdef';

const ROSTER: RosterVehicle[] = [
  {
    vehicleId: '1000067169',
    registrationNumber: 'TRLY-7169',
    description: 'Trolley 1',
    iconUrl: '',
  },
  {
    vehicleId: '1000074171',
    registrationNumber: 'TRLY-4171',
    description: 'Trolley 2',
    iconUrl: '',
  },
];

// Real values from __fixtures__/googleRoutePredicted.json.
const FRESH = { predictedDurationSeconds: 1061, staticDurationSeconds: 1332 };
// What the trip's existing vehicle already stores for its 09:10 departure
// — deliberately different numbers, so a reused prediction can't be
// mistaken for a freshly fetched one.
const EXISTING = {
  predictedDurationSeconds: 2000,
  staticDurationSeconds: 2200,
};

// The trip already has ONE vehicle, arriving 09:00 with a 10-minute wait
// (departure 09:10) and a stored prediction for that clock.
function makeTrip(): Trip {
  return {
    id: TRIP_ID,
    token: 'bbbbbbbb-2222-4333-8444-abcdefabcdef',
    name: 'North Shore Run',
    windowStart: '2026-07-20T14:00:00.000Z',
    windowEnd: '2026-07-27T14:00:00.000Z',
    waypoints: [
      { label: 'Stop A', lat: 41.0, lng: -87.65 },
      { label: 'Stop B', lat: 41.02, lng: -87.65 },
    ],
    geometry: [
      [41.0, -87.65],
      [41.02, -87.65],
    ],
    legs: [{ distanceMeters: 2223.9, durationSeconds: 600 }],
    legBoundaryIndices: [0, 1],
    totalDistanceMeters: 2223.9,
    totalDurationSeconds: 600,
    vehicles: [
      {
        vehicleId: '1000067169',
        schedule: [
          {
            id: 'run-1',
            arrivalTime: '09:00',
            waitMinutes: 10,
            predictedArrivalDurationSeconds: EXISTING.predictedDurationSeconds,
            predictedArrivalStaticDurationSeconds:
              EXISTING.staticDurationSeconds,
          },
        ],
      },
    ],
    createdAt: '2026-07-17T15:00:00.000Z',
  };
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/internal/trips/x/vehicles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeParams(id: string = TRIP_ID): {
  params: Promise<{ id: string }>;
} {
  return { params: Promise.resolve({ id }) };
}

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('POST /api/internal/trips/[id]/vehicles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTrip).mockResolvedValue(makeTrip());
    vi.mocked(getVehicleRoster).mockResolvedValue(ROSTER);
    vi.mocked(googleMapsClient.predictArrival).mockResolvedValue(FRESH);
  });

  it('appends a second vehicle with minted run ids, leaving the first untouched', async () => {
    const response = await POST(
      makeRequest({
        vehicleId: '1000074171',
        schedule: [
          { arrivalTime: '13:00', waitMinutes: 0 },
          { arrivalTime: '17:30', waitMinutes: 5 },
        ],
      }),
      makeParams(),
    );

    expect(response.status).toBe(200);

    const saved = vi.mocked(saveTrip).mock.calls[0][0];
    expect(saved.vehicles.map((v) => v.vehicleId)).toEqual([
      '1000067169',
      '1000074171',
    ]);
    // Appended, never replacing what was there.
    expect(saved.vehicles[0].schedule[0].id).toBe('run-1');

    const added = saved.vehicles[1];
    expect(added.schedule.map((e) => e.arrivalTime)).toEqual([
      '13:00',
      '17:30',
    ]);
    expect(added.schedule.map((e) => e.waitMinutes)).toEqual([0, 5]);
    added.schedule.forEach((entry) => expect(entry.id).toMatch(UUID_SHAPE));
    expect(new Set(added.schedule.map((e) => e.id)).size).toBe(2);

    // The trip's own path is a property of the trip, not of who drives it.
    expect(saved.geometry).toEqual(makeTrip().geometry);
    expect(saved.totalDurationSeconds).toBe(600);
  });

  it('fetches a prediction for a genuinely new departure clock', async () => {
    await POST(
      makeRequest({
        vehicleId: '1000074171',
        schedule: [{ arrivalTime: '13:00', waitMinutes: 0 }],
      }),
      makeParams(),
    );

    expect(googleMapsClient.predictArrival).toHaveBeenCalledTimes(1);
    // First waypoint → last waypoint direct, at a real future Date.
    expect(googleMapsClient.predictArrival).toHaveBeenCalledWith(
      { lat: 41.0, lng: -87.65 },
      { lat: 41.02, lng: -87.65 },
      expect.any(Date),
    );

    const added = vi.mocked(saveTrip).mock.calls[0][0].vehicles[1];
    expect(added.schedule[0].predictedArrivalDurationSeconds).toBe(
      FRESH.predictedDurationSeconds,
    );
    expect(added.schedule[0].predictedArrivalStaticDurationSeconds).toBe(
      FRESH.staticDurationSeconds,
    );
  });

  it("reuses an existing vehicle's prediction for a shared departure clock, spending NO call", async () => {
    // 09:00 + 10 = 09:10 — exactly the clock the trip's first vehicle
    // already has a prediction for. A second bus mirroring the first's
    // times is the common case, and it should cost nothing.
    const response = await POST(
      makeRequest({
        vehicleId: '1000074171',
        schedule: [{ arrivalTime: '09:00', waitMinutes: 10 }],
      }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(googleMapsClient.predictArrival).not.toHaveBeenCalled();

    const added = vi.mocked(saveTrip).mock.calls[0][0].vehicles[1];
    expect(added.schedule[0].predictedArrivalDurationSeconds).toBe(
      EXISTING.predictedDurationSeconds,
    );
    expect(added.schedule[0].predictedArrivalStaticDurationSeconds).toBe(
      EXISTING.staticDurationSeconds,
    );
  });

  it('mixes reuse and fetch across one vehicle\'s runs', async () => {
    await POST(
      makeRequest({
        vehicleId: '1000074171',
        schedule: [
          { arrivalTime: '09:00', waitMinutes: 10 }, // 09:10 — known
          { arrivalTime: '13:00', waitMinutes: 0 }, // 13:00 — new
        ],
      }),
      makeParams(),
    );

    expect(googleMapsClient.predictArrival).toHaveBeenCalledTimes(1);
    const added = vi.mocked(saveTrip).mock.calls[0][0].vehicles[1];
    expect(added.schedule[0].predictedArrivalDurationSeconds).toBe(
      EXISTING.predictedDurationSeconds,
    );
    expect(added.schedule[1].predictedArrivalDurationSeconds).toBe(
      FRESH.predictedDurationSeconds,
    );
  });

  it('a failed prediction still adds the vehicle, with the fields absent', async () => {
    vi.mocked(googleMapsClient.predictArrival).mockRejectedValue(
      new Error('Google request failed (429): quota exceeded'),
    );

    const response = await POST(
      makeRequest({
        vehicleId: '1000074171',
        schedule: [{ arrivalTime: '13:00', waitMinutes: 0 }],
      }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    const entry = vi.mocked(saveTrip).mock.calls[0][0].vehicles[1].schedule[0];
    expect(entry.arrivalTime).toBe('13:00');
    // Absent, not zero/null — Google never blocks the edit.
    expect('predictedArrivalDurationSeconds' in entry).toBe(false);
    expect('predictedArrivalStaticDurationSeconds' in entry).toBe(false);
  });

  it('refuses a vehicle already on the trip, pointing at its existing schedule', async () => {
    const response = await POST(
      makeRequest({
        vehicleId: '1000067169',
        schedule: [{ arrivalTime: '13:00', waitMinutes: 0 }],
      }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        'Vehicle 1000067169 is already on this trip — edit its existing schedule instead.',
    });
    // One assignment per vehicle per trip stays intact, and no roster call
    // or Google call is spent finding that out.
    expect(saveTrip).not.toHaveBeenCalled();
    expect(getVehicleRoster).not.toHaveBeenCalled();
    expect(googleMapsClient.predictArrival).not.toHaveBeenCalled();
  });

  it('refuses a vehicle that is not in the roster', async () => {
    const response = await POST(
      makeRequest({
        vehicleId: '9999999999',
        schedule: [{ arrivalTime: '13:00', waitMinutes: 0 }],
      }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    // Same wording as every other roster check in the app.
    expect(await response.json()).toEqual({
      error: 'Vehicle 9999999999 does not exist.',
    });
    expect(saveTrip).not.toHaveBeenCalled();
    expect(googleMapsClient.predictArrival).not.toHaveBeenCalled();
  });

  it('400s on a malformed body, before any roster or Google call', async () => {
    for (const body of [
      { vehicleId: '1000074171', schedule: [] },
      { vehicleId: '1000074171' },
      { schedule: [{ arrivalTime: '13:00', waitMinutes: 0 }] },
      {
        vehicleId: '1000074171',
        schedule: [{ arrivalTime: '1pm', waitMinutes: 0 }],
      },
      {
        vehicleId: '1000074171',
        schedule: [{ arrivalTime: '13:00', waitMinutes: -1 }],
      },
      {
        vehicleId: '1000074171',
        schedule: [{ arrivalTime: '13:00', waitMinutes: 1.5 }],
      },
    ]) {
      const response = await POST(makeRequest(body), makeParams());
      expect(response.status).toBe(400);
    }
    expect(getVehicleRoster).not.toHaveBeenCalled();
    expect(googleMapsClient.predictArrival).not.toHaveBeenCalled();
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('404s for an unknown trip without saving', async () => {
    vi.mocked(getTrip).mockResolvedValue(null);

    const response = await POST(
      makeRequest({
        vehicleId: '1000074171',
        schedule: [{ arrivalTime: '13:00', waitMinutes: 0 }],
      }),
      makeParams(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('404s for a malformed trip id before any store lookup', async () => {
    const response = await POST(
      makeRequest({
        vehicleId: '1000074171',
        schedule: [{ arrivalTime: '13:00', waitMinutes: 0 }],
      }),
      makeParams('not-a-uuid'),
    );

    expect(response.status).toBe(404);
    expect(getTrip).not.toHaveBeenCalled();
    expect(saveTrip).not.toHaveBeenCalled();
  });
});
