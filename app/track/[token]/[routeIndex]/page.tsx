'use client';

import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { useState } from 'react';

// Maps JS needs window — same Client Component + ssr:false requirement as
// the bare track page.
const TrackMap = dynamic(() => import('@/components/TrackMap'), {
  ssr: false,
  loading: () => (
    <div className="p-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
      Loading your trip…
    </div>
  ),
});

// Phase J4b: THE page's one Maps JS provider — TrackMap renders inside it
// and never creates its own.
const GoogleMapsProvider = dynamic(
  () => import('@/components/GoogleMapsProvider'),
  { ssr: false },
);

// One route's full experience. No index validation here: the API is the
// authority, and a malformed or out-of-range index 404s into the same
// "link no longer available" notice as a bad token.
export default function TrackRoutePage() {
  const { token, routeIndex } = useParams<{
    token: string;
    routeIndex: string;
  }>();
  // Same header pattern as the bare page: TrackMap reports the name up once
  // an active window includes it; the nbsp holds the line height meanwhile.
  const [customerName, setCustomerName] = useState<string | null>(null);

  return (
    <div className="customer-theme min-h-screen">
      <header className="px-4 pb-2 pt-6 text-center">
        <p className="customer-heading text-lg">{customerName ?? ' '}</p>
      </header>
      <main className="px-4 py-4">
        <GoogleMapsProvider>
          <TrackMap
            token={token}
            routeIndex={Number(routeIndex)}
            onCustomerName={setCustomerName}
          />
        </GoogleMapsProvider>
      </main>
    </div>
  );
}
