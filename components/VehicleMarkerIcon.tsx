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
}) {
  const statusColor =
    tintColor ?? (isLive ? 'var(--color-live)' : 'var(--color-text-muted)');
  return (
    <div
      className={
        isLive ? 'vehicle-marker vehicle-marker--live' : 'vehicle-marker'
      }
    >
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
