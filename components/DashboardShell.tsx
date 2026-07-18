'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { LogOut } from 'lucide-react';
import type { Vehicle } from '@/lib/liveVehicles';
import { redirectIfSessionExpired } from '@/lib/sessionExpiry';
import FleetMap from './FleetMap';
import VehicleSidebar from './VehicleSidebar';

async function fetcher(url: string): Promise<Vehicle[]> {
  const res = await fetch(url);
  if (redirectIfSessionExpired(res.status)) {
    throw new Error('Session expired');
  }
  if (!res.ok) {
    throw new Error(`fleet-live request failed (${res.status})`);
  }
  return res.json();
}

async function handleLogout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.assign('/');
}

interface DashboardShellProps {
  // Lets the page's top bar show a live summary while this component stays
  // the single owner of the SWR subscription.
  onVehiclesUpdate?: (vehicles: Vehicle[]) => void;
}

export default function DashboardShell({
  onVehiclesUpdate,
}: DashboardShellProps) {
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(
    null,
  );
  // Phase N1: below md the fixed 320px sidebar left the map a ~55px sliver,
  // so narrow widths get a full-width Map/List toggle instead. Both panes
  // stay MOUNTED (hidden via classes) so the map camera and the sidebar's
  // search/selection survive switching. Ignored from md up.
  const [mobileView, setMobileView] = useState<'map' | 'list'>('map');
  const {
    data: vehicles,
    error,
    isLoading,
  } = useSWR('/api/internal/fleet-live', fetcher, {
    refreshInterval: 30_000,
  });

  useEffect(() => {
    if (vehicles) {
      onVehiclesUpdate?.(vehicles);
    }
  }, [vehicles, onVehiclesUpdate]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
        Loading fleet…
      </div>
    );
  }

  if (error || !vehicles) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm"
        style={{ color: 'var(--color-alert)' }}
      >
        Unable to load fleet data. Retrying automatically…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Narrow-width pane switcher — same segmented-control styling as
          FleetMap's Dark/Light toggle. */}
      <div className="flex shrink-0 justify-center p-2 md:hidden">
        <div className="flex overflow-hidden rounded-md bg-panel text-xs shadow-md">
          {(['map', 'list'] as const).map((view) => (
            <button
              key={view}
              type="button"
              onClick={() => setMobileView(view)}
              aria-pressed={mobileView === view}
              className="px-4 py-1.5 font-medium"
              style={
                mobileView === view
                  ? { background: 'var(--color-accent)', color: '#ffffff' }
                  : { color: 'var(--color-text-muted)' }
              }
            >
              {view === 'map' ? 'Map' : `Vehicles (${vehicles.length})`}
            </button>
          ))}
        </div>
      </div>
      <aside
        className={`${
          mobileView === 'list' ? 'flex' : 'hidden'
        } min-h-0 w-full flex-1 flex-col bg-panel md:flex md:w-[320px] md:flex-none md:shrink-0`}
      >
        <div className="min-h-0 flex-1">
          <VehicleSidebar
            vehicles={vehicles}
            selectedVehicleId={selectedVehicleId}
            onSelect={(vehicleId) => {
              setSelectedVehicleId(vehicleId);
              // Picking a vehicle on a phone means "show me it" — jump to
              // the map pane the selection just moved.
              setMobileView('map');
            }}
          />
        </div>
        <div className="shrink-0 border-t border-white/10 p-3">
          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm text-text-muted hover:opacity-75"
          >
            <LogOut size={15} />
            Sign out
          </button>
        </div>
      </aside>
      <div
        className={`${
          mobileView === 'map' ? 'block' : 'hidden'
        } min-h-0 min-w-0 flex-1 md:block`}
      >
        <FleetMap vehicles={vehicles} selectedVehicleId={selectedVehicleId} />
      </div>
    </div>
  );
}
