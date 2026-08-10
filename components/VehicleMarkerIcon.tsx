import { Bus, Navigation2 } from 'lucide-react';

// The one vehicle-marker design, shared by every map (TrackMap, BoardMap,
// FleetMap — all rendering it directly as AdvancedMarker children since
// Phase J4). Styles live in globals.css (.vehicle-marker ...), including
// the reduced-motion fallback for the live pulse. The Leaflet DivIcon
// factory that used to live here was deleted with the last Leaflet map in
// Phase J4d.
export function VehicleMarkerContent({
  heading,
  isLive,
  tintColor,
  pickupStatus,
}: {
  // null = the source reported no heading; the direction badge is omitted
  // rather than drawn pointing a made-up way.
  heading: number | null;
  isLive: boolean;
  // Board map: tie the marker to its route's color (ring + heading badge).
  // Inline styles win over the globals.css ring rules, so the tint applies
  // in both live and idle states. Untinted callers get the classic
  // live-teal/muted treatment unchanged.
  tintColor?: string;
  // Phase P: where this vehicle is in its run, from the trip response's
  // stored markerStatus. OPTIONAL and undefined by default — the maps
  // without any pickup concept (FleetMap's fleet view, TrackMap's older
  // per-link data model) pass nothing and render exactly as they always
  // have. 'general' is explicitly the same as omitting it.
  pickupStatus?: 'at-pickup' | 'en-route' | 'general';
}) {
  const statusColor =
    tintColor ?? (isLive ? 'var(--color-live)' : 'var(--color-text-muted)');
  // Lifecycle state is a modifier ON TOP of the existing live/idle classes,
  // never a replacement — a caller can be both, and the styles compose.
  const className = [
    'vehicle-marker',
    isLive ? 'vehicle-marker--live' : null,
    pickupStatus === 'at-pickup' ? 'vehicle-marker--at-pickup' : null,
    pickupStatus === 'en-route' ? 'vehicle-marker--en-route' : null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={className}>
      <span
        className="vehicle-marker__ring"
        style={tintColor ? { borderColor: tintColor } : undefined}
      />
      {/* The bus stays upright — a rotated bus icon reads as tipped over,
          not turning. Only the heading badge below rotates. */}
      <Bus className="vehicle-marker__bus" size={18} color="var(--color-text)" />
      {heading !== null && (
        <Navigation2
          className="vehicle-marker__heading"
          size={12}
          color={statusColor}
          fill={statusColor}
          style={{ transform: `rotate(${heading}deg)` }}
        />
      )}
    </div>
  );
}
