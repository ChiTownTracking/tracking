import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vehicles from '@/__fixtures__/vehicles.json';
import vehiclesLive from '@/__fixtures__/vehiclesLive.json';
import { quartixClient } from '../lib/quartixClient';
import { getLiveVehicles } from '../lib/liveVehicles';

// Only quartixClient is mocked — getVehicleRoster runs for real against the
// mocked client, so this also exercises the real roster mapping.
vi.mock('../lib/quartixClient', () => ({
  quartixClient: { get: vi.fn() },
}));

const getMock = vi.mocked(quartixClient.get);

function mockQuartixResponses(live: unknown) {
  getMock.mockImplementation(async (path: string) => {
    if (path === '/vehicles/live') return live;
    if (path === '/vehicles') return vehicles;
    throw new Error(`unexpected path: ${path}`);
  });
}

describe('getLiveVehicles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('QUARTIX_VEHICLE_IDS', '1000067169,1000074171');
    mockQuartixResponses(vehiclesLive);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // This is the test that would have failed loudly under the old
  // VehicleID / LastEventDatetime assumption.
  it('merges live positions with the roster into normalized Vehicles', async () => {
    const result = await getLiveVehicles(['1000067169', '1000074171']);

    expect(result).toHaveLength(2);

    const byId = new Map(result.map((v) => [v.vehicleId, v]));
    expect([...byId.keys()].sort()).toEqual(['1000067169', '1000074171']);

    expect(byId.get('1000067169')?.registrationNumber).toBe('2401');
    expect(byId.get('1000074171')?.registrationNumber).toBe('2402');

    for (const vehicle of result) {
      expect(typeof vehicle.vehicleId).toBe('string');
      expect(typeof vehicle.lastUpdatedAt).toBe('string');
      expect(vehicle.lastUpdatedAt.length).toBeGreaterThan(0);
    }

    expect(getMock).toHaveBeenCalledWith('/vehicles/live', {
      VehicleIDList: '1000067169,1000074171',
    });
  });

  it('serves a repeat request for the same ID list from the 30-second cache', async () => {
    // The previous test cached this exact key; clearAllMocks reset the call
    // count, so any fetch here would be a cache miss.
    const result = await getLiveVehicles(['1000067169', '1000074171']);

    expect(getMock).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
  });

  it('includes (with a warning) live vehicles that have no roster match instead of dropping them', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockQuartixResponses([{ ...vehiclesLive[0], VehicleId: 9999 }]);

    const result = await getLiveVehicles(['9999']);

    expect(result).toHaveLength(1);
    expect(result[0].vehicleId).toBe('9999');
    expect(result[0].registrationNumber).toBe('');
    expect(result[0].description).toBe('');
    expect(result[0].iconUrl).toBe('');
    expect(result[0].lastUpdatedAt).toBe(vehiclesLive[0].LastEventDateTime);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});
