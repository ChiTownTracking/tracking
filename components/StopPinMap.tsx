'use client';

import { useEffect, useState } from 'react';
import { AdvancedMarker, Map, useMap } from '@vis.gl/react-google-maps';
import { Maximize2, X } from 'lucide-react';
import type { Theme } from '@/lib/useTheme';

// Click-to-pin picker for the create-link Route section — the "drop a pin"
// fallback beside the geocode search. Phase J4a: rewritten from
// react-leaflet/CARTO onto @vis.gl/react-google-maps — the first map
// converted, proving the pattern before TrackMap/BoardMap/FleetMap follow.
// The onPick contract and every interaction are unchanged; only the
// rendering technology underneath moved. Expects to be rendered inside the
// page's ONE GoogleMapsProvider (StopListEditor provides it) — never wraps
// its own.
//
// Interaction model: clicking places (or moves) a DRAGGABLE pending marker;
// nothing resolves until "Confirm location" — onPick fires only then. The
// pending coordinate lives in this component and is shared by the compact
// view and the fullscreen overlay, so expanding/closing never loses it; only
// Cancel discards it. When the stop resolves, the page swaps in the
// confirmed view and this component unmounts, taking any leftover pending
// state with it — so "Choose again" always reopens clean.

// Matches googleMapsClient's geocoding focus point.
const CHICAGO_FOCUS = { lat: 41.8781, lng: -87.6298 };

// Cloud-styled map IDs, one per theme — replaces the CARTO dark_all/
// light_all tile URLs. (Google renders its own required logo/Terms
// attribution; the manual OSM/CARTO credit is gone with the tiles.)
const MAP_IDS: Record<Theme, string> = {
  dark: '31dfa4afbe1fa578d2690926',
  light: '31dfa4afbe1fa578f1ed110a',
};

interface LatLng {
  lat: number;
  lng: number;
}

// The accent/muted dots, same visuals as the old Leaflet DivIcons.
// AdvancedMarker anchors its content bottom-center on the coordinate, so
// translateY(50%) re-centers the dot on the point (the DivIcons did this
// via iconAnchor).
function PendingDot() {
  return (
    <span
      style={{
        display: 'block',
        width: 16,
        height: 16,
        borderRadius: 9999,
        background: 'var(--color-accent)',
        border: '2px solid #ffffff',
        boxShadow: '0 1px 4px rgb(0 0 0 / 0.4)',
        cursor: 'grab',
        transform: 'translateY(50%)',
      }}
    />
  );
}

function ContextDot() {
  return (
    <span
      style={{
        display: 'block',
        width: 12,
        height: 12,
        borderRadius: 9999,
        background: 'var(--color-text-muted)',
        border: '2px solid #ffffff',
        boxShadow: '0 1px 3px rgb(0 0 0 / 0.4)',
        transform: 'translateY(50%)',
      }}
    />
  );
}

// Attaches the click-to-place listener to the imperative map instance —
// same placePending() logic as the Leaflet version, new event source.
function ClickController({
  onPlace,
}: {
  onPlace: (lat: number, lng: number) => void;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map) {
      return;
    }
    const listener = map.addListener(
      'click',
      (event: google.maps.MapMouseEvent) => {
        if (event.latLng) {
          onPlace(event.latLng.lat(), event.latLng.lng());
        }
      },
    );
    return () => listener.remove();
  }, [map, onPlace]);

  return null;
}

// One map view; rendered once compact and (while expanded) once fullscreen.
// Both instances read/write the same pending state via props, and both live
// inside the SAME page-level GoogleMapsProvider — the script loads once.
function PickerMap({
  tileStyle,
  contextPin,
  pending,
  onPlace,
}: {
  tileStyle: Theme;
  contextPin: LatLng | null;
  pending: LatLng | null;
  onPlace: (lat: number, lng: number) => void;
}) {
  const center = pending ?? contextPin ?? CHICAGO_FOCUS;
  return (
    <Map
      mapId={MAP_IDS[tileStyle]}
      defaultCenter={center}
      defaultZoom={10}
      // Drop Google's map-type/street-view/fullscreen buttons — they don't
      // fit this app's minimal design and the component has its own expand
      // button. Zoom control stays, matching the Leaflet +/- behavior.
      disableDefaultUI
      zoomControl
      // A click must always mean "place the pin here" — never open a POI
      // card (Leaflet had no clickable POIs, so this preserves behavior).
      clickableIcons={false}
      // Wheel zoom needs Ctrl on purpose: the compact picker sits inside a
      // long form, and hijacking page scroll there is hostile — same reason
      // the Leaflet version set scrollWheelZoom={false}. Dragging and the
      // zoom control still work.
      gestureHandling="cooperative"
      className="h-full w-full"
    >
      {contextPin && !pending && (
        <AdvancedMarker position={contextPin}>
          <ContextDot />
        </AdvancedMarker>
      )}
      {pending && (
        <AdvancedMarker
          position={pending}
          draggable
          onDragEnd={(event: google.maps.MapMouseEvent) => {
            if (event.latLng) {
              onPlace(event.latLng.lat(), event.latLng.lng());
            }
          }}
        >
          <PendingDot />
        </AdvancedMarker>
      )}
      <ClickController onPlace={onPlace} />
    </Map>
  );
}

