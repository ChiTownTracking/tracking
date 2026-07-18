'use client';

import type { ReactNode } from 'react';
import { APIProvider } from '@vis.gl/react-google-maps';

// Phase J4a: the ONE Maps JS loader wrapper. Exactly one instance per page
// that needs maps — multiple <APIProvider>s each trying to load the script
// on the same page is a real, known Google Maps footgun, so a section that
// renders several maps (e.g. StopListEditor's per-stop pickers) wraps them
// ALL in one of these, never one per map. Browser-only (Maps JS needs
// window): dynamically import with ssr: false, same as every map component.
//
// NEXT_PUBLIC on purpose — this is the browser-side Maps JS key (referrer-
// restricted), a different credential from the server-only GOOGLE_MAPS_API_KEY
// that googleMapsClient uses for Places/Routes.
const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_KEY;

export default function GoogleMapsProvider({
  children,
}: {
  children: ReactNode;
}) {
  if (!apiKey) {
    // Fail loudly, same discipline as parseEnv on the server: a missing key
    // silently rendering blank maps would be much harder to diagnose.
    throw new Error('NEXT_PUBLIC_GOOGLE_MAPS_MAP_KEY is not set');
  }
  return <APIProvider apiKey={apiKey}>{children}</APIProvider>;
}
