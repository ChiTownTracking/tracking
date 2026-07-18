import { describe, expect, it } from 'vitest';
import vehicles from '@/__fixtures__/vehicles.json';
import vehiclesLive from '@/__fixtures__/vehiclesLive.json';

// Locks in the real Quartix field-casing fact as an executable test, not
// just a comment: /vehicles returns "VehicleId" (lowercase "d"), not
// "VehicleID" as the docs claim.
describe('vehicles fixture', () => {
  it('has exactly 40 entries', () => {
    expect(vehicles).toHaveLength(40);
  });

  it('every entry has a numeric VehicleId property (not VehicleID)', () => {
    for (const vehicle of vehicles) {
      expect(vehicle).toHaveProperty('VehicleId');
      expect(typeof vehicle.VehicleId).toBe('number');
      expect(vehicle).not.toHaveProperty('VehicleID');
    }
  });

  // Same fact for /vehicles/live: real responses use "VehicleId" and
  // "LastEventDateTime" — not "VehicleID" or "LastEventDatetime".
  it('every vehiclesLive entry has numeric VehicleId and LastEventDateTime (not VehicleID / LastEventDatetime)', () => {
    for (const vehicle of vehiclesLive) {
      expect(vehicle).toHaveProperty('VehicleId');
      expect(typeof vehicle.VehicleId).toBe('number');
      expect(vehicle).not.toHaveProperty('VehicleID');
      expect(vehicle).toHaveProperty('LastEventDateTime');
      expect(vehicle).not.toHaveProperty('LastEventDatetime');
    }
  });
});
