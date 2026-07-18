import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trip } from '@/lib/trips';
import {
  createTrip,
  getTrip,
  getTripByToken,
  listTrips,
} from '@/lib/tripsStore';

// Same in-memory Upstash stand-in as trackingTokens.test.ts: object values
// are stored as JSON strings and parsed back on read — the serialization the
// real @upstash/redis client applies — so these tests exercise a genuine
// serialize/deserialize round-trip rather than handing back the original
// object reference.
vi.mock('@upstash/redis', () => {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  class FakeRedis {
    static fromEnv() {
      return new FakeRedis();
    }
    async set(key: string, value: unknown) {
      store.set(key, JSON.stringify(value));
    }
    async get(key: string) {
      const raw = store.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    }
    async del(key: string) {
      store.delete(key);
    }
    async sadd(key: string, member: string) {
      if (!sets.has(key)) {
        sets.set(key, new Set());
      }
      sets.get(key)!.add(member);
    }
    async srem(key: string, member: string) {
      sets.get(key)?.delete(member);
    }
    async smembers(key: string) {
      return [...(sets.get(key) ?? [])];
    }
  }

  return {
    Redis: FakeRedis,
    __reset: () => {
      store.clear();
      sets.clear();
    },
  };
});

function makeTrip(id: string, overrides: Partial<Trip> = {}): Trip {
  return {
    id,
    token: `${id}-token`,
    name: 'North Shore Run',
    waypoints: [
      { label: 'Chicago Union Station', lat: 41.878988, lng: -87.639732 },
      { label: 'Wrigley Field', lat: 41.948437, lng: -87.655334 },
    ],
    geometry: [
      [41.878988, -87.639704],
      [41.949033, -87.655348],
    ],
    legs: [{ distanceMeters: 9489.6, durationSeconds: 917.9 }],
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
      {
        vehicleId: '1000074171',
        schedule: [{ id: 'run-3', arrivalTime: '09:15', waitMinutes: 0 }],
      },
    ],
    createdAt: '2026-07-17T15:00:00.000Z',
    ...overrides,
  };
}

describe('tripsStore', () => {
  beforeEach(async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://fake.upstash.test');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'fake-token');
    const mocked = (await import('@upstash/redis')) as unknown as {
      __reset: () => void;
    };
    mocked.__reset();
  });

  it('round-trips a Trip through create → get, vehicle assignments and runs intact', async () => {
    const trip = makeTrip('trip-1');
    await createTrip(trip);

    const fetched = await getTrip('trip-1');
    expect(fetched).toEqual(trip);
    // Belt-and-braces on the nested, ordered parts.
    expect(fetched?.vehicles.map((v) => v.vehicleId)).toEqual([
      '1000067169',
      '1000074171',
    ]);
    expect(fetched?.vehicles[0].schedule.map((e) => e.arrivalTime)).toEqual([
      '07:00',
      '14:30',
    ]);
  });

  it('returns null for an unknown trip id', async () => {
    expect(await getTrip('nope')).toBeNull();
  });

  it('a trip is retrievable by its token immediately after creation', async () => {
    const trip = makeTrip('trip-1', {
      token: 'a1b2c3d4-1111-4222-8333-abcdefabcdef',
    });
    await createTrip(trip);

    expect(
      await getTripByToken('a1b2c3d4-1111-4222-8333-abcdefabcdef'),
    ).toEqual(trip);
  });

  it('an unknown token returns null, not a throw', async () => {
    await createTrip(makeTrip('trip-1'));

    expect(await getTripByToken('no-such-token')).toBeNull();
  });

  it('lists all stored trips', async () => {
    await createTrip(makeTrip('trip-1'));
    await createTrip(makeTrip('trip-2', { name: 'South Shore Run' }));

    const listed = await listTrips();
    expect(listed.map((t) => t.id).sort()).toEqual(['trip-1', 'trip-2']);
  });
});
