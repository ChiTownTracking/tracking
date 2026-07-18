import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trip } from '@/lib/trips';

vi.mock('@/lib/tripsStore', () => ({
  getTrip: vi.fn(),
  saveTrip: vi.fn(),
}));

// getTripStatus and isUuidShaped stay real — the upcoming-only rule and the
// id-shape gate are exactly what's under test.

import { PATCH } from '@/app/api/internal/trips/[id]/vehicles/[vehicleId]/cancel/route';
import { getTrip, saveTrip } from '@/lib/tripsStore';

const TRIP_ID = 'aaaaaaaa-1111-4222-8333-abcdefabcdef';

// Same pinned-clock pattern as scheduleEntry/tripDetail tests: noon Chicago
// (CDT, UTC-5). With a 600s trip duration: 09:00+10min ended 09:20
// (completed), 11:55+10min runs until 12:15 (in progress), 14:00 and the
// already-cancelled 15:00 are ahead.
const NOW = new Date('2026-07-17T17:00:00Z');

function makeTrip(): Trip {
  return {
    id: TRIP_ID,
    token: 'bbbbbbbb-2222-4333-8444-abcdefabcdef',
    name: 'North Shore Run',
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
          { id: 'run-done', arrivalTime: '09:00', waitMinutes: 10 },
          { id: 'run-active', arrivalTime: '11:55', waitMinutes: 10 },
          { id: 'run-later', arrivalTime: '14:00', waitMinutes: 0 },
          {
            id: 'run-cancelled',
            arrivalTime: '15:00',
            waitMinutes: 0,
            cancelled: true,
          },
        ],
      },
      {
        vehicleId: '1000074171',
        schedule: [{ id: 'run-b1', arrivalTime: '13:00', waitMinutes: 5 }],
      },
    ],
    createdAt: '2026-07-17T15:00:00.000Z',
  };
}

function makeRequest(body?: unknown): Request {
  return new Request(
    'http://localhost/api/internal/trips/x/vehicles/y/cancel',
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}

function makeParams(
  id: string = TRIP_ID,
  vehicleId: string = '1000067169',
): { params: Promise<{ id: string; vehicleId: string }> } {
  return { params: Promise.resolve({ id, vehicleId }) };
}

describe('PATCH /api/internal/trips/[id]/vehicles/[vehicleId]/cancel', () => {
  // The store round-trips through this variable so consecutive calls see
  // each other's writes (the idempotency test needs real persistence
  // semantics, JSON round-trip included).
  let currentTrip: Trip;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    currentTrip = makeTrip();
    vi.mocked(getTrip).mockImplementation(async () => currentTrip);
    vi.mocked(saveTrip).mockImplementation(async (trip) => {
      currentTrip = JSON.parse(JSON.stringify(trip));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels ONLY genuinely-upcoming entries; completed/in-progress provably untouched', async () => {
    const response = await PATCH(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    // run-later is the only flip: run-done is completed, run-active is in
    // progress, run-cancelled already was.
    expect(await response.json()).toEqual({ cancelledCount: 1 });

    const saved = vi.mocked(saveTrip).mock.calls[0][0];
    const [done, active, later, alreadyCancelled] =
      saved.vehicles[0].schedule;
    expect(done).toEqual({
      id: 'run-done',
      arrivalTime: '09:00',
      waitMinutes: 10,
    });
    expect(active).toEqual({
      id: 'run-active',
      arrivalTime: '11:55',
      waitMinutes: 10,
    });
    expect(later).toEqual({
      id: 'run-later',
      arrivalTime: '14:00',
      waitMinutes: 0,
      cancelled: true,
    });
    expect(alreadyCancelled.cancelled).toBe(true);
    // The other vehicle's upcoming run is not this cancel's business.
    expect(saved.vehicles[1]).toEqual(makeTrip().vehicles[1]);
  });

  it('is idempotent: a second cancel reports zero newly-cancelled', async () => {
    await PATCH(makeRequest(), makeParams());
    const second = await PATCH(makeRequest(), makeParams());

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ cancelledCount: 0 });
  });

  it('stores the note when provided, leaves it alone when omitted', async () => {
    await PATCH(makeRequest({ note: 'engine trouble' }), makeParams());
    expect(
      vi.mocked(saveTrip).mock.calls[0][0].vehicles[0].serviceNote,
    ).toBe('engine trouble');

    // Second call WITHOUT a note: the stored note survives.
    await PATCH(makeRequest(), makeParams());
    expect(
      vi.mocked(saveTrip).mock.calls[1][0].vehicles[0].serviceNote,
    ).toBe('engine trouble');
  });

  it('404s for an unknown trip', async () => {
    vi.mocked(getTrip).mockResolvedValue(null);

    const response = await PATCH(makeRequest(), makeParams());

    expect(response.status).toBe(404);
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('404s, naming the problem, for a vehicle not assigned to this trip', async () => {
    const response = await PATCH(
      makeRequest(),
      makeParams(TRIP_ID, '9999999999'),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Vehicle 9999999999 is not assigned to this trip.',
    });
    expect(saveTrip).not.toHaveBeenCalled();
  });
});