function PendingActions({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: LatLng;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="font-mono text-xs text-text-muted">
        {pending.lat.toFixed(5)}, {pending.lng.toFixed(5)}
      </span>
      <button
        type="button"
        onClick={onConfirm}
        className="rounded-md px-3 py-1.5 text-xs font-medium text-white"
        style={{ background: 'var(--color-accent)' }}
      >
        Confirm location
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="text-xs text-text-muted underline-offset-2 hover:underline"
      >
        Cancel
      </button>
    </div>
  );
}

interface StopPinMapProps {
  tileStyle: Theme;
  // This stop's own previously chosen point (if any) — shown so "Choose
  // again" doesn't lose visual context. Never other stops' pins.
  pin: LatLng | null;
  // Fired only on "Confirm location", never on a raw map click.
  onPick: (lat: number, lng: number) => void;
}

export default function StopPinMap({ tileStyle, pin, onPick }: StopPinMapProps) {
  const [pending, setPending] = useState<LatLng | null>(null);
  const [expanded, setExpanded] = useState(false);

  function placePending(lat: number, lng: number) {
    // Places a new pending marker, or moves the existing one — no need to
    // remove it first.
    setPending({ lat, lng });
  }

  function confirmPending() {
    if (!pending) {
      return;
    }
    onPick(pending.lat, pending.lng);
    setPending(null);
    setExpanded(false);
  }

  // Escape closes the overlay — but never discards the pending marker; that
  // stays until an explicit Confirm or Cancel.
  useEffect(() => {
    if (!expanded) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setExpanded(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  // Body scroll lock while the overlay is open.
  useEffect(() => {
    if (!expanded) {
      return;
    }
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [expanded]);

  return (
    <div>
      <div className="relative h-44 overflow-hidden rounded-md border border-white/10">
        <PickerMap
          tileStyle={tileStyle}
          contextPin={pin}
          pending={pending}
          onPlace={placePending}
        />
        {/* Top-right: clear of the zoom control and Google's own logo/Terms
            attribution (both bottom corners). z-index above the map panes. */}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label="Expand map"
          title="Expand map"
          className="absolute right-2 top-2 z-[1000] rounded-md bg-panel p-1.5 text-text-muted shadow-md hover:opacity-80"
        >
          <Maximize2 size={14} />
        </button>
      </div>

      {pending && (
        <div className="mt-2">
          <PendingActions
            pending={pending}
            onConfirm={confirmPending}
            onCancel={() => setPending(null)}
          />
        </div>
      )}

      {expanded && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Choose a location on the map"
          className="fixed inset-0 z-[2000] flex bg-black/60 p-4 sm:p-8"
        >
          <div className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-panel text-text">
            <div className="flex shrink-0 items-center justify-between gap-4 px-4 py-2.5">
              <span className="text-sm text-text-muted">
                Click to drop a pin, drag it to adjust.
              </span>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-text-muted hover:opacity-75"
              >
                <X size={15} />
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <PickerMap
                tileStyle={tileStyle}
                contextPin={pin}
                pending={pending}
                onPlace={placePending}
              />
            </div>
            <div className="flex min-h-12 shrink-0 items-center px-4 py-2.5">
              {pending ? (
                <PendingActions
                  pending={pending}
                  onConfirm={confirmPending}
                  onCancel={() => setPending(null)}
                />
              ) : (
                <span className="text-xs text-text-muted">
                  No pin placed yet.
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
