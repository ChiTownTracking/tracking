import { quartixClient } from './quartixClient';
import { getVehicleRoster } from './vehicleRoster';

export interface Vehicle {
  vehicleId: string;
  registrationNumber: string;
  description: string;
  iconUrl: string;
  latitude: number;
  longitude: number;
  heading: number;
  speed: number;
  locationText: string;
  // Deliberately NOT named after Quartix's field: the real API uses both
  // "LastEventDateTime" (on /vehicles/live) and "LastAnalogueEventDateTime"
  // spellings for similar concepts. "lastUpdatedAt" is our normalized internal
  // name so it can never be confused with either.
  lastUpdatedAt: string;
}

// Real /vehicles/live response shape — "VehicleId" and "LastEventDateTime"
// casings confirmed against the live API (see __fixtures__/vehiclesLive.json
// and fixtures.test.ts).
interface QuartixLiveVehicle {
  VehicleId: number;
  LocationText: string;
  Latitude: number;
  Longitude: number;
  Heading: number;
  Speed: number;
  LastEventDateTime: string;
}

const LIVE_TTL_MS = 30 * 1000;

const cache = new Map<string, { data: Vehicle[]; expiresAt: number }>();

export async function getLiveVehicles(vehicleIds: string[]): Promise<Vehicle[]> {
  const cacheKey = [...vehicleIds].sort().join(',');
  const hit = cache.get(cacheKey);
  if (hit && Date.now() < hit.expiresAt) {
    return hit.data;
  }

  const [roster, live] = await Promise.all([
    getVehicleRoster(),
    quartixClient.get('/vehicles/live', {
      VehicleIDList: vehicleIds.join(','),
    }) as Promise<QuartixLiveVehicle[]>,
  ]);

  const rosterById = new Map(roster.map((entry) => [entry.vehicleId, entry]));

  const vehicles = live.map((entry) => {
    const vehicleId = String(entry.VehicleId);
    const rosterEntry = rosterById.get(vehicleId);
    if (!rosterEntry) {
      // Include it anyway rather than dropping it silently, but flag it: this
      // usually means QUARTIX_VEHICLE_IDS and the requested ID list drifted.
      console.warn(
        `getLiveVehicles: live vehicle ${vehicleId} has no roster match — ` +
          'QUARTIX_VEHICLE_IDS and the requested vehicle list may be out of sync',
      );
    }
    return {
      vehicleId,
      registrationNumber: rosterEntry?.registrationNumber ?? '',
      description: rosterEntry?.description ?? '',
      iconUrl: rosterEntry?.iconUrl ?? '',
      latitude: entry.Latitude,
      longitude: entry.Longitude,
      heading: entry.Heading,
      speed: entry.Speed,
      locationText: entry.LocationText,
      lastUpdatedAt: entry.LastEventDateTime,
    };
  });

  cache.set(cacheKey, { data: vehicles, expiresAt: Date.now() + LIVE_TTL_MS });
  return vehicles;
}
