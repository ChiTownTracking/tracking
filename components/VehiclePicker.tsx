'use client';

import { Bus } from 'lucide-react';
import type { RosterVehicle } from '@/lib/vehicleRoster';
import { filterVehiclesBySearch } from '@/lib/vehicleSearch';
import { fieldInputClass } from './formStyles';

// The vehicle checklist + search, extracted verbatim from create-link so
// trip creation can reuse it. Stateless: the roster is fetched ONCE at the
// page level; each instance is just an independent selection view over it.
// Single-select consumers (a trip has exactly one vehicle) pass a ≤1-item
// set and replace it in onToggle.
export default function VehiclePicker({
  roster,
  isLoading,
  loadFailed,
  query,
  onQueryChange,
  selected,
  onToggle,
  searchLabel,
}: {
  roster: RosterVehicle[] | undefined;
  isLoading: boolean;
  loadFailed: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  selected: ReadonlySet<string>;
  onToggle: (vehicleId: string) => void;
  searchLabel: string;
}) {
  const filtered = roster ? filterVehiclesBySearch(roster, query) : undefined;
  return (
    <>
      {isLoading && <p className="text-sm text-text-muted">Loading roster…</p>}
      {loadFailed && (
        <p className="text-sm" style={{ color: 'var(--color-alert)' }}>
          Unable to load the vehicle roster.
        </p>
      )}
      {roster && (
        <input
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search vehicles…"
          aria-label={searchLabel}
          className={`mb-2 ${fieldInputClass}`}
        />
      )}
      {filtered && filtered.length === 0 && (
        <p className="text-sm text-text-muted">No vehicles match.</p>
      )}
      {filtered && filtered.length > 0 && (
        <ul className="max-h-64 overflow-y-auto rounded-md border border-white/10 bg-panel">
          {filtered.map((vehicle) => (
            <li key={vehicle.vehicleId}>
              <label className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 hover:bg-white/5">
                <input
                  type="checkbox"
                  checked={selected.has(vehicle.vehicleId)}
                  onChange={() => onToggle(vehicle.vehicleId)}
                  className="accent-accent"
                />
                <Bus
                  size={16}
                  className="shrink-0"
                  color="var(--color-text-muted)"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {vehicle.registrationNumber}
                  </span>
                  <span className="block truncate text-xs text-text-muted">
                    {vehicle.description}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
