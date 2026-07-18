'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import DashboardNav from '@/components/DashboardNav';
import type { Vehicle } from '@/lib/liveVehicles';
import { isVehicleLive } from '@/lib/vehicleStatus';
import { useTheme } from '@/lib/useTheme';

// Maps JS needs window, so the whole shell loads client-side only. ssr: false
// is only valid inside a Client Component — hence 'use client' on this page.
const DashboardShell = dynamic(() => import('@/components/DashboardShell'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-text-muted">
      Loading dashboard…
    </div>
  ),
});

// Phase J4d: THE page's one Maps JS provider — FleetMap (inside the shell)
// renders within it and never creates its own.
const GoogleMapsProvider = dynamic(
  () => import('@/components/GoogleMapsProvider'),
  { ssr: false },
);

export default function DashboardPage() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const { theme, toggleTheme } = useTheme();
  const moving = vehicles.filter(
    (vehicle) => isVehicleLive(vehicle.lastUpdatedAt) && vehicle.speed > 2,
  ).length;

  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      <header className="flex shrink-0 items-center justify-between gap-4 bg-panel px-4 py-2">
        <div className="flex items-center gap-6">
          <h1 className="font-heading text-lg font-medium">
            ChiTown Tracking — Fleet Dispatch
          </h1>
          <DashboardNav />
        </div>
        <div className="flex items-center gap-4">
          <span className="font-mono text-sm text-text-muted">
            {vehicles.length} vehicles · {moving} moving
          </span>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={
              theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
            }
            title={
              theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
            }
            className="rounded-md p-1.5 text-text-muted transition-opacity hover:opacity-75"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <GoogleMapsProvider>
          <DashboardShell onVehiclesUpdate={setVehicles} />
        </GoogleMapsProvider>
      </main>
    </div>
  );
}
