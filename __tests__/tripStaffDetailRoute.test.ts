import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trip } from '@/lib/trips';

vi.mock('@/lib/tripsStore', () => ({
  getTrip: vi.fn(),
  deleteTrip: vi.fn(),
}));

// isUuidShaped stays real — the id-shape gate is under test here.

import { DELETE, GET } from '@/app/api/internal/trips/[id]/route';
import { deleteTrip, getTrip } from '@/lib/tripsStore';

const TRIP_ID = 'aaaaaaaa-1111-4222-8333-abcdefabcdef';

const TRIP: Trip = {
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
      schedule: [{ id: 'run-1', arrivalTime: '09:00', waitMinutes: 10 }],
    },
  ],
  createdAt: '2026-07-17T15:00:00.000Z',
};

function makeParams(id: string = TRIP_ID): {
  params: Promise<{ id: string }>;
} {
  return { params: Promise.resolve({ id }) };
}

const REQUEST = new Request('http://localhost/api/internal/trips/x');

describe('GET /api/internal/trips/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the FULL staff-side trip document for a real id', async () => {
    vi.mocked(getTrip).mockResolvedValue(TRIP);

    const response = await GET(REQUEST, makeParams());

    expect(response.status).toBe(200);
    // Staff shape: the whole stored document, token and real vehicle ids
    // included — this is authenticated data, not the public shape.
    expect(await response.json()).toEqual(TRIP);
    expect(getTrip).toHaveBeenCalledWith(TRIP_ID);
  });

  it('404s for an unknown id', async () => {
    vi.mocked(getTrip).mockResolvedValue(null);

    const response = await GET(REQUEST, makeParams());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('404s for a malformed id before any store lookup', async () => {
    const response = await GET(REQUEST, makeParams('not-a-uuid'));

    expect(response.status).toBe(404);
    expect(getTrip).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/internal/trips/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes an existing trip and reports the links-route success shape', async () => {
    vi.mocked(getTrip).mockResolvedValue(TRIP);

    const response = await DELETE(REQUEST, makeParams());

    expect(response.status).toBe(200);
    // Same { ok: true } as DELETE /api/internal/links/[token].
    expect(await response.json()).toEqual({ ok: true });
    expect(deleteTrip).toHaveBeenCalledWith(TRIP_ID);
  });

  it('404s for an unknown trip without attempting a delete', async () => {
    vi.mocked(getTrip).mockResolvedValue(null);

    const response = await DELETE(REQUEST, makeParams());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(deleteTrip).not.toHaveBeenCalled();
  });

  it('404s for a malformed id before any store access', async () => {
    const response = await DELETE(REQUEST, makeParams('not-a-uuid'));

    expect(response.status).toBe(404);
    expect(getTrip).not.toHaveBeenCalled();
    expect(deleteTrip).not.toHaveBeenCalled();
  });
});
