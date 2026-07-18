import type { Vehicle } from './liveVehicles';
import { getStatusLabel } from './vehicleStatus';

export interface VehicleGroups {
  enRoute: Vehicle[];
  stopped: Vehicle[];
  offline: Vehicle[];
}

// Buckets are driven by getStatusLabel so the sidebar sections can never
// disagree with the per-row status text. Input order is preserved within
// each bucket — no re-sorting.
export function groupVehiclesByStatus(vehicles: Vehicle[]): VehicleGroups {
  const groups: VehicleGroups = { enRoute: [], stopped: [], offline: [] };
  for (const vehicle of vehicles) {
    const label = getStatusLabel(vehicle.speed, vehicle.lastUpdatedAt);
    if (label === 'En route') {
      groups.enRoute.push(vehicle);
    } else if (label === 'Stopped') {
      groups.stopped.push(vehicle);
    } else {
      groups.offline.push(vehicle);
    }
  }
  return groups;
}
