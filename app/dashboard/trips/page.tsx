'use client';

import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { Check, Copy, Plus } from 'lucide-react';
import BulkSelectList from '@/components/BulkSelectList';
import DashboardNav from '@/components/DashboardNav';
import { redirectIfSessionExpired } from '@/lib/sessionExpiry';
import { useTheme } from '@/lib/useTheme';

// The light row shape GET /api/internal/trips returns (Phase I1's collapsed
// model: vehicles with run counts live on the trip itself). No visibility
// toggle exists anymore — the token link is the whole access model.
interface TripRow {
  id: string;
  name: string;
  stopCount: number;
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  vehicles: {
    vehicleId: string;
    vehicleRegistration: string;
    runCount: number;
  }[];
  token: string;
  createdAt: string;
}

async function fetcher(url: string): Promise<TripRow[]> {
  const res = await fetch(url);
  if (redirectIfSessionExpired(res.status)) {
    throw new Error('Session expired');
  }
  if (!res.ok) {
    throw new Error(`trips request failed (${res.status})`);
  }
  return res.json();
}

export default function TripsPage() {
  // Applies the persisted app theme on this page too.
  useTheme();

  const { data: trips, error, isLoading, mutate } = useSWR(
    '/api/internal/trips',
    fetcher,
  );
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function copyTripLink(trip: TripRow) {
    await navigator.clipboard.writeText(
      `${window.location.origin}/trip/${trip.token}`,
    );
    setCopiedId(trip.id);
  }

  // Rejects on any non-OK status — BulkSelectList counts a resolved
  // promise as a successful deletion.
  async function deleteTrip(trip: TripRow) {
    const res = await fetch(`/api/internal/trips/${trip.id}`, {
      method: 'DELETE',
    });
    if (redirectIfSessionExpired(res.status)) {
      throw new Error('Session expired');
    }
    if (!res.ok) {
      throw new Error(`delete failed (${res.status})`);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <header className="flex shrink-0 items-center gap-6 bg-panel px-4 py-2">
        <h1 className="min-w-0 truncate font-heading text-lg font-medium">
          ChiTown Tracking — Fleet Dispatch
        </h1>
        <DashboardNav />
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-xl font-medium">Trips</h2>
          <Link
            href="/dashboard/trips/new"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-white"
            style={{ background: 'var(--color-accent)' }}
          >
            <Plus size={14} />
            New trip
          </Link>
        </div>

        {isLoading && (
          <p className="mt-4 text-sm text-text-muted">Loading trips…</p>
        )}
        {error && (
          <p className="mt-4 text-sm" style={{ color: 'var(--color-alert)' }}>
            Unable to load trips.
          </p>
        )}
        {trips && trips.length === 0 && (
          <p className="mt-4 text-sm text-text-muted">
            No trips yet — create one to get a shareable link.
          </p>
        )}

        {trips && trips.length > 0 && (
          <BulkSelectList
            rows={trips}
            rowKey={(trip) => trip.id}
            rowLabel={(trip) => trip.name}
            headers={
              <>
                <th className="px-3 py-2 font-medium">Trip</th>
                <th className="px-3 py-2 font-medium">Stops</th>
                <th className="px-3 py-2 font-medium">Vehicles</th>
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">Link</span>
                </th>
              </>
            }
            renderRowCells={(trip) => (
              <>
                <td className="px-3 py-2 font-medium">
                  <Link
                    href={`/dashboard/trips/${trip.id}`}
                    className="hover:underline"
                    title="Open trip detail — cancel or replace vehicles"
                  >
                    {trip.name}
                  </Link>
                </td>
                <td className="px-3 py-2 text-text-muted">
                  {trip.stopCount}
                </td>
                <td className="px-3 py-2 text-text-muted">
                  <ul className="flex flex-col gap-0.5">
                    {trip.vehicles.map((vehicle) => (
                      <li
                        key={`${trip.id}-${vehicle.vehicleId}`}
                        className="font-mono text-xs"
                      >
                        {vehicle.vehicleRegistration} ·{' '}
                        {vehicle.runCount === 1
                          ? '1 run'
                          : `${vehicle.runCount} runs`}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => copyTripLink(trip)}
                    aria-label={`Copy trip link for ${trip.name}`}
                    title="Copy this trip's URL"
                    className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-1 text-xs text-text-muted hover:bg-white/5"
                  >
                    {copiedId === trip.id ? (
                      <Check size={13} color="var(--color-live)" />
                    ) : (
                      <Copy size={13} />
                    )}
                    Copy link
                  </button>
                </td>
              </>
            )}
            actionLabel="Delete selected"
            confirmMessage={(selected) =>
              `Delete ${selected.length} ${
                selected.length === 1 ? 'trip' : 'trips'
              }? Their links will stop working immediately.`
            }
            confirmLabel={(count) =>
              `Confirm — delete ${count} ${count === 1 ? 'trip' : 'trips'}`
            }
            busyLabel="Deleting…"
            failureMessage={(labels) =>
              `Could not delete: ${labels.join(', ')} — still listed below; try again.`
            }
            deleteRow={deleteTrip}
            onCompleted={() => mutate()}
          />
        )}
      </main>
    </div>
  );
}
