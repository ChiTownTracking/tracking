import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trip } from '@/lib/trips';

vi.mock('@/lib/tripsStore', () => ({
  getTrip: vi.fn(),
  deleteTrip: vi.fn(),
  saveTrip: vi.fn(),
}));

// isUuidShaped stays real — the id-shape gate is under test here.

import { DELETE, GET, PATCH } from '@/app/api/internal/trips/[id]/route';
import { deleteTrip, getTrip, saveTrip } from '@/lib/tripsStore';

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

// Phase O1: name/window editing. The window fixture is separate from TRIP
// (which deliberately has none, covering the pre-N3 shape) so the merge
// rules can be tested against a trip that really does store a window.
const WINDOWED_TRIP: Trip = {
  ...TRIP,
  windowStart: '2026-07-20T14:00:00.000Z',
  windowEnd: '2026-07-27T14:00:00.000Z',
};

function makePatchRequest(body: unknown): Request {
  return new Request('http://localhost/api/internal/trips/x', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/internal/trips/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTrip).mockResolvedValue(WINDOWED_TRIP);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renames a trip, leaving its window and everything else untouched', async () => {
    const response = await PATCH(
      makePatchRequest({ name: 'South Shore Run' }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    const saved = vi.mocked(saveTrip).mock.calls[0][0];
    expect(saved.name).toBe('South Shore Run');
    expect(saved.windowStart).toBe(WINDOWED_TRIP.windowStart);
    expect(saved.windowEnd).toBe(WINDOWED_TRIP.windowEnd);
    // The path and its runs are not this endpoint's business.
    expect(saved.waypoints).toEqual(TRIP.waypoints);
    expect(saved.vehicles).toEqual(TRIP.vehicles);
  });

  it('accepts a windowEnd-only edit, validated against the STORED windowStart', async () => {
    const response = await PATCH(
      makePatchRequest({ windowEnd: '2026-07-30T14:00:00.000Z' }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: 'North Shore Run',
      windowStart: WINDOWED_TRIP.windowStart,
      windowEnd: '2026-07-30T14:00:00.000Z',
    });
    const saved = vi.mocked(saveTrip).mock.calls[0][0];
    expect(saved.windowEnd).toBe('2026-07-30T14:00:00.000Z');
    // Untouched by a one-sided edit.
    expect(saved.windowStart).toBe(WINDOWED_TRIP.windowStart);
    expect(saved.name).toBe('North Shore Run');
  });

  it('rejects a one-sided edit that would invert the window against the stored other side', async () => {
    // Nothing in the body is wrong on its own — only the MERGED window is,
    // which is exactly why the check happens after the merge.
    const response = await PATCH(
      makePatchRequest({ windowEnd: '2026-07-19T14:00:00.000Z' }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'windowEnd must be after windowStart',
    });
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('rejects an inverted window supplied wholesale in one body', async () => {
    const response = await PATCH(
      makePatchRequest({
        windowStart: '2026-08-01T14:00:00.000Z',
        windowEnd: '2026-07-31T14:00:00.000Z',
      }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('ALLOWS shortening the window into the past — how staff end a link early', async () => {
    // Pinned so "the past" is unambiguous: the new end is behind `now` and
    // still after windowStart. There is deliberately no future check here.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));

    const response = await PATCH(
      makePatchRequest({ windowEnd: '2026-07-24T12:00:00.000Z' }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(saveTrip).mock.calls[0][0].windowEnd).toBe(
      '2026-07-24T12:00:00.000Z',
    );
  });

  it('updates name and window together', async () => {
    const response = await PATCH(
      makePatchRequest({
        name: 'Renamed Run',
        windowStart: '2026-08-01T14:00:00.000Z',
        windowEnd: '2026-08-08T14:00:00.000Z',
      }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    const saved = vi.mocked(saveTrip).mock.calls[0][0];
    expect(saved.name).toBe('Renamed Run');
    expect(saved.windowStart).toBe('2026-08-01T14:00:00.000Z');
    expect(saved.windowEnd).toBe('2026-08-08T14:00:00.000Z');
  });

  it('a pre-N3 trip with no window keeps having none when only renamed', async () => {
    vi.mocked(getTrip).mockResolvedValue(TRIP);

    const response = await PATCH(
      makePatchRequest({ name: 'Legacy Run' }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    const saved = vi.mocked(saveTrip).mock.calls[0][0];
    // Absent, not explicit undefined keys — the field contract in
    // lib/trips.ts, and what keeps the public gate off for legacy trips.
    expect('windowStart' in saved).toBe(false);
    expect('windowEnd' in saved).toBe(false);
  });

  it('400s on a body that changes nothing', async () => {
    const response = await PATCH(makePatchRequest({}), makeParams());

    expect(response.status).toBe(400);
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('400s on an empty name', async () => {
    const response = await PATCH(
      makePatchRequest({ name: '   ' }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('404s for an unknown trip without saving', async () => {
    vi.mocked(getTrip).mockResolvedValue(null);

    const response = await PATCH(
      makePatchRequest({ name: 'Ghost Run' }),
      makeParams(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('404s for a malformed id before any store lookup', async () => {
    const response = await PATCH(
      makePatchRequest({ name: 'Ghost Run' }),
      makeParams('not-a-uuid'),
    );

    expect(response.status).toBe(404);
    expect(getTrip).not.toHaveBeenCalled();
    expect(saveTrip).not.toHaveBeenCalled();
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
