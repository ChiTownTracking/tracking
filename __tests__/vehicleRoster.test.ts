import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vehicles from '@/__fixtures__/vehicles.json';
import { quartixClient } from '../lib/quartixClient';
import { getVehicleRoster } from '../lib/vehicleRoster';

vi.mock('../lib/quartixClient', () => ({
  quartixClient: { get: vi.fn() },
}));

const getMock = vi.mocked(quartixClient.get);

describe('getVehicleRoster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Space after the comma on purpose — IDs must be trimmed.
    vi.stubEnv('QUARTIX_VEHICLE_IDS', '1000067169, 1000074171');
    getMock.mockResolvedValue(vehicles);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns only tracked vehicles, normalized to the RosterVehicle shape', async () => {
    const roster = await getVehicleRoster();

    // toEqual with exact objects also pins the property name: vehicleId, not
    // vehicleID or VehicleId.
    expect(roster).toEqual([
      {
        vehicleId: '1000067169',
        registrationNumber: '2401',
        description: 'FORD 2401',
        iconUrl:
          'https://productmedia.quartix.com/images/assets/png-v2-small/passengervan-orange.png',
      },
      {
        vehicleId: '1000074171',
        registrationNumber: '2402',
        description: 'FORD 2402',
        iconUrl:
          'https://productmedia.quartix.com/images/assets/png-v2-small/largevan-red.png',
      },
    ]);
    expect(getMock).toHaveBeenCalledWith('/vehicles');
  });

  it('serves subsequent calls from the 1-hour cache without refetching', async () => {
    // The previous test populated the module-level cache; clearAllMocks reset
    // the call count, so any fetch here would be a cache miss.
    const roster = await getVehicleRoster();

    expect(getMock).not.toHaveBeenCalled();
    expect(roster).toHaveLength(2);
    expect(roster[0].vehicleId).toBe('1000067169');
  });
});
