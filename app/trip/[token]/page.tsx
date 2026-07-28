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
  // Present only when staff attached one via cancel/replace (Phase L3).
  serviceNote?: string;
  // Present only when staff set a card-label prefix (Phase N4).
  cardLabel?: string;
  // The active run's date label (Phase N5) — absent only when nothing is
  // scheduled at all.
  activeRunDateLabel?: string;
  // Every run valid TODAY (Phase N6: window-checked; can be empty).
  schedule: TripCardScheduleEntry[];
  // The same entries and window, one day ahead.
  tomorrowSchedule: TripCardScheduleEntry[];
}

interface TripDetailActive {
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

// The endpoint has TWO answer shapes. Phase N3 gates it on the trip's own
// active window, and outside that window it answers 200 with a status-only
// payload carrying no trip and no vehicles — deliberately, so nothing leaks
// before the window opens or after it closes. It is the same minimal shape
// /api/track returns and TrackMap already renders. This page must
// discriminate before touching any trip field; assuming the active shape
// unconditionally is what made an out-of-window link crash on data.trip.id.
type TripDetailResponse =
  | { status: 'not_started' | 'ended'; message: string }
  | TripDetailActive;

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

  // Discriminate the two shapes ONCE, here: every read below goes through
  // `detail`, so an out-of-window response can never reach code that
  // assumes a trip. Same `in`-operator narrowing the bare track page uses
  // on its own two-shape endpoint.
  const detail = data && 'trip' in data ? data : null;
  const windowNotice = data && !('trip' in data) ? data.message : null;

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
  const mapRoutes: BoardRouteSummary[] = detail
    ? [
        {
          id: detail.trip.id,
          name: detail.trip.name,
          geometry: detail.trip.geometry,
          stops: detail.trip.stops,
        },
      ]
    : [];
  const mapTrips: BoardTripSummary[] = detail
    ? detail.vehicles.map((vehicle, index) => ({
        // vehicleId alone could repeat if staff assign one vehicle twice;
        // the index keeps marker keys and focus targets unambiguous.
        id: `${index}-${vehicle.vehicleId}`,
        routeId: detail.trip.id,
        vehicleLabel: vehicle.vehicleLabel,
        position: vehicle.position,
        positionConfident: vehicle.positionConfident,
        speedMph: vehicle.speedMph,
        nextStopIndex: vehicle.nextStopIndex,
        stopEtas: vehicle.stopEtas,
      }))
    : [];
  const stopLabels = detail ? detail.trip.stops.map((stop) => stop.label) : [];

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
          {detail?.trip.name ?? ' '}
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
        ) : windowNotice !== null ? (
          // Before the window opens or after it closes: the server's own
          // customer-facing wording and nothing else — no map, no cards.
          // Exactly the treatment TrackMap gives this identical shape.
          <Notice>{windowNotice}</Notice>
        ) : !detail ? null : (
          <>
            <GoogleMapsProvider>
              <BoardMap
                routes={mapRoutes}
                trips={mapTrips}
                focusCommand={focus}
                onClearFocus={() => setFocus(null)}
              />
            </GoogleMapsProvider>
            {detail.vehicles.length === 0 && (
              <Notice>No vehicles are assigned to this trip yet.</Notice>
            )}
            {detail.vehicles.map((vehicle, index) => (
              <TripStatusCard
                key={mapTrips[index].id}
                vehicleLabel={vehicle.vehicleLabel}
                cardLabel={vehicle.cardLabel ?? null}
                hasPosition={vehicle.position !== null}
                positionConfident={vehicle.positionConfident}
                schedule={vehicle.schedule}
                tomorrowSchedule={vehicle.tomorrowSchedule}
                activeRunDateLabel={vehicle.activeRunDateLabel ?? null}
                serviceNote={vehicle.serviceNote ?? null}
                pickupLabel={stopLabels[0] ?? 'the first stop'}
                destinationLabel={
                  stopLabels[stopLabels.length - 1] ?? 'the final stop'
                }
                totalDurationSeconds={detail.trip.totalDurationSeconds}
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
