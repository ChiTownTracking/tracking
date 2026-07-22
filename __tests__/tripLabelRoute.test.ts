import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trip } from '@/lib/trips';

vi.mock('@/lib/tripsStore', () => ({
  getTrip: vi.fn(),
  saveTrip: vi.fn(),
}));

// isUuidShaped stays real — the id-shape gate is under test here.

import { PATCH } from '@/app/api/internal/trips/[id]/vehicles/[vehicleId]/label/route';
import { getTrip, saveTrip } from '@/lib/tripsStore';

const TRIP_ID = 'aaaaaaaa-1111-4222-8333-abcdefabcdef';

function makeTrip(): Trip {
  return {
    id: TRIP_ID,
    token: 'bbbbbbbb-2222-4333-8444-abcdefabcdef',
    name: 'North Shore Run',
    windowStart: '2026-07-17T12:00:00.000Z',
    windowEnd: '2026-07-24T12:00:00.000Z',
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
        schedule: [{ id: 'run-1', arrivalTime: '09:00', waitMinutes: 10 }],
      },
      {
        vehicleId: '1000074171',
        // Starts WITH a label, to prove clearing removes it.
        cardLabel: 'Route B',
        schedule: [{ id: 'run-2', arrivalTime: '13:00', waitMinutes: 5 }],
      },
    ],
    createdAt: '2026-07-17T15:00:00.000Z',
  };
}

function makeRequest(body?: unknown): Request {
  return new Request(
    'http://localhost/api/internal/trips/x/vehicles/y/label',
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

describe('PATCH /api/internal/trips/[id]/vehicles/[vehicleId]/label', () => {
  // The store round-trips through this variable so a clear-after-set
  // sequence sees the prior write (JSON round-trip included).
  let currentTrip: Trip;

  beforeEach(() => {
    vi.clearAllMocks();
    currentTrip = makeTrip();
    vi.mocked(getTrip).mockImplementation(async () => currentTrip);
    vi.mocked(saveTrip).mockImplementation(async (trip) => {
      currentTrip = JSON.parse(JSON.stringify(trip));
    });
  });

  it('sets a label, trims it, and persists it on the right vehicle only', async () => {
    const response = await PATCH(
      makeRequest({ cardLabel: '  Route A  ' }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cardLabel: 'Route A' });

    const saved = vi.mocked(saveTrip).mock.calls[0][0];
    expect(saved.vehicles[0].cardLabel).toBe('Route A');
    // The other vehicle is untouched.
    expect(saved.vehicles[1].cardLabel).toBe('Route B');
  });

  it('clearing with an empty string REMOVES the field, never stores empty', async () => {
    const response = await PATCH(
      makeRequest({ cardLabel: '' }),
      makeParams(TRIP_ID, '1000074171'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cardLabel: null });

    const saved = vi.mocked(saveTrip).mock.calls[0][0];
    // The field is gone, not '' — the absent-means-normal convention.
    expect('cardLabel' in saved.vehicles[1]).toBe(false);
  });

  it('clearing with null REMOVES the field', async () => {
    const response = await PATCH(
      makeRequest({ cardLabel: null }),
      makeParams(TRIP_ID, '1000074171'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cardLabel: null });
    expect('cardLabel' in vi.mocked(saveTrip).mock.calls[0][0].vehicles[1]).toBe(
      false,
    );
  });

  it('a whitespace-only label clears rather than storing blanks', async () => {
    const response = await PATCH(
      makeRequest({ cardLabel: '   ' }),
      makeParams(TRIP_ID, '1000074171'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cardLabel: null });
    expect('cardLabel' in vi.mocked(saveTrip).mock.calls[0][0].vehicles[1]).toBe(
      false,
    );
  });

  it('a set label round-trips: retrievable via the store after saving', async () => {
    await PATCH(makeRequest({ cardLabel: 'Route C' }), makeParams());

    // getTrip now returns the persisted document (mock round-trip).
    const stored = await getTrip(TRIP_ID);
    expect(stored?.vehicles[0].cardLabel).toBe('Route C');
  });

  it('404s for an unknown trip without saving', async () => {
    vi.mocked(getTrip).mockResolvedValue(null);

    const response = await PATCH(
      makeRequest({ cardLabel: 'Route A' }),
      makeParams(),
    );

    expect(response.status).toBe(404);
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('404s, naming the problem, for a vehicle not assigned to this trip', async () => {
    const response = await PATCH(
      makeRequest({ cardLabel: 'Route A' }),
      makeParams(TRIP_ID, '9999999999'),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Vehicle 9999999999 is not assigned to this trip.',
    });
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('404s for a malformed trip id before any store lookup', async () => {
    const response = await PATCH(
      makeRequest({ cardLabel: 'Route A' }),
      makeParams('not-a-uuid'),
    );

    expect(response.status).toBe(404);
    expect(getTrip).not.toHaveBeenCalled();
  });

  it('400s when cardLabel is missing entirely (must be string or null)', async () => {
    const response = await PATCH(makeRequest({}), makeParams());

    expect(response.status).toBe(400);
    expect(saveTrip).not.toHaveBeenCalled();
  });
});
