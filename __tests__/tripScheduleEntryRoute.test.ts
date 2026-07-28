import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trip } from '@/lib/trips';

vi.mock('@/lib/tripsStore', () => ({
  getTrip: vi.fn(),
  saveTrip: vi.fn(),
}));

vi.mock('@/lib/googleMapsClient', () => ({
  googleMapsClient: { predictArrival: vi.fn() },
}));

// isUuidShaped, the N6 occurrence math, and the prediction resolver all stay
// real — the window-aware in-progress gate and the reuse-vs-fetch decision
// are precisely what is under test.

import { PATCH } from '@/app/api/internal/trips/[id]/vehicles/[vehicleId]/schedule/[entryId]/route';
import { googleMapsClient } from '@/lib/googleMapsClient';
import { getTrip, saveTrip } from '@/lib/tripsStore';

const TRIP_ID = 'aaaaaaaa-1111-4222-8333-abcdefabcdef';

// Real values from __fixtures__/googleRoutePredicted.json.
const FRESH = { predictedDurationSeconds: 1061, staticDurationSeconds: 1332 };
// The sibling run's stored prediction — deliberately different numbers, so
// a reused prediction can't be mistaken for a freshly fetched one.
const SIBLING = { predictedDurationSeconds: 2000, staticDurationSeconds: 2200 };
// What run-1 starts with, for the "stale prediction must not linger" case.
const STALE = { predictedDurationSeconds: 555, staticDurationSeconds: 666 };

// totalDurationSeconds 600 (10 min): run-1 arrives 09:00 and waits 10, so
// its status span is 09:00 → 09:20 Chicago. Every pinned clock below is
// chosen against that span.
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
            predictedArrivalDurationSeconds: STALE.predictedDurationSeconds,
            predictedArrivalStaticDurationSeconds:
              STALE.staticDurationSeconds,
          },
          { id: 'run-cancelled', arrivalTime: '11:00', waitMinutes: 0, cancelled: true },
        ],
      },
      {
        // A DIFFERENT vehicle, to prove the sibling scan crosses
        // assignments rather than only looking at the edited one.
        vehicleId: '1000074171',
        schedule: [
          {
            id: 'run-sibling',
            arrivalTime: '16:00',
            waitMinutes: 5,
            predictedArrivalDurationSeconds: SIBLING.predictedDurationSeconds,
            predictedArrivalStaticDurationSeconds:
              SIBLING.staticDurationSeconds,
          },
        ],
      },
    ],
    createdAt: '2026-07-17T15:00:00.000Z',
  };
}

