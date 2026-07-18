// Shared Google-map camera helpers for the vis.gl map components
// (Phase J4d — extracted when the third component needed them). Browser-only
// by nature (window + the loaded Maps JS `google` global); callers invoke
// these inside effects where a non-null map instance proves both exist.

export function boundsOf(
  points: { lat: number; lng: number }[],
): google.maps.LatLngBounds {
  const bounds = new google.maps.LatLngBounds();
  for (const point of points) {
    bounds.extend(point);
  }
  return bounds;
}

// fitBounds that honors prefers-reduced-motion as closely as Google's API
// allows. Leaflet took animate:false directly; google.maps.Map.fitBounds
// has no such option — it always animates. The workaround: after calling
// fitBounds, listen ONCE for the map's 'idle' event (Google fires it when
// the camera movement it just started has fully settled) and re-assert the
// final zoom/center via setZoom/setCenter, which are always instant. The
// glide still technically begins, but the idle snap lands the camera on its
// final values in one frame instead of letting the animation play out — the
// closest achievable approximation to animate:false. Under normal motion
// preferences this is a plain fitBounds.
export function fitBoundsRespectingReducedMotion(
  map: google.maps.Map,
  points: { lat: number; lng: number }[],
  padding: number,
): void {
  map.fitBounds(boundsOf(points), padding);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    google.maps.event.addListenerOnce(map, 'idle', () => {
      const zoom = map.getZoom();
      const center = map.getCenter();
      if (zoom !== undefined) {
        map.setZoom(zoom);
      }
      if (center) {
        map.setCenter(center);
      }
    });
  }
}
