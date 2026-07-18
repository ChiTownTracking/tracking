import { describe, expect, it } from 'vitest';
import type { RosterVehicle } from '@/lib/vehicleRoster';
import { filterVehiclesBySearch } from '@/lib/vehicleSearch';

const fleet: RosterVehicle[] = [
  {
    vehicleId: '1000067169',
    registrationNumber: '2401',
    description: 'FORD 2401',
    iconUrl: '',
  },
  {
    vehicleId: '1000074171',
    registrationNumber: '2402',
    description: 'FORD 2402',
    iconUrl: '',
  },
  {
    vehicleId: '1000043538',
    registrationNumber: '2801',
    description: 'FORD 2801',
    iconUrl: '',
  },
  {
    vehicleId: '1000065076',
    registrationNumber: '3601',
    description: '3601',
    iconUrl: '',
  },
];

describe('filterVehiclesBySearch', () => {
  it('returns all vehicles for an empty query', () => {
    expect(filterVehiclesBySearch(fleet, '')).toEqual(fleet);
  });

  it('returns all vehicles for a whitespace-only query', () => {
    expect(filterVehiclesBySearch(fleet, '   ')).toEqual(fleet);
  });

  it('matches on registrationNumber', () => {
    const result = filterVehiclesBySearch(fleet, '3601');
    expect(result.map((v) => v.vehicleId)).toEqual(['1000065076']);
  });

  it('matches on description', () => {
    const result = filterVehiclesBySearch(fleet, 'FORD 2801');
    expect(result.map((v) => v.vehicleId)).toEqual(['1000043538']);
  });

  it('is case-insensitive', () => {
    const result = filterVehiclesBySearch(fleet, 'ford');
    expect(result.map((v) => v.vehicleId).sort()).toEqual(
      ['1000067169', '1000074171', '1000043538'].sort(),
    );
  });

  it('matches on a partial/substring query', () => {
    const result = filterVehiclesBySearch(fleet, '24');
    expect(result.map((v) => v.vehicleId).sort()).toEqual(
      ['1000067169', '1000074171'].sort(),
    );
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterVehiclesBySearch(fleet, 'nonexistent')).toEqual([]);
  });

  it('trims leading/trailing whitespace before matching', () => {
    const result = filterVehiclesBySearch(fleet, '  2401  ');
    expect(result.map((v) => v.vehicleId)).toEqual(['1000067169']);
  });

  it('does not mutate the input array', () => {
    const original = [...fleet];
    filterVehiclesBySearch(fleet, '24');
    expect(fleet).toEqual(original);
  });
});
