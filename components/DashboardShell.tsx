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
    <div className="flex h-full">
      <aside className="flex w-[320px] shrink-0 flex-col bg-panel">
        <div className="min-h-0 flex-1">
          <VehicleSidebar
            vehicles={vehicles}
            selectedVehicleId={selectedVehicleId}
            onSelect={setSelectedVehicleId}
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
      <div className="min-w-0 flex-1">
        <FleetMap vehicles={vehicles} selectedVehicleId={selectedVehicleId} />
      </div>
    </div>
  );
}
