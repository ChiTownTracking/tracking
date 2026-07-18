import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTrackingLink,
  deleteTrackingLink,
  getTrackingLink,
  listTrackingLinks,
  type TrackingLink,
} from '@/lib/trackingTokens';

// In-memory stand-in for Upstash Redis mirroring the subset of behavior the
// module relies on. Object values are stored as JSON strings and parsed back
// on read — the same serialization the real @upstash/redis client applies —
// so these tests exercise a genuine serialize/deserialize round-trip rather
// than handing back the original object reference.
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

function makeLink(customerName: string): TrackingLink {
  return {
    vehicleIds: ['1000067169', '1000074171'],
    customerName,
    windowStart: '2026-07-20T14:00:00.000Z',
    windowEnd: '2026-07-20T18:00:00.000Z',
  };
}

describe('trackingTokens', () => {
  beforeEach(async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://fake.upstash.test');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'fake-token');
    const mocked = (await import('@upstash/redis')) as unknown as {
      __reset: () => void;
    };
    mocked.__reset();
  });

  it('round-trips a link through create → get', async () => {
    const link = makeLink('Smith Wedding');
    await createTrackingLink('token-a', link);

    expect(await getTrackingLink('token-a')).toEqual(link);
  });

  it('returns null for an unknown token', async () => {
    expect(await getTrackingLink('nope')).toBeNull();
  });

  it('round-trips waypoints through serialization — same order, same values, nothing dropped', async () => {
    const link: TrackingLink = {
      ...makeLink('Kenosha Shuttle'),
      waypoints: [
        { label: 'Kenosha Metra Station', lat: 42.5886, lng: -87.8214 },
        { label: 'Chicago Union Station', lat: 41.878988, lng: -87.639732 },
        { label: 'Milwaukee Intermodal', lat: 43.0344, lng: -87.9164 },
      ],
    };
    await createTrackingLink('token-waypoints', link);

    const fetched = await getTrackingLink('token-waypoints');
    expect(fetched).toEqual(link);
    // Belt-and-braces on the part that matters: an ordered sequence.
    expect(fetched?.waypoints?.map((w) => w.label)).toEqual([
      'Kenosha Metra Station',
      'Chicago Union Station',
      'Milwaukee Intermodal',
    ]);
  });

  it('a link stored without waypoints comes back without them', async () => {
    await createTrackingLink('token-plain', makeLink('Smith Wedding'));

    const fetched = await getTrackingLink('token-plain');
    expect(fetched?.waypoints).toBeUndefined();
  });

  it('lists entries with their tokens attached', async () => {
    await createTrackingLink('token-a', makeLink('Smith Wedding'));
    await createTrackingLink('token-b', makeLink('Corporate Shuttle'));

    const listed = await listTrackingLinks();
    expect(listed).toHaveLength(2);
    expect(listed.map((e) => e.token).sort()).toEqual(['token-a', 'token-b']);
    const entryA = listed.find((e) => e.token === 'token-a');
    expect(entryA?.customerName).toBe('Smith Wedding');
  });

  it('delete removes the link from subsequent get and list calls', async () => {
    await createTrackingLink('token-a', makeLink('Smith Wedding'));
    await createTrackingLink('token-b', makeLink('Corporate Shuttle'));

    await deleteTrackingLink('token-a');

    expect(await getTrackingLink('token-a')).toBeNull();
    const listed = await listTrackingLinks();
    expect(listed.map((e) => e.token)).toEqual(['token-b']);
  });
});
