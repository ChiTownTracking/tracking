import type { RosterVehicle } from './vehicleRoster';

// Client-side filter over an already-loaded roster — matches the bold
// (registrationNumber) and muted (description) fields shown per row.
export function filterVehiclesBySearch(
  vehicles: RosterVehicle[],
  query: string,
): RosterVehicle[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return [...vehicles];
  }
  return vehicles.filter(
    (vehicle) =>
      vehicle.registrationNumber.toLowerCase().includes(needle) ||
      vehicle.description.toLowerCase().includes(needle),
  );
}
