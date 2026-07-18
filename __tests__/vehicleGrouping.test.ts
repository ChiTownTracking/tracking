import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Vehicle } from '@/lib/liveVehicles';
import { groupVehiclesByStatus } from '@/lib/vehicleGrouping';

const NOW = new Date('2026-06-11T18:00:00Z');

function makeVehicle(
  vehicleId: string,
  speed: number,
  lastUpdatedSecondsAgo: number,
): Vehicle {
  return {
    vehicleId,
    registrationNumber: `REG-${vehicleId}`,
    description: `Vehicle ${vehicleId}`,
    iconUrl: '',
    latitude: 42.02,
    longitude: -87.96,
    heading: 0,
    speed,
    locationText: '',
    lastUpdatedAt: new Date(
      NOW.getTime() - lastUpdatedSecondsAgo * 1000,
    ).toISOString(),
  };
}

// moving (fresh, speed > 2), stopped (fresh, speed <= 2), offline (>24h old
// regardless of speed — stale speed must not count as "en route").
const fleet = [
  makeVehicle('a', 28, 30),
  makeVehicle('b', 0, 60),
  makeVehicle('c', 45, 25 * 3600),
  makeVehicle('d', 15, 90),
  makeVehicle('e', 2, 10),
];

describe('groupVehiclesByStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('puts each vehicle in the correct bucket', () => {
    const groups = groupVehiclesByStatus(fleet);

    expect(groups.enRoute.map((v) => v.vehicleId)).toEqual(['a', 'd']);
    expect(groups.stopped.map((v) => v.vehicleId)).toEqual(['b', 'e']);
    expect(groups.offline.map((v) => v.vehicleId)).toEqual(['c']);
  });

  it('places every vehicle in exactly one bucket', () => {
    const groups = groupVehiclesByStatus(fleet);
    const allIds = [
      ...groups.enRoute,
      ...groups.stopped,
      ...groups.offline,
    ].map((v) => v.vehicleId);

    expect(allIds).toHaveLength(fleet.length);
    expect(new Set(allIds).size).toBe(fleet.length);
  });

  it('preserves input order within each bucket', () => {
    // Reverse the fleet: bucket contents must follow the new input order.
    const groups = groupVehiclesByStatus([...fleet].reverse());

    expect(groups.enRoute.map((v) => v.vehicleId)).toEqual(['d', 'a']);
    expect(groups.stopped.map((v) => v.vehicleId)).toEqual(['e', 'b']);
  });
});
