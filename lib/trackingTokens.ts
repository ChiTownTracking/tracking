import { getRedis } from './redisClient';

export interface Waypoint {
  label: string;
  lat: number;
  lng: number;
}

// Route geometry computed once at link creation (ORS driving directions
// through the waypoints, in order). Same shape orsClient's getRoute()
// returns: [lat, lng] pairs, meters, seconds.
export interface StoredRoute {
  geometry: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
}

// One named route on a link: its own vehicles and time window, an ordered
// stop sequence, its computed geometry, and the wall-clock departure times
// ("HH:mm", 24-hour, America/Chicago) it runs at each day. Names are
// labels, not keys — duplicates are allowed.
export interface NamedRoute {
  name: string;
  vehicleIds: string[];
  windowStart: string;
  windowEnd: string;
  waypoints: Waypoint[];
  route: StoredRoute;
  schedule: string[];
}

export interface TrackingLink {
  // IMPORTANT: the top-level vehicleIds/windowStart/windowEnd govern ONLY
  // links with no routes (the original simple case). The moment `routes`
  // exists, each route's own vehicleIds/window governs independently and
  // these top-level fields are IGNORED by readers — creation stores derived
  // aggregates in them (union of route vehicles, min/max of route windows)
  // purely so the shape stays uniform, not as a source of truth.
  vehicleIds: string[];
  customerName: string;
  windowStart: string;
  windowEnd: string;
  // Optional named routes (1+ when present, each with 2+ waypoints —
  // enforced by createLinkInputSchema). Replaced the flat waypoints/route
  // fields; links stored before the change may still carry those legacy
  // fields in Redis, which readers simply ignore.
  routes?: NamedRoute[];
}

// Tokens are crypto.randomUUID() values (see create-link). Anything not
// UUID-shaped can be rejected before ever touching Redis — callers must
// respond exactly as they would for a valid-shaped-but-unknown token, so a
// malformed guess is indistinguishable from a wrong one.
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidShaped(token: string): boolean {
  return UUID_SHAPE.test(token);
}

// Each link lives at its own key; a Set of all tokens is maintained alongside
// so listing never needs a keyspace scan.
const TOKEN_SET_KEY = 'tracking:tokens';

function linkKey(token: string): string {
  return `tracking:link:${token}`;
}

export async function createTrackingLink(
  token: string,
  link: TrackingLink,
): Promise<void> {
  const client = getRedis();
  await client.set(linkKey(token), link);
  await client.sadd(TOKEN_SET_KEY, token);
}

export async function getTrackingLink(
  token: string,
): Promise<TrackingLink | null> {
  return await getRedis().get<TrackingLink>(linkKey(token));
}

export async function listTrackingLinks(): Promise<
  Array<{ token: string } & TrackingLink>
> {
  const client = getRedis();
  const tokens = await client.smembers(TOKEN_SET_KEY);
  const entries = await Promise.all(
    tokens.map(async (token) => {
      const link = await client.get<TrackingLink>(linkKey(token));
      return link ? { token, ...link } : null;
    }),
  );
  return entries.filter((entry) => entry !== null);
}

export async function deleteTrackingLink(token: string): Promise<void> {
  const client = getRedis();
  await client.del(linkKey(token));
  await client.srem(TOKEN_SET_KEY, token);
}
