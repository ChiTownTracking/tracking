import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trip } from '@/lib/trips';
import type { RosterVehicle } from '@/lib/vehicleRoster';

vi.mock('@/lib/tripsStore', () => ({
  getTrip: vi.fn(),
  saveTrip: vi.fn(),
}));

vi.mock('@/lib/vehicleRoster', () => ({ getVehicleRoster: vi.fn() }));

// getTripStatus and isUuidShaped stay real — the upcoming-only move rule
// and the id-shape gate are exactly what's under test.

import { PATCH } from '@/app/api/internal/trips/[id]/vehicles/[vehicleId]/replace/route';
import { getTrip, saveTrip } from '@/lib/tripsStore';
import { getVehicleRoster } from '@/lib/vehicleRoster';

const TRIP_ID = 'aaaaaaaa-1111-4222-8333-abcdefabcdef';

// Same pinned clock as the cancel tests: noon Chicago (CDT). 09:00 run is
// completed, 11:55 in progress until 12:15, 14:00 upcoming, 15:00 already
// cancelled; the second vehicle's 13:00 run is upcoming but belongs to it.
const NOW = new Date('2026-07-17T17:00:00Z');

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
  {
    vehicleId: '1000099999',
    registrationNumber: 'TRLY-9999',
    description: 'Spare Trolley',
    iconUrl: '',
  },
];

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

function makeRequest(body: unknown): Request {
  return new Request(
    'http://localhost/api/internal/trips/x/vehicles/y/replace',
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
): { params: Promise<{ id: string; vehicleId: string }> } {
  return { params: Promise.resolve({ id, vehicleId }) };
}

describe('PATCH /api/internal/trips/[id]/vehicles/[vehicleId]/replace', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    vi.mocked(getTrip).mockResolvedValue(makeTrip());
    vi.mocked(getVehicleRoster).mockResolvedValue(ROSTER);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves upcoming entries verbatim to a brand-new replacement assignment', async () => {
    const response = await PATCH(
      makeRequest({ replacementVehicleId: '1000099999' }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ movedCount: 1 });

    const saved = vi.mocked(saveTrip).mock.calls[0][0];
    expect(saved.vehicles).toHaveLength(3);
    // The moved entry, copied verbatim — same id, arrival, wait.
    expect(saved.vehicles[2]).toEqual({
      vehicleId: '1000099999',
      schedule: [{ id: 'run-later', arrivalTime: '14:00', waitMinutes: 0 }],
    });
    // The original keeps its history, minus only the moved run.
    expect(saved.vehicles[0].schedule.map((e) => e.id)).toEqual([
      'run-done',
      'run-active',
      'run-cancelled',
    ]);
  });

  it('APPENDS to an existing assignment instead of duplicating the vehicle', async () => {
    const response = await PATCH(
      makeRequest({ replacementVehicleId: '1000074171' }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    const saved = vi.mocked(saveTrip).mock.calls[0][0];
    // Still exactly one assignment per vehicle.
    expect(saved.vehicles).toHaveLength(2);
    expect(saved.vehicles[1].vehicleId).toBe('1000074171');
    // Its own run stays, the moved one lands after it.
    expect(saved.vehicles[1].schedule.map((e) => e.id)).toEqual([
      'run-b1',
      'run-later',
    ]);
  });

  // The core history-preservation regression: nothing already run,
  // running, or cancelled may change in ANY way on a replace.
  it('leaves the original vehicle completed/in-progress/cancelled entries byte-identical', async () => {
    const before = makeTrip().vehicles[0].schedule;

    await PATCH(
      makeRequest({ replacementVehicleId: '1000099999' }),
      makeParams(),
    );

    const saved = vi.mocked(saveTrip).mock.calls[0][0];
    expect(saved.vehicles[0].schedule).toEqual([
      before[0], // run-done, completed
      before[1], // run-active, in progress
      before[3], // run-cancelled, stays cancelled
    ]);
  });

  it('rejects self-replacement with a 400', async () => {
    const response = await PATCH(
      makeRequest({ replacementVehicleId: '1000067169' }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Replacement must be a different vehicle.',
    });
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('rejects a replacement vehicle that is not in the roster', async () => {
    const response = await PATCH(
      makeRequest({ replacementVehicleId: '8888888888' }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Vehicle 8888888888 does not exist.',
    });
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('404s for an unknown trip and for a vehicle not assigned to this trip', async () => {
    vi.mocked(getTrip).mockResolvedValue(null);
    const unknownTrip = await PATCH(
      makeRequest({ replacementVehicleId: '1000099999' }),
      makeParams(),
    );
    expect(unknownTrip.status).toBe(404);

    vi.mocked(getTrip).mockResolvedValue(makeTrip());
    const unassigned = await PATCH(
      makeRequest({ replacementVehicleId: '1000099999' }),
      makeParams(TRIP_ID, '9999999999'),
    );
    expect(unassigned.status).toBe(404);
    expect(await unassigned.json()).toEqual({
      error: 'Vehicle 9999999999 is not assigned to this trip.',
    });
    expect(saveTrip).not.toHaveBeenCalled();
  });

  it('puts the note on the ORIGINAL vehicle, never the replacement', async () => {
    await PATCH(
      makeRequest({
        replacementVehicleId: '1000099999',
        note: 'transmission fault, swapped to spare',
      }),
      makeParams(),
    );

    const saved = vi.mocked(saveTrip).mock.calls[0][0];
    expect(saved.vehicles[0].serviceNote).toBe(
      'transmission fault, swapped to spare',
    );
    expect(saved.vehicles[2].serviceNote).toBeUndefined();
  });
});
