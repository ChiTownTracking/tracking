'use client';

import { useEffect } from 'react';
import { useMap } from '@vis.gl/react-google-maps';

// A route's polyline on a Google map, shared by TrackMap and BoardMap
// (Phase J4c — extracted the moment a second component needed it). vis.gl
// has no Polyline component, so this drives google.maps.Polyline
// imperatively. Google writes stroke colors as literal values (no var()
// resolution the way Leaflet's SVG + .route-line stylesheet rule allowed),
// so when no explicit color is passed the accent token is resolved to its
// concrete color from the map container, which inherits the theme scope
// (TrackMap's case; BoardMap passes each route's own palette color).
export default function RoutePolyline({
  geometry,
  color,
}: {
  geometry: [number, number][];
  color?: string;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map) {
      return;
    }
    const strokeColor =
      color ??
      getComputedStyle(map.getDiv()).getPropertyValue('--color-accent').trim();
    const line = new google.maps.Polyline({
      path: geometry.map(([lat, lng]) => ({ lat, lng })),
      strokeColor,
      strokeOpacity: 0.85,
      strokeWeight: 4,
      map,
    });
    return () => line.setMap(null);
  }, [map, geometry, color]);

  return null;
}