function makeRequest(body: unknown): Request {
  return new Request(
    'http://localhost/api/internal/trips/x/vehicles/y/schedule/z',
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

function makeParams(
  id: string = TRIP_ID,
  vehicleId: string = '1000067169',
  entryId: string = 'run-1',
): {
  params: Promise<{ id: string; vehicleId: string; entryId: string }>;
} {
  return { params: Promise.resolve({ id, vehicleId, entryId }) };
}

function savedRun(id: string) {
  return vi
    .mocked(saveTrip)
    .mock.calls[0][0].vehicles.flatMap((v) => v.schedule)
    .find((run) => run.id === id);
}

describe('PATCH /api/internal/trips/[id]/vehicles/[vehicleId]/schedule/[entryId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTrip).mockResolvedValue(makeTrip());
    vi.mocked(googleMapsClient.predictArrival).mockResolvedValue(FRESH);
    // 06:00 Chicago: run-1's 09:00 occurrence is still genuinely upcoming.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T11:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retimes an upcoming run, leaving every other run alone', async () => {
    const response = await PATCH(
      makeRequest({ arrivalTime: '10:15', waitMinutes: 0 }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      departureClock: '10:15',
      entry: { id: 'run-1', arrivalTime: '10:15', waitMinutes: 0 },
    });

    expect(savedRun('run-1')).toMatchObject({
      arrivalTime: '10:15',
      waitMinutes: 0,
    });
    // Siblings on both assignments are untouched.
    expect(savedRun('run-sibling')).toMatchObject({
      arrivalTime: '16:00',
      waitMinutes: 5,
    });
    expect(savedRun('run-cancelled')).toMatchObject({
      arrivalTime: '11:00',
      cancelled: true,
    });
  });

  it('a novel departure clock spends one fresh prediction call, replacing the stale one', async () => {
    // 10:15 + 0 = 10:15, matching no existing run on the trip.
    await PATCH(
      makeRequest({ arrivalTime: '10:15', waitMinutes: 0 }),
      makeParams(),
    );

    expect(googleMapsClient.predictArrival).toHaveBeenCalledTimes(1);
    expect(googleMapsClient.predictArrival).toHaveBeenCalledWith(
      { lat: 41.0, lng: -87.65 },
      { lat: 41.02, lng: -87.65 },
      expect.any(Date),
    );
    const run = savedRun('run-1');
    expect(run?.predictedArrivalDurationSeconds).toBe(
      FRESH.predictedDurationSeconds,
    );
    expect(run?.predictedArrivalStaticDurationSeconds).toBe(
      FRESH.staticDurationSeconds,
    );
  });

  it("reuses a sibling's prediction for a shared departure clock, spending NO call", async () => {
    // 16:00 + 5 = 16:05 — run-sibling's departure clock, on the OTHER
    // vehicle. Same one-call-per-distinct-clock rule creation follows.
    const response = await PATCH(
      makeRequest({ arrivalTime: '16:00', waitMinutes: 5 }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(googleMapsClient.predictArrival).not.toHaveBeenCalled();

    const run = savedRun('run-1');
    expect(run?.predictedArrivalDurationSeconds).toBe(
      SIBLING.predictedDurationSeconds,
    );
    expect(run?.predictedArrivalStaticDurationSeconds).toBe(
      SIBLING.staticDurationSeconds,
    );
  });

  it('a failed prediction still saves the new time, with the stale prediction GONE', async () => {
    vi.mocked(googleMapsClient.predictArrival).mockRejectedValue(
      new Error('Google request failed (429): quota exceeded'),
    );

    const response = await PATCH(
      makeRequest({ arrivalTime: '10:15', waitMinutes: 0 }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    const run = savedRun('run-1');
    expect(run?.arrivalTime).toBe('10:15');
    // Both fields absent — the old numbers belonged to the OLD time and
    // must not linger against the new one.
    expect(run !== undefined && 'predictedArrivalDurationSeconds' in run).toBe(
      false,
    );
    expect(
      run !== undefined && 'predictedArrivalStaticDurationSeconds' in run,
    ).toBe(false);
  });

  it('refuses to edit a cancelled run', async () => {
    const response = await PATCH(
      makeRequest({ arrivalTime: '12:00', waitMinutes: 0 }),
      makeParams(TRIP_ID, '1000067169', 'run-cancelled'),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Cannot edit a cancelled run.',
    });
    expect(saveTrip).not.toHaveBeenCalled();
    expect(googleMapsClient.predictArrival).not.toHaveBeenCalled();
  });

  it("refuses to edit a run that's in progress right now", async () => {
    // 09:10 Chicago — inside run-1's 09:00→09:20 span, and its departure
    // instant sits inside the trip's window, so the occurrence is real.
    vi.setSystemTime(new Date('2026-07-24T14:10:00.000Z'));

    const response = await PATCH(
      makeRequest({ arrivalTime: '10:15', waitMinutes: 0 }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Cannot edit a run that's currently in progress.",
    });
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('still allows editing at that same clock when the occurrence falls OUTSIDE the trip window', async () => {
    // The wall clock is mid-span exactly as above, but the window has not
    // opened yet, so today's occurrence never happens and there is nothing
    // in progress to disturb. This is the N6 distinction — a naive clock
    // check would 400 here.
    vi.setSystemTime(new Date('2026-07-24T14:10:00.000Z'));
    vi.mocked(getTrip).mockResolvedValue({
      ...makeTrip(),
      windowStart: '2026-07-26T14:00:00.000Z',
      windowEnd: '2026-08-02T14:00:00.000Z',
    });

    const response = await PATCH(
      makeRequest({ arrivalTime: '10:15', waitMinutes: 0 }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(savedRun('run-1')).toMatchObject({ arrivalTime: '10:15' });
  });

  it('400s on a malformed body', async () => {
    for (const body of [
      { arrivalTime: '9am', waitMinutes: 0 },
      { arrivalTime: '09:00', waitMinutes: -1 },
      { arrivalTime: '09:00', waitMinutes: 1.5 },
      { arrivalTime: '09:00' },
      { waitMinutes: 0 },
    ]) {
      const response = await PATCH(makeRequest(body), makeParams());
      expect(response.status).toBe(400);
    }
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('404s for an unknown trip', async () => {
    vi.mocked(getTrip).mockResolvedValue(null);

    const response = await PATCH(
      makeRequest({ arrivalTime: '10:15', waitMinutes: 0 }),
      makeParams(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('404s, naming the problem, for a vehicle not assigned to this trip', async () => {
    const response = await PATCH(
      makeRequest({ arrivalTime: '10:15', waitMinutes: 0 }),
      makeParams(TRIP_ID, '9999999999'),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Vehicle 9999999999 is not assigned to this trip.',
    });
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it("404s for a run id that isn't on that vehicle's schedule", async () => {
    // run-sibling is real, but it belongs to the OTHER vehicle — the
    // lookup is scoped to the assignment, not the whole trip.
    const response = await PATCH(
      makeRequest({ arrivalTime: '10:15', waitMinutes: 0 }),
      makeParams(TRIP_ID, '1000067169', 'run-sibling'),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Run run-sibling is not on this vehicle's schedule.",
    });
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('404s for a malformed trip id before any store lookup', async () => {
    const response = await PATCH(
      makeRequest({ arrivalTime: '10:15', waitMinutes: 0 }),
      makeParams('not-a-uuid'),
    );

    expect(response.status).toBe(404);
    expect(getTrip).not.toHaveBeenCalled();
    expect(saveTrip).not.toHaveBeenCalled();
  });
});
