'use client';

import { useState } from 'react';
import { Bus } from 'lucide-react';
import type { Vehicle } from '@/lib/liveVehicles';
import { getStatusLabel, isVehicleLive } from '@/lib/vehicleStatus';
import { groupVehiclesByStatus } from '@/lib/vehicleGrouping';

interface VehicleSidebarProps {
  vehicles: Vehicle[];
  selectedVehicleId: string | null;
  onSelect: (vehicleId: string) => void;
}

export default function VehicleSidebar({
  vehicles,
  selectedVehicleId,
  onSelect,
}: VehicleSidebarProps) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const filtered = vehicles.filter(
    (vehicle) =>
      vehicle.registrationNumber.toLowerCase().includes(needle) ||
      vehicle.description.toLowerCase().includes(needle),
  );

  // Grouping happens after filtering so a search still shows which
  // section(s) the matches live in — the section structure never hides.
  const groups = groupVehiclesByStatus(filtered);
  const sections = [
    { title: 'En Route', sectionVehicles: groups.enRoute },
    { title: 'Stopped', sectionVehicles: groups.stopped },
    { title: 'Offline', sectionVehicles: groups.offline },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 p-3">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search vehicles…"
          aria-label="Search vehicles"
          className="w-full rounded-md border border-white/10 bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sections.map(({ title, sectionVehicles }) => (
          <section key={title}>
            <h2 className="px-3 pb-1 pt-3 font-heading text-xs font-medium uppercase tracking-wider text-text-muted">
              {title} ({sectionVehicles.length})
            </h2>
            <ul>
              {sectionVehicles.map((vehicle) => {
                const selected = vehicle.vehicleId === selectedVehicleId;
                const live = isVehicleLive(vehicle.lastUpdatedAt);
                return (
                  <li key={vehicle.vehicleId}>
                    <button
                      type="button"
                      onClick={() => onSelect(vehicle.vehicleId)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-white/5"
                      style={
                        selected
                          ? {
                              background:
                                'color-mix(in srgb, var(--color-accent) 25%, transparent)',
                            }
                          : undefined
                      }
                    >
                      {/* Uniform icon on purpose — the per-vehicle Quartix
                          icons are too visually noisy at this size. */}
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
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-text-muted">
                        <span
                          className={
                            live ? 'status-dot status-dot--live' : 'status-dot'
                          }
                        />
                        {getStatusLabel(vehicle.speed, vehicle.lastUpdatedAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
              {sectionVehicles.length === 0 && (
                <li className="px-3 pb-2 text-xs text-text-muted">None</li>
              )}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
