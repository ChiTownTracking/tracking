import { quartixClient } from './quartixClient';
import { getTrackedVehicleIds } from './appEnv';

export interface RosterVehicle {
  vehicleId: string;
  registrationNumber: string;
  description: string;
  iconUrl: string;
}

// Real /vehicles response shape — "VehicleId" casing confirmed against the
// live API (see __fixtures__/vehicles.json and fixtures.test.ts).
interface QuartixVehicle {
  VehicleId: number;
  RegistrationNumber: string;
  Description: string;
  VehicleIcon: string;
}

// The roster changes rarely; an hour of staleness is fine.
const ROSTER_TTL_MS = 60 * 60 * 1000;

let cache: { data: RosterVehicle[]; expiresAt: number } | null = null;

export async function getVehicleRoster(): Promise<RosterVehicle[]> {
  if (cache && Date.now() < cache.expiresAt) {
    return cache.data;
  }

  const tracked = new Set(getTrackedVehicleIds());
  const vehicles = (await quartixClient.get('/vehicles')) as QuartixVehicle[];

  const roster = vehicles
    .map((vehicle) => ({
      vehicleId: String(vehicle.VehicleId),
      registrationNumber: vehicle.RegistrationNumber,
      description: vehicle.Description,
      iconUrl: vehicle.VehicleIcon,
    }))
    .filter((vehicle) => tracked.has(vehicle.vehicleId));

  cache = { data: roster, expiresAt: Date.now() + ROSTER_TTL_MS };
  return roster;
}
