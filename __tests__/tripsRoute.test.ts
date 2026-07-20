import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trip } from '@/lib/trips';
import type { RosterVehicle } from '@/lib/vehicleRoster';

// Phase J3: the route now calls googleMapsClient — same field names, but
// legs carry their own geometry and there is no legBoundaryIndices (the
// route derives it from the leg geometries instead).
vi.mock('@/lib/googleMapsClient', () => ({
  googleMapsClient: {
    geocode: vi.fn(),
    getRoute: vi.fn(),
    predictArrival: vi.fn(),
  },
}));

vi.mock('@/lib/tripsStore', () => ({
  createTrip: vi.fn(),
  listTrips: vi.fn(),
}));

vi.mock('@/lib/vehicleRoster', () => ({ getVehicleRoster: vi.fn() }));

import { GET, POST } from '@/app/api/internal/trips/route';
import { googleMapsClient } from '@/lib/googleMapsClient';
import { createTrip, listTrips } from '@/lib/tripsStore';
import { getVehicleRoster } from '@/lib/vehicleRoster';

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

const WAYPOINTS = [
  { label: 'Chicago Union Station', lat: 41.878988, lng: -87.639732 },
  { label: 'Wrigley Field', lat: 41.948437, lng: -87.655334 },
];

// Google-shaped getRoute result: the single leg carries its OWN geometry
// (here identical to the whole-route geometry, as it is for any 1-leg
// route), and there is no legBoundaryIndices — the route derives [0, 1]
// from the leg geometry length.
const ROUTE_RESULT = {
  geometry: [
    [41.878988, -87.639704],
    [41.949033, -87.655348],
  ] as [number, number][],
  distanceMeters: 9489.6,
  durationSeconds: 917.9,
  legs: [
    {
      distanceMeters: 9489.6,
      durationSeconds: 917.9,
      geometry: [
        [41.878988, -87.639704],
        [41.949033, -87.655348],
      ] as [number, number][],
    },
  ],
};

// What Trip actually stores for legs: timings only, leg geometry stripped.
const STORED_LEGS = [{ distanceMeters: 9489.6, durationSeconds: 917.9 }];

// Phase N3: creation now requires an active window (windowEnd > windowStart).
const WINDOW = {
  windowStart: '2026-07-20T14:00:00.000Z',
  windowEnd: '2026-07-27T14:00:00.000Z',
};

