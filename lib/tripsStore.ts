import { getRedis } from './redisClient';
import type { Trip } from './trips';

// Redis-backed Trip storage (Phase I1: the Route store is gone — one
// entity, one store). Same patterns as trackingTokens.ts: lazy Redis client
// (a missing config fails loudly), each Trip at its own key, an id Set
// maintained at write time so listing never scans the keyspace, and a
// token reverse-index for the public link lookup. Fresh key prefixes — the
// old routes:* keys are abandoned pre-launch data, not migrated.

const TRIP_SET_KEY = 'trips:ids';

function tripKey(id: string): string {
  return `trips:trip:${id}`;
}

function tripTokenKey(token: string): string {
  return `trips:token:${token}`;
}

export async function createTrip(trip: Trip): Promise<void> {
  const client = getRedis();
  await client.set(tripKey(trip.id), trip);
  await client.sadd(TRIP_SET_KEY, trip.id);
  await client.set(tripTokenKey(trip.token), trip.id);
}

// Phase L1: update-in-place for an existing trip (cancel/replace edits).
// Overwrites ONLY the trip document — the id set and the token reverse
// index are keyed on values that never change after creation, so neither
// needs touching here.
export async function saveTrip(trip: Trip): Promise<void> {
  await getRedis().set(tripKey(trip.id), trip);
}

// Phase M1: full removal — the document, its id-set membership (so
// listTrips stops returning it), AND the token reverse index, which is
// only discoverable through the document itself, so it's read first. A
// missing id is a silent no-op: deleting something already gone is not an
// error.
export async function deleteTrip(id: string): Promise<void> {
  const client = getRedis();
  const trip = await client.get<Trip>(tripKey(id));
  if (trip === null) {
    return;
  }
  await client.del(tripKey(id));
  await client.srem(TRIP_SET_KEY, id);
  await client.del(tripTokenKey(trip.token));
}

export async function getTrip(id: string): Promise<Trip | null> {
  return await getRedis().get<Trip>(tripKey(id));
}

export async function getTripByToken(token: string): Promise<Trip | null> {
  const tripId = await getRedis().get<string>(tripTokenKey(token));
  return tripId === null ? null : await getTrip(tripId);
}

export async function listTrips(): Promise<Trip[]> {
  const client = getRedis();
  const ids = await client.smembers(TRIP_SET_KEY);
  const entries = await Promise.all(
    ids.map((id) => client.get<Trip>(tripKey(id))),
  );
  return entries.filter((entry) => entry !== null);
}
