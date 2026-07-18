'use client';

import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { trackFetcher } from '@/lib/trackFetcher';

// Maps JS needs window — same Client Component + ssr:false requirement as
// the staff dashboard.
const TrackMap = dynamic(() => import('@/components/TrackMap'), {
  ssr: false,
  loading: () => (
    <div className="p-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
      Loading your trip…
    </div>
  ),
});

// Phase J4b: THE page's one Maps JS provider — every TrackMap branch below
// renders inside it; TrackMap itself never creates one.
const GoogleMapsProvider = dynamic(
  () => import('@/components/GoogleMapsProvider'),
  { ssr: false },
);

// The bare endpoint's two answer shapes: a routes link gets a directory of
// names (for linking to /track/[token]/[routeIndex]); a no-routes link gets
// the classic status payload, which TrackMap consumes directly.
type BareTrackResponse =
  | { routes: Array<{ index: number; name: string }> }
  | { status: string };

export default function TrackPage() {
  const { token } = useParams<{ token: string }>();
  // Reported up by TrackMap once the tracking data loads (only an active
  // window includes the name). The nbsp placeholder holds the header's line
  // height so the layout doesn't jump when the name arrives.
  const [customerName, setCustomerName] = useState<string | null>(null);
  // Which route's view is showing (2+ routes only). Plain client state, no
  // URL change: switching tabs just re-points TrackMap's routeIndex at a
  // different per-route endpoint. Deep links to one leg still exist at
  // /track/[token]/[routeIndex].
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);

  // Shape discovery only — no polling of its own. While loading (or on
  // error), the no-routes branch renders TrackMap, which subscribes to this
  // SAME key (SWR dedupes the fetch) and owns polling plus the loading and
  // error presentation; this page swaps to a route view only if a routes
  // directory actually arrives.
  const { data } = useSWR<BareTrackResponse>(
    `/api/track/${token}`,
    trackFetcher,
  );
  const directory = data && 'routes' in data ? data.routes : null;

  return (
    <div className="customer-theme min-h-screen">
      <header className="px-4 pb-2 pt-6 text-center">
        <p className="customer-heading text-lg">{customerName ?? ' '}</p>
      </header>
      <main className="px-4 py-4">
        <GoogleMapsProvider>
          {directory === null ? (
            // No routes: today's exact experience, unchanged.
            <TrackMap token={token} onCustomerName={setCustomerName} />
          ) : directory.length === 1 ? (
            // Exactly one route: render its full page inline — no one-item
            // directory, same "don't build UI for a single item" convention
            // used everywhere else.
            <TrackMap
              token={token}
              routeIndex={0}
              onCustomerName={setCustomerName}
            />
          ) : (
            // 2+ routes: same-page tab switching (replaced the E3b directory
            // of links). Same segmented-control styling as the Vehicle/Route
            // centering toggle; each tab re-points TrackMap at that route's
            // own endpoint.
            <>
              <div className="mx-auto mb-4 flex w-full max-w-3xl">
                <div
                  className="flex flex-wrap gap-1 rounded-md p-1 text-xs shadow-sm"
                  style={{ background: 'var(--color-panel)' }}
                >
                  {directory.map((route) => (
                    <button
                      key={route.index}
                      type="button"
                      onClick={() => setSelectedRouteIndex(route.index)}
                      aria-pressed={route.index === selectedRouteIndex}
                      className="rounded px-2.5 py-1.5 font-medium"
                      style={
                        route.index === selectedRouteIndex
                          ? { background: 'var(--color-accent)', color: '#ffffff' }
                          : { color: 'var(--color-text-muted)' }
                      }
                    >
                      {route.name}
                    </button>
                  ))}
                </div>
              </div>
              <TrackMap
                token={token}
                routeIndex={selectedRouteIndex}
                onCustomerName={setCustomerName}
              />
            </>
          )}
        </GoogleMapsProvider>
      </main>
    </div>
  );
}
