import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { Vehicle } from '@/lib/liveVehicles';
import type { Trip } from '@/lib/trips';
import type { RosterVehicle } from '@/lib/vehicleRoster';

const { limitMock, slidingWindowCalls, limiterPrefixes } = vi.hoisted(() => ({
  limitMock: vi.fn(),
  // Plain arrays, not mocks: they survive clearAllMocks, so the one-time
  // lazy Ratelimit construction stays observable regardless of test order.
  slidingWindowCalls: [] as Array<[number, string]>,
  limiterPrefixes: [] as string[],
}));

vi.mock('@upstash/ratelimit', () => {
  class Ratelimit {
    constructor(options: { prefix: string }) {
      limiterPrefixes.push(options.prefix);
    }
    static slidingWindow(maxAttempts: number, window: string) {
      slidingWindowCalls.push([maxAttempts, window]);
      return { maxAttempts, window };
    }
    limit(key: string) {
      return limitMock(key);
    }
  }
  return { Ratelimit };
});

vi.mock('@/lib/redisClient', () => ({
  getRedis: () => ({}),
}));

vi.mock('@/lib/tripsStore', () => ({
  getTripByToken: vi.fn(),
}));

vi.mock('@/lib/liveVehicles', () => ({
  getLiveVehicles: vi.fn(),
}));

vi.mock('@/lib/vehicleRoster', () => ({
  getVehicleRoster: vi.fn(),
}));

// buildTripDetailResponse stays REAL (fed by the mocked live/roster layers)
// — belt and suspenders with tripDetail.test.ts. isUuidShaped stays real:
// the token-shape gate is under test here.

import { GET } from '@/app/api/public/trip/[token]/route';
import { getLiveVehicles } from '@/lib/liveVehicles';
import { WINDOW_MESSAGES } from '@/lib/trackingWindow';
import { getTripByToken } from '@/lib/tripsStore';
import { getVehicleRoster } from '@/lib/vehicleRoster';

const TOKEN = 'a1b2c3d4-1111-4222-8333-abcdefabcdef';

const TRIP: Trip = {
  id: 'trip-1',
  token: TOKEN,
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
      schedule: [{ id: 'run-1', arrivalTime: '07:00', waitMinutes: 10 }],
    },
    {
      vehicleId: '1000074171',
      schedule: [{ id: 'run-2', arrivalTime: '09:15', waitMinutes: 0 }],
    },
  ],
  createdAt: '2026-07-17T15:00:00.000Z',
};

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

const LIVE: Vehicle = {
  vehicleId: '1000067169',
  registrationNumber: 'TRLY-7169',
  description: 'Trolley 1',
  iconUrl: '',
  latitude: 41.005,
  longitude: -87.65,
  heading: 355,
  speed: 12,
  locationText: 'Clark St',
  lastUpdatedAt: '2026-07-17T15:00:00.000Z',
};

function makeRequest(token: string = TOKEN): NextRequest {
  return new Request(`http://localhost/api/public/trip/${token}`, {
    headers: { 'x-forwarded-for': '1.2.3.4' },
  }) as unknown as NextRequest;
}

function makeParams(token: string = TOKEN): {
  params: Promise<{ token: string }>;
} {
  return { params: Promise.resolve({ token }) };
}

