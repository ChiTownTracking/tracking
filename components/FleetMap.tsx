'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AdvancedMarker,
  InfoWindow,
  Map as GoogleMap,
  useAdvancedMarkerRef,
  useMap,
} from '@vis.gl/react-google-maps';
import type { Vehicle } from '@/lib/liveVehicles';
import { fitBoundsRespectingReducedMotion } from '@/lib/mapCamera';
import { getStatusLabel, isVehicleLive } from '@/lib/vehicleStatus';
import { VehicleMarkerContent } from './VehicleMarkerIcon';

// Phase J4d: the last Leaflet component, converted to
// @vis.gl/react-google-maps — this closes out the map migration. Same
// conversion pattern as StopPinMap/TrackMap/BoardMap; expects the page to
// wrap it in the ONE shared GoogleMapsProvider.

interface FleetMapProps {
  vehicles: Vehicle[];
  selectedVehicleId: string | null;
}

const CHICAGO_CENTER = { lat: 41.95, lng: -87.9 };

type MapStyle = 'dark' | 'light';

// Staff cloud-styled map IDs — replaces the CARTO dark_all/light_all tile
// URLs, driven by the same in-map Dark/Light toggle as before. (Google
// renders its own required attribution; the manual OSM/CARTO credit is gone
// with the tiles.)
const MAP_IDS: Record<MapStyle, string> = {
  dark: '31dfa4afbe1fa578d2690926',
  light: '31dfa4afbe1fa578f1ed110a',
};

const FIT_PADDING = 40;

// Sidebar-selection zoom floor, same as the Leaflet flyTo's Math.max(zoom, 15).
const SELECT_MIN_ZOOM = 15;

// Fits the full fleet once on first data. Single-vehicle guard: fitBounds
// on one point zooms to street level, so a lone reporting vehicle gets the
// established vehicle zoom instead (TrackMap's centerMapOnVehicles rule).
function InitialFitController({ vehicles }: { vehicles: Vehicle[] }) {
  const map = useMap();
  const hasFitInitially = useRef(false);

  useEffect(() => {
    if (!map || hasFitInitially.current || vehicles.length === 0) {
      return;
    }
    if (vehicles.length === 1) {
      map.setZoom(14);
      map.setCenter({
        lat: vehicles[0].latitude,
        lng: vehicles[0].longitude,
      });
    } else {
      fitBoundsRespectingReducedMotion(
        map,
        vehicles.map((v) => ({ lat: v.latitude, lng: v.longitude })),
        FIT_PADDING,
      );
    }
    hasFitInitially.current = true;
  }, [map, vehicles]);

  return null;
}

// Sidebar selection: pan/zoom to the vehicle (the popup opening is handled
// by the parent's openPopupId state — a single value, so the previously
// selected vehicle's popup closes on its own; with clustered vehicles an
// old open popup would make the new selection ambiguous).
function SelectionController({
  vehicles,
  selectedVehicleId,
}: FleetMapProps) {
  const map = useMap();

  useEffect(() => {
    if (!map || !selectedVehicleId) {
      return;
    }
    const vehicle = vehicles.find((v) => v.vehicleId === selectedVehicleId);
    if (!vehicle) {
      return;
    }
    map.setZoom(Math.max(map.getZoom() ?? 0, SELECT_MIN_ZOOM));
    map.panTo({ lat: vehicle.latitude, lng: vehicle.longitude });
  }, [selectedVehicleId, vehicles, map]);

  return null;
}

function FleetVehicleMarker({
  vehicle,
  open,
  onOpen,
  onClose,
}: {
  vehicle: Vehicle;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const [markerRef, marker] = useAdvancedMarkerRef();

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={{ lat: vehicle.latitude, lng: vehicle.longitude }}
        onClick={onOpen}
      >
        <div style={{ transform: 'translateY(50%)' }}>
          <VehicleMarkerContent
            heading={vehicle.heading}
            isLive={isVehicleLive(vehicle.lastUpdatedAt)}
          />
        </div>
      </AdvancedMarker>
      {open && (
        <InfoWindow anchor={marker} onCloseClick={onClose}>
          <div style={{ color: '#1f2937' }}>
            <strong>{vehicle.registrationNumber}</strong>
            <br />
            {vehicle.locationText}
            <br />
            {getStatusLabel(vehicle.speed, vehicle.lastUpdatedAt)}
          </div>
        </InfoWindow>
      )}
    </>
  );
}

export default function FleetMap({ vehicles, selectedVehicleId }: FleetMapProps) {
  // Independent of the app-wide chrome theme on purpose: a light dashboard
  // with a dark map (or vice versa) is a legitimate combination.
  const [mapStyle, setMapStyle] = useState<MapStyle>('light');
  // Which vehicle's popup is open — one value, so opening any popup
  // (marker tap or sidebar selection) closes the previous one.
  const [openPopupId, setOpenPopupId] = useState<string | null>(null);

  // A sidebar selection opens that vehicle's popup, same as the Leaflet
  // openPopup call did (the SelectionController handles the camera).
  useEffect(() => {
    if (selectedVehicleId) {
      setOpenPopupId(selectedVehicleId);
    }
  }, [selectedVehicleId]);

  return (
    <div className="relative h-full w-full">
      <GoogleMap
        mapId={MAP_IDS[mapStyle]}
        // Placeholder until the first fleet payload; the
        // InitialFitController fits the real fleet as soon as data exists.
        defaultCenter={CHICAGO_CENTER}
        defaultZoom={11}
        // Same chrome decisions as every prior conversion: no Google
        // map-type/street-view/fullscreen buttons, zoom control kept, no
        // POI cards hijacking clicks on a dispatch map.
        disableDefaultUI
        zoomControl
        clickableIcons={false}
        className="h-full w-full"
      >
        {vehicles.map((vehicle) => (
          <FleetVehicleMarker
            key={vehicle.vehicleId}
            vehicle={vehicle}
            open={openPopupId === vehicle.vehicleId}
            onOpen={() => setOpenPopupId(vehicle.vehicleId)}
            onClose={() => setOpenPopupId(null)}
          />
        ))}
        <InitialFitController vehicles={vehicles} />
        <SelectionController
          vehicles={vehicles}
          selectedVehicleId={selectedVehicleId}
        />
      </GoogleMap>
      {/* Top-right: clear of the zoom control and Google's own logo/Terms
          attribution (both bottom corners). z-index above the map panes. */}
      <div className="absolute right-3 top-3 z-[1000] flex overflow-hidden rounded-md bg-panel text-xs shadow-md">
        {(['dark', 'light'] as const).map((style) => (
          <button
            key={style}
            type="button"
            onClick={() => setMapStyle(style)}
            aria-pressed={mapStyle === style}
            className="px-2.5 py-1.5 font-medium"
            style={
              mapStyle === style
                ? { background: 'var(--color-accent)', color: '#ffffff' }
                : { color: 'var(--color-text-muted)' }
            }
          >
            {style === 'dark' ? 'Dark' : 'Light'}
          </button>
        ))}
      </div>
    </div>
  );
}
