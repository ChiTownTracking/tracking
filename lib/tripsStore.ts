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