describe('GET /api/public/trip/[token]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockResolvedValue({
      success: true,
      limit: 30,
      remaining: 29,
      reset: Date.now() + 60_000,
    });
    vi.mocked(getVehicleRoster).mockResolvedValue(ROSTER);
    vi.mocked(getLiveVehicles).mockResolvedValue([LIVE]);
  });

  it('returns a generic 404 for an unknown token with zero data-layer calls', async () => {
    vi.mocked(getTripByToken).mockResolvedValue(null);

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(getLiveVehicles).not.toHaveBeenCalled();
    expect(getVehicleRoster).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID-shaped token with the identical 404, before any Redis lookup', async () => {
    const malformed = await GET(
      makeRequest('garbage'),
      makeParams("not-a-uuid'; DROP TABLE"),
    );
    vi.mocked(getTripByToken).mockResolvedValue(null);
    const unknown = await GET(makeRequest(), makeParams());

    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual(await unknown.json());
    // The shape gate ran before the token store was ever consulted.
    expect(getTripByToken).toHaveBeenCalledTimes(1);
  });

  it('a valid token returns the multi-vehicle detail: shared path, per-vehicle progress and runs', async () => {
    vi.mocked(getTripByToken).mockResolvedValue(TRIP);

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.trip.name).toBe('North Shore Run');
    expect(body.trip.stops).toHaveLength(2);
    expect(body.trip).not.toHaveProperty('token');

    expect(body.vehicles).toHaveLength(2);
    const [live, dark] = body.vehicles;
    // The reporting vehicle: real position and F3 progress.
    expect(live.vehicleId).toBe('1000067169');
    expect(live.position).toEqual({
      lat: 41.005,
      lng: -87.65,
      headingDegrees: 355,
    });
    expect(live.nextStopIndex).toBe(1);
    // The dark vehicle still carries its full static schedule.
    expect(dark.vehicleId).toBe('1000074171');
    expect(dark.position).toBeNull();
    expect(dark.schedule).toHaveLength(1);
    // Run statuses ride along on every schedule entry (clock-dependent, so
    // asserted by membership, not exact value).
    for (const vehicle of body.vehicles) {
      for (const run of vehicle.schedule) {
        expect(['upcoming', 'in-progress', 'completed']).toContain(run.status);
      }
    }
  });

  // Phase N3: the trip-level active window gates the public page exactly
  // like /track. Windows are built relative to now so the cases stay
  // time-robust without pinning the clock (getWindowStatus stays real).
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('a trip with NO window fields serves full data, unchanged (backward-compat regression)', async () => {
    // TRIP deliberately has no windowStart/windowEnd — the pre-N3 shape.
    vi.mocked(getTripByToken).mockResolvedValue(TRIP);

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = await response.json();
    // Full detail, no gating: the live/roster layer was consulted.
    expect(body.trip.name).toBe('North Shore Run');
    expect(body.vehicles).toHaveLength(2);
    expect(getLiveVehicles).toHaveBeenCalled();
  });

  it('an in-window trip returns the full detail unchanged', async () => {
    vi.mocked(getTripByToken).mockResolvedValue({
      ...TRIP,
      windowStart: new Date(Date.now() - DAY_MS).toISOString(),
      windowEnd: new Date(Date.now() + DAY_MS).toISOString(),
    });

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.trip.name).toBe('North Shore Run');
    expect(body.vehicles).toHaveLength(2);
    expect(getLiveVehicles).toHaveBeenCalled();
  });

  it('a not-yet-started trip returns the minimal status shape and leaks no vehicle/schedule data', async () => {
    vi.mocked(getTripByToken).mockResolvedValue({
      ...TRIP,
      windowStart: new Date(Date.now() + DAY_MS).toISOString(),
      windowEnd: new Date(Date.now() + 8 * DAY_MS).toISOString(),
    });

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'not_started',
      message: WINDOW_MESSAGES.not_started,
    });
    // Nothing about the trip beyond the status message — and the live
    // layer was never touched.
    expect(getLiveVehicles).not.toHaveBeenCalled();
  });

  it('an ended trip returns the minimal ended shape and leaks no data', async () => {
    vi.mocked(getTripByToken).mockResolvedValue({
      ...TRIP,
      windowStart: new Date(Date.now() - 8 * DAY_MS).toISOString(),
      windowEnd: new Date(Date.now() - DAY_MS).toISOString(),
    });

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ended',
      message: WINDOW_MESSAGES.ended,
    });
    expect(getLiveVehicles).not.toHaveBeenCalled();
  });

  it('returns 429 with Retry-After before any store access, on the trip-specific limiter', async () => {
    limitMock.mockResolvedValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 30_000,
    });

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(getTripByToken).not.toHaveBeenCalled();
    expect(slidingWindowCalls).toContainEqual([30, '60 s']);
    expect(limiterPrefixes).toContain('ratelimit:trip');
  });
});
