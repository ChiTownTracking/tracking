'use client';

import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import type {
  BoardRouteSummary,
  BoardTripSummary,
} from '@/components/BoardMap';
import TripStatusCard, {
  type TripCardScheduleEntry,
} from '@/components/TripStatusCard';
import { getRouteColor } from '@/lib/routeColors';
import { trackFetcher } from '@/lib/trackFetcher';

// Phase I2: the public trip page for the collapsed model — ONE route, MANY
// vehicles on one shared map (BoardMap, the multi-vehicle renderer — not an
// adapter into the single-vehicle TrackMap). Colors tie each vehicle's
// marker to its card by vehicle position, and each card carries that
// vehicle's full grouped run schedule. Outside proxy.ts's matchers by
// design; the token is the gate, never a session.

// Maps JS needs window — same Client Component + ssr:false requirement as
// every other map in the app.
const BoardMap = dynamic(() => import('@/components/BoardMap'), {
  ssr: false,
  loading: () => (
    <div
      className="h-[320px] rounded-xl sm:h-[420px]"
      style={{ background: 'var(--color-panel)' }}
    />
  ),
});

// Phase J4c: THE page's one Maps JS provider — BoardMap renders inside it
// and never creates its own.
const GoogleMapsProvider = dynamic(
  () => import('@/components/GoogleMapsProvider'),
  { ssr: false },
);

// Client-side mirror of /api/public/trip/[token]'s multi-vehicle response.
interface TripVehicleDetail {
  vehicleId: string;
  vehicleLabel: string;
  position: { lat: number; lng: number; headingDegrees: number | null } | null;
  positionConfident: boolean | null;
  positionUpdatedAt: string | null;
  speedMph: number | null;
  nextStopIndex: number | null;
  stopEtas: { arrival: string | null; departure: string | null }[] | null;
  schedule: TripCardScheduleEntry[];
}

interface TripDetailResponse {
  trip: {
    id: string;
    name: string;
    geometry: [number, number][];
    stops: { label: string; lat: number; lng: number }[];
    totalDistanceMeters: number;
    totalDurationSeconds: number;
  };
  vehicles: TripVehicleDetail[];
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl p-8 text-center"
      style={{
        background: 'var(--color-panel)',
        color: 'var(--color-text-muted)',
      }}
    >
      {children}
    </div>
  );
}

export default function TripPage() {
  const { token } = useParams<{ token: string }>();

  // Same 30-second poll as every other live view. trackFetcher rejects a
  // 404 as 'not_found', which is exactly the unknown-token case.
  const { data, error, isLoading } = useSWR<TripDetailResponse>(
    `/api/public/trip/${token}`,
    trackFetcher,
    { refreshInterval: 30_000 },
  );

  // A per-vehicle Center request: seq bumps make the same vehicle
  // re-clickable; the map centers once per click — no continuous follow on
  // this shared view. Cleared by the map's fit-everything button.
  const [focus, setFocus] = useState<{ seq: number; tripId: string } | null>(
    null,
  );

  // The current instant is STATE, not a render-time new Date() — same React
  // Compiler reasoning as ScheduleTimeline: an untracked clock read gets
  // baked into a memoized block and the status line goes stale.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(interval);
  }, []);

  // Adapt the detail into BoardMap's existing props: the one route, and one
  // "trip" entry per vehicle (BoardMap's unit of rendering is a moving
  // vehicle — exactly what each assignment is now).
  const mapRoutes: BoardRouteSummary[] = data
    ? [
        {
          id: data.trip.id,
          name: data.trip.name,
          geometry: data.trip.geometry,
          stops: data.trip.stops,
        },
      ]
    : [];
  const mapTrips: BoardTripSummary[] = data
    ? data.vehicles.map((vehicle, index) => ({
        // vehicleId alone could repeat if staff assign one vehicle twice;
        // the index keeps marker keys and focus targets unambiguous.
        id: `${index}-${vehicle.vehicleId}`,
        routeId: data.trip.id,
        vehicleLabel: vehicle.vehicleLabel,
        position: vehicle.position,
        positionConfident: vehicle.positionConfident,
        speedMph: vehicle.speedMph,
        nextStopIndex: vehicle.nextStopIndex,
        stopEtas: vehicle.stopEtas,
      }))
    : [];
  const stopLabels = data ? data.trip.stops.map((stop) => stop.label) : [];

  return (
    <div className="customer-theme min-h-screen">
      <header className="px-4 pb-2 pt-6 text-center">
        <p
          className="text-xs font-medium uppercase tracking-widest"
          style={{ color: 'var(--color-accent)' }}
        >
          ChiTown Tracking
        </p>
        <h1 className="customer-heading mt-1 text-2xl">
          {data?.trip.name ?? ' '}
        </h1>
      </header>
      {/* Mobile-first: the real-world use is a phone at a stop — map at a
          fixed comfortable height on top, vehicle cards stacked below. */}
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4">
        {isLoading ? (
          <Notice>Loading the trip…</Notice>
        ) : error ? (
          <Notice>
            {error.message === 'not_found'
              ? "This link isn't valid. Please contact ChiTown Trolley if you believe this is a mistake."
              : 'We had trouble loading the trip. Retrying automatically…'}
          </Notice>
        ) : !data ? null : (
          <>
            <GoogleMapsProvider>
              <BoardMap
                routes={mapRoutes}
                trips={mapTrips}
                focusCommand={focus}
                onClearFocus={() => setFocus(null)}
              />
            </GoogleMapsProvider>
            {data.vehicles.length === 0 && (
              <Notice>No vehicles are assigned to this trip yet.</Notice>
            )}
            {data.vehicles.map((vehicle, index) => (
              <TripStatusCard
                key={mapTrips[index].id}
                vehicleLabel={vehicle.vehicleLabel}
                hasPosition={vehicle.position !== null}
                positionUpdatedAt={vehicle.positionUpdatedAt}
                positionConfident={vehicle.positionConfident}
                schedule={vehicle.schedule}
                pickupLabel={stopLabels[0] ?? 'the first stop'}
                destinationLabel={
                  stopLabels[stopLabels.length - 1] ?? 'the final stop'
                }
                totalDurationSeconds={data.trip.totalDurationSeconds}
                // Same index → same color as this vehicle's map marker.
                color={getRouteColor(index)}
                now={now}
                focused={focus?.tripId === mapTrips[index].id}
                onCenter={() =>
                  setFocus((current) => ({
                    seq: (current?.seq ?? 0) + 1,
                    tripId: mapTrips[index].id,
                  }))
                }
              />
            ))}
          </>
        )}
      </main>
    </div>
  );
}