const VALID_BODY = {
  name: 'North Shore Run',
  ...WINDOW,
  waypoints: WAYPOINTS,
  vehicles: [
    {
      vehicleId: '1000067169',
      schedule: [{ arrivalTime: '07:00', waitMinutes: 10 }],
    },
  ],
};

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/internal/trips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('POST /api/internal/trips', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getVehicleRoster).mockResolvedValue(ROSTER);
    vi.mocked(googleMapsClient.getRoute).mockResolvedValue(ROUTE_RESULT);
    // Real values from __fixtures__/googleRoutePredicted.json.
    vi.mocked(googleMapsClient.predictArrival).mockResolvedValue({
      predictedDurationSeconds: 1061,
      staticDurationSeconds: 1332,
    });
  });

  it('creates one Trip with a fresh token, minted run ids, and a working /trip path', async () => {
    const response = await POST(makeRequest(VALID_BODY));

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(createTrip).toHaveBeenCalledTimes(1);
    const stored = vi.mocked(createTrip).mock.calls[0][0];
    expect(stored.name).toBe('North Shore Run');
    // Phase N3: the validated window is stored on the trip.
    expect(stored.windowStart).toBe(WINDOW.windowStart);
    expect(stored.windowEnd).toBe(WINDOW.windowEnd);
    expect(stored.waypoints).toEqual(WAYPOINTS);
    expect(stored.geometry).toEqual(ROUTE_RESULT.geometry);
    // Leg geometry is stripped before storing; boundary indices are derived
    // from the leg geometry lengths, not read from the client.
    expect(stored.legs).toEqual(STORED_LEGS);
    expect(stored.legBoundaryIndices).toEqual([0, 1]);
    expect(stored.totalDistanceMeters).toBe(9489.6);
    expect(stored.totalDurationSeconds).toBe(917.9);
    expect(stored.token).toMatch(UUID_SHAPE);
    expect(stored.vehicles).toHaveLength(1);
    expect(stored.vehicles[0].vehicleId).toBe('1000067169');
    // Every run gets its own server-minted id alongside the input fields.
    expect(stored.vehicles[0].schedule[0]).toMatchObject({
      arrivalTime: '07:00',
      waitMinutes: 10,
    });
    expect(stored.vehicles[0].schedule[0].id).toMatch(UUID_SHAPE);

    expect(body).toEqual({
      id: stored.id,
      token: stored.token,
      tripPath: `/trip/${stored.token}`,
    });
  });

  it('stores 2 vehicles with multiple runs each, all in one request', async () => {
    const response = await POST(
      makeRequest({
        name: 'Two-Trolley Loop',
        ...WINDOW,
        waypoints: WAYPOINTS,
        vehicles: [
          {
            vehicleId: '1000067169',
            schedule: [
              { arrivalTime: '07:00', waitMinutes: 10 },
              { arrivalTime: '11:30', waitMinutes: 5 },
            ],
          },
          {
            vehicleId: '1000074171',
            schedule: [
              { arrivalTime: '09:15', waitMinutes: 0 },
              { arrivalTime: '13:45', waitMinutes: 15 },
              { arrivalTime: '17:00', waitMinutes: 0 },
            ],
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    const stored = vi.mocked(createTrip).mock.calls[0][0] as Trip;
    expect(stored.vehicles.map((v) => v.vehicleId)).toEqual([
      '1000067169',
      '1000074171',
    ]);
    expect(stored.vehicles[0].schedule.map((e) => e.arrivalTime)).toEqual([
      '07:00',
      '11:30',
    ]);
    expect(stored.vehicles[1].schedule.map((e) => e.arrivalTime)).toEqual([
      '09:15',
      '13:45',
      '17:00',
    ]);
    expect(stored.vehicles[1].schedule.map((e) => e.waitMinutes)).toEqual([
      0, 15, 0,
    ]);
    // All five run ids minted, all distinct.
    const runIds = stored.vehicles.flatMap((v) =>
      v.schedule.map((e) => e.id),
    );
    runIds.forEach((id) => expect(id).toMatch(UUID_SHAPE));
    expect(new Set(runIds).size).toBe(5);
    // One trip, one routing call — the path is shared by every vehicle.
    expect(googleMapsClient.getRoute).toHaveBeenCalledTimes(1);
  });

  it('a bad vehicleId in ANY position blocks creation, before any ORS call, naming every offender', async () => {
    const response = await POST(
      makeRequest({
        ...VALID_BODY,
        vehicles: [
          {
            vehicleId: '1000067169',
            schedule: [{ arrivalTime: '07:00', waitMinutes: 0 }],
          },
          {
            vehicleId: '9999999999',
            schedule: [{ arrivalTime: '08:00', waitMinutes: 0 }],
          },
          {
            vehicleId: '8888888888',
            schedule: [{ arrivalTime: '09:00', waitMinutes: 0 }],
          },
        ],
      }),
    );

    expect(response.status).toBe(400);
    const { error } = await response.json();
    // Accumulated, each named — not first-failure-only.
    expect(error).toContain('Vehicle 9999999999 does not exist.');
    expect(error).toContain('Vehicle 8888888888 does not exist.');
    expect(googleMapsClient.getRoute).not.toHaveBeenCalled();
    expect(createTrip).not.toHaveBeenCalled();
  });

  it('schema failures block everything before roster and ORS', async () => {
    const cases = [
      { ...VALID_BODY, name: '   ' },
      { ...VALID_BODY, waypoints: [WAYPOINTS[0]] },
      { ...VALID_BODY, vehicles: [] },
      {
        ...VALID_BODY,
        vehicles: [{ vehicleId: '1000067169', schedule: [] }],
      },
      {
        ...VALID_BODY,
        vehicles: [
          {
            vehicleId: '1000067169',
            schedule: [{ arrivalTime: '7am', waitMinutes: 0 }],
          },
        ],
      },
      {
        ...VALID_BODY,
        vehicles: [
          {
            vehicleId: '1000067169',
            schedule: [{ arrivalTime: '07:00', waitMinutes: -1 }],
          },
        ],
      },
      // Phase N3 window rules: missing, and end-not-after-start.
      (() => {
        const { windowStart: _s, ...noStart } = VALID_BODY;
        return noStart;
      })(),
      { ...VALID_BODY, windowEnd: VALID_BODY.windowStart },
    ];

    for (const body of cases) {
      const response = await POST(makeRequest(body));
      expect(response.status).toBe(400);
    }
    expect(getVehicleRoster).not.toHaveBeenCalled();
    expect(googleMapsClient.getRoute).not.toHaveBeenCalled();
    expect(createTrip).not.toHaveBeenCalled();
  });

  // Phase K1: one predictArrival call per DISTINCT departure clock time —
  // the core dedup regression. Two vehicles, both arriving 07:00 with a
  // 10-minute wait, share the 07:10 departure, so ONE Google call feeds
  // both stored entries.
  it('two vehicles sharing a departure time trigger exactly one prediction, stored on both', async () => {
    const response = await POST(
      makeRequest({
        name: 'Shared Departure Run',
        ...WINDOW,
        waypoints: WAYPOINTS,
        vehicles: [
          {
            vehicleId: '1000067169',
            schedule: [{ arrivalTime: '07:00', waitMinutes: 10 }],
          },
          {
            vehicleId: '1000074171',
            schedule: [{ arrivalTime: '07:00', waitMinutes: 10 }],
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(googleMapsClient.predictArrival).toHaveBeenCalledTimes(1);
    // Predicts first waypoint → last waypoint direct, at a real future
    // Date for the 07:10 departure.
    expect(googleMapsClient.predictArrival).toHaveBeenCalledWith(
      { lat: WAYPOINTS[0].lat, lng: WAYPOINTS[0].lng },
      { lat: WAYPOINTS[1].lat, lng: WAYPOINTS[1].lng },
      expect.any(Date),
    );

    const stored = vi.mocked(createTrip).mock.calls[0][0] as Trip;
    // BOTH raw Google numbers land on both entries, exactly as returned —
    // no buffer baked into stored data (that's display-time only).
    for (const vehicleIndex of [0, 1]) {
      expect(
        stored.vehicles[vehicleIndex].schedule[0]
          .predictedArrivalDurationSeconds,
      ).toBe(1061);
      expect(
        stored.vehicles[vehicleIndex].schedule[0]
          .predictedArrivalStaticDurationSeconds,
      ).toBe(1332);
    }
    // The static map data is untouched by prediction — still sourced from
    // the original getRoute call.
    expect(stored.geometry).toEqual(ROUTE_RESULT.geometry);
    expect(stored.legs).toEqual(STORED_LEGS);
  });

  it('distinct departure times each get their own prediction call', async () => {
    const response = await POST(
      makeRequest({
        ...VALID_BODY,
        vehicles: [
          {
            vehicleId: '1000067169',
            // Same arrival, different waits → two DISTINCT departures
            // (07:10 and 07:30) → two calls.
            schedule: [
              { arrivalTime: '07:00', waitMinutes: 10 },
              { arrivalTime: '07:00', waitMinutes: 30 },
            ],
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(googleMapsClient.predictArrival).toHaveBeenCalledTimes(2);
  });

  it('a prediction failure never blocks creation and leaves the field absent', async () => {
    vi.mocked(googleMapsClient.predictArrival).mockRejectedValue(
      new Error('Google request failed (429): quota exceeded'),
    );

    const response = await POST(makeRequest(VALID_BODY));

    expect(response.status).toBe(200);
    const stored = vi.mocked(createTrip).mock.calls[0][0] as Trip;
    // Both absent — not zero, not null (the ScheduleEntry contract).
    expect(
      'predictedArrivalDurationSeconds' in stored.vehicles[0].schedule[0],
    ).toBe(false);
    expect(
      'predictedArrivalStaticDurationSeconds' in
        stored.vehicles[0].schedule[0],
    ).toBe(false);
    // The static route/map data is completely unaffected by the failure.
    expect(stored.geometry).toEqual(ROUTE_RESULT.geometry);
    expect(stored.legs).toEqual(STORED_LEGS);
    expect(stored.legBoundaryIndices).toEqual([0, 1]);
    expect(stored.totalDurationSeconds).toBe(917.9);
  });

  // Phase J3: EVERY routing failure is the generic 502 for now — ORS's
  // confirmed unroutable-point shape produced an actionable 400 here, but no
  // Google equivalent has been captured yet (see the TODO in the route).
  // When one is, this is the test to split back into 400-vs-502 cases.
  it('any routing failure returns the generic 502 with nothing created', async () => {
    vi.mocked(googleMapsClient.getRoute).mockRejectedValue(
      new Error('Google request failed (503): upstream flake'),
    );

    const response = await POST(makeRequest(VALID_BODY));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Unable to create trip' });
    expect(createTrip).not.toHaveBeenCalled();
  });
});

describe('GET /api/internal/trips', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getVehicleRoster).mockResolvedValue(ROSTER);
  });

  it('returns the light list shape — vehicles with registration and run counts, newest first', async () => {
    const baseTrip: Omit<Trip, 'id' | 'createdAt'> = {
      token: 'trip-token',
      name: 'North Shore Run',
      waypoints: WAYPOINTS,
      geometry: ROUTE_RESULT.geometry,
      legs: STORED_LEGS,
      legBoundaryIndices: [0, 1],
      totalDistanceMeters: 9489.6,
      totalDurationSeconds: 917.9,
      vehicles: [
        {
          vehicleId: '1000067169',
          schedule: [
            { id: 'run-1', arrivalTime: '07:00', waitMinutes: 10 },
            { id: 'run-2', arrivalTime: '14:30', waitMinutes: 5 },
          ],
        },
      ],
    };
    vi.mocked(listTrips).mockResolvedValue([
      { ...baseTrip, id: 'trip-old', createdAt: '2026-07-16T10:00:00.000Z' },
      {
        ...baseTrip,
        id: 'trip-new',
        name: 'South Shore Run',
        createdAt: '2026-07-17T10:00:00.000Z',
      },
    ]);

    const body = await (await GET()).json();

    expect(body).toEqual([
      {
        id: 'trip-new',
        name: 'South Shore Run',
        stopCount: 2,
        totalDistanceMeters: 9489.6,
        totalDurationSeconds: 917.9,
        vehicles: [
          {
            vehicleId: '1000067169',
            vehicleRegistration: 'TRLY-7169',
            runCount: 2,
          },
        ],
        token: 'trip-token',
        createdAt: '2026-07-17T10:00:00.000Z',
      },
      {
        id: 'trip-old',
        name: 'North Shore Run',
        stopCount: 2,
        totalDistanceMeters: 9489.6,
        totalDurationSeconds: 917.9,
        vehicles: [
          {
            vehicleId: '1000067169',
            vehicleRegistration: 'TRLY-7169',
            runCount: 2,
          },
        ],
        token: 'trip-token',
        createdAt: '2026-07-16T10:00:00.000Z',
      },
    ]);
  });

  it('names an unknown vehicle instead of failing the whole list', async () => {
    vi.mocked(listTrips).mockResolvedValue([
      {
        id: 'trip-1',
        token: 'trip-token',
        name: 'Ghost Vehicle Run',
        waypoints: WAYPOINTS,
        geometry: ROUTE_RESULT.geometry,
        legs: STORED_LEGS,
        legBoundaryIndices: [0, 1],
        totalDistanceMeters: 9489.6,
        totalDurationSeconds: 917.9,
        vehicles: [
          {
            vehicleId: '5555555555',
            schedule: [{ id: 'run-1', arrivalTime: '07:00', waitMinutes: 0 }],
          },
        ],
        createdAt: '2026-07-17T10:00:00.000Z',
      },
    ]);

    const body = await (await GET()).json();

    expect(body[0].vehicles[0].vehicleRegistration).toBe(
      '(unknown 5555555555)',
    );
  });
});
