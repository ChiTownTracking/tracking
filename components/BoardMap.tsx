'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { Locate, MapPin } from 'lucide-react';
// Map aliased: this component also uses the plain JS Map for routeNameById,
// which vis.gl's <Map> import would otherwise shadow.
import {
  AdvancedMarker,
  InfoWindow,
  Map as GoogleMap,
  useAdvancedMarkerRef,
  useMap,
} from '@vis.gl/react-google-maps';
import { fitBoundsRespectingReducedMotion } from '@/lib/mapCamera';
import { getRouteColor } from '@/lib/routeColors';
import RoutePolyline from './RoutePolyline';
import { VehicleMarkerContent } from './VehicleMarkerIcon';

// Phase J4c: rendering converted from react-leaflet/CARTO to
// @vis.gl/react-google-maps, same conversion pattern as TrackMap (J4b).
// This is the multi-vehicle SHARED view: fit-everything once on first data,
// one-shot per-vehicle centering on click, and deliberately NO continuous
// follow anywhere — auto-tracking one moving vehicle would fight anyone
// watching a different one. Expects the page to wrap it in the ONE shared
// GoogleMapsProvider; this component never creates its own.

// The map's own prop contract — the /trip page adapts the public trip
// detail into these shapes. The shape lives in one place client-side.
export interface BoardRouteSummary {
  id: string;
  name: string;
  geometry: [number, number][];
  stops: { label: string; lat: number; lng: number }[];
}

export interface BoardTripSummary {
  id: string;
  routeId: string;
  vehicleLabel: string;
  position: { lat: number; lng: number; headingDegrees: number | null } | null;
  positionConfident: boolean | null;
  speedMph: number | null;
  nextStopIndex: number | null;
  stopEtas: { arrival: string | null; departure: string | null }[] | null;
}

// Customer theme's cloud-styled map ID — same as TrackMap, this only ever
// renders in the customer-facing context.
const CUSTOMER_MAP_ID = '31dfa4afbe1fa57821160c7b';

const FIT_PADDING = 40;

// Everything on the board at once: every route's geometry plus every
// currently-known vehicle position. Plain points, not a LatLngBounds —
// this runs during render, before the Maps JS script is guaranteed loaded;
// the ViewController builds the real bounds inside effects, where a
// non-null map proves google.* exists.
function boardPoints(
  routes: BoardRouteSummary[],
  trips: BoardTripSummary[],
): { lat: number; lng: number }[] {
  const points: { lat: number; lng: number }[] = [];
  for (const route of routes) {
    for (const [lat, lng] of route.geometry) {
      points.push({ lat, lng });
    }
  }
  for (const trip of trips) {
    if (trip.position) {
      points.push({ lat: trip.position.lat, lng: trip.position.lng });
    }
  }
  return points;
}

// TrackMap's single-vehicle centering zoom, reused for the per-trip Center
// action here.
const FOCUS_ZOOM = 14;

// Unlike TrackMap's ViewController there is no follow mode at all: with
// several vehicles moving independently there's no one coherent "the"
// vehicle to follow — even a focused trip is centered ONCE per click, never
// followed on poll (continuous follow would fight anyone watching a
// different vehicle on this shared view). Fit-everything happens once on
// first data, then only on explicit clicks — a manual pan is never fought.
function ViewController({
  points,
  recenterSeq,
  focusSeq,
  focusPosition,
}: {
  points: { lat: number; lng: number }[];
  recenterSeq: number;
  focusSeq: number;
  focusPosition: { lat: number; lng: number } | null;
}) {
  const map = useMap();
  const hasCenteredInitially = useRef(false);

  // Bounds fits honor prefers-reduced-motion via the shared idle-snap
  // fitBounds (lib/mapCamera) — the J4d backport that closed the gap
  // parked at J4c.
  useEffect(() => {
    if (!map || hasCenteredInitially.current || points.length === 0) {
      return;
    }
    fitBoundsRespectingReducedMotion(map, points, FIT_PADDING);
    hasCenteredInitially.current = true;
  }, [points, map]);

  // Both click-driven moves read CURRENT data without re-triggering on
  // every poll: the targets live in refs (synced in effects — never written
  // during render), only the click sequences drive the move effects. Same
  // command pattern as TrackMap's RecenterCommand.
  const pointsRef = useRef(points);
  useEffect(() => {
    pointsRef.current = points;
  }, [points]);
  const focusPositionRef = useRef(focusPosition);
  useEffect(() => {
    focusPositionRef.current = focusPosition;
  }, [focusPosition]);

  useEffect(() => {
    if (!map || recenterSeq === 0 || pointsRef.current.length === 0) {
      return;
    }
    fitBoundsRespectingReducedMotion(map, pointsRef.current, FIT_PADDING);
  }, [recenterSeq, map]);

  useEffect(() => {
    const position = focusPositionRef.current;
    if (!map || focusSeq === 0 || !position) {
      return;
    }
    // Same mechanics as TrackMap's single-vehicle centering, one-shot: jump
    // to the established vehicle zoom, then pan — a glide normally, an
    // instant setCenter under prefers-reduced-motion (a single-point move
    // CAN honor it, unlike the fitBounds paths above).
    const animate = !window.matchMedia('(prefers-reduced-motion: reduce)')
      .matches;
    map.setZoom(FOCUS_ZOOM);
    if (animate) {
      map.panTo(position);
    } else {
      map.setCenter(position);
    }
  }, [focusSeq, map]);

  return null;
}

// Stop marker tinted to its route's color so a stop visually reads as
// belonging to a specific line — inline fill/color win over the
// .waypoint-marker__* token rules in globals.css, same as the old Leaflet
// DivIcon did. Tap opens the full label; each marker owns its InfoWindow
// state (the TrackMap WaypointMarker pattern, plus the tint).
function TintedWaypointMarker({
  stop,
  sequence,
  color,
  routeName,
}: {
  stop: { label: string; lat: number; lng: number };
  sequence: number;
  color: string;
  routeName: string;
}) {
  const [markerRef, marker] = useAdvancedMarkerRef();
  const [open, setOpen] = useState(false);

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={{ lat: stop.lat, lng: stop.lng }}
        onClick={() => setOpen(true)}
      >
        <div className="waypoint-marker">
          <MapPin
            className="waypoint-marker__pin"
            size={28}
            style={{ fill: color }}
          />
          <span
            className="waypoint-marker__badge"
            style={{ color, borderColor: color }}
          >
            {sequence}
          </span>
        </div>
      </AdvancedMarker>
      {open && (
        <InfoWindow anchor={marker} onCloseClick={() => setOpen(false)}>
          <div style={{ color: '#1f2937' }}>
            <strong>{stop.label}</strong>
            <br />
            {routeName}
          </div>
        </InfoWindow>
      )}
    </>
  );
}

// Vehicle marker in the vehicle's own palette color; only ever rendered
// with a real position (the caller skips dark vehicles entirely). Same
// translateY(50%) centering as TrackMap's vehicle marker.
function BoardVehicleMarker({
  trip,
  color,
  routeName,
}: {
  trip: BoardTripSummary & {
    position: NonNullable<BoardTripSummary['position']>;
  };
  color: string;
  routeName: string;
}) {
  const [markerRef, marker] = useAdvancedMarkerRef();
  const [open, setOpen] = useState(false);

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={{ lat: trip.position.lat, lng: trip.position.lng }}
        onClick={() => setOpen(true)}
      >
        <div style={{ transform: 'translateY(50%)' }}>
          <VehicleMarkerContent
            heading={trip.position.headingDegrees}
            // The board response carries no freshness timestamp, so no
            // live-pulse claim is made; the route tint is the identity.
            isLive={false}
            tintColor={color}
          />
        </div>
      </AdvancedMarker>
      {open && (
        <InfoWindow anchor={marker} onCloseClick={() => setOpen(false)}>
          <div style={{ color: '#1f2937' }}>
            <strong>{trip.vehicleLabel}</strong>
            <br />
            {routeName}
          </div>
        </InfoWindow>
      )}
    </>
  );
}

export default function BoardMap({
  routes,
  trips,
  focusCommand,
  onClearFocus,
}: {
  routes: BoardRouteSummary[];
  trips: BoardTripSummary[];
  // A per-trip Center request from the trip cards: the seq bump triggers it
  // (re-clickable anytime), tripId picks the vehicle. null = nothing
  // focused.
  focusCommand: { seq: number; tripId: string } | null;
  // Fired when the fit-everything control is clicked — the page clears its
  // focused-card highlight in response, since fit-everything is the reset.
  onClearFocus: () => void;
}) {
  const [recenterSeq, setRecenterSeq] = useState(0);
  const routeNameById = new Map(routes.map((route) => [route.id, route.name]));
  const points = boardPoints(routes, trips);

  const focusedTrip = focusCommand
    ? trips.find((trip) => trip.id === focusCommand.tripId)
    : undefined;
  const focusPosition = focusedTrip?.position
    ? { lat: focusedTrip.position.lat, lng: focusedTrip.position.lng }
    : null;

  return (
    <div
      className="relative h-[320px] overflow-hidden rounded-xl sm:h-[420px]"
      style={{ background: 'var(--color-panel)' }}
    >
      <GoogleMap
        mapId={CUSTOMER_MAP_ID}
        // Chicago Loop placeholder; the ViewController fits the real bounds
        // as soon as data exists.
        defaultCenter={{ lat: 41.8781, lng: -87.6298 }}
        defaultZoom={12}
        // Same chrome decisions as every prior conversion: no Google
        // map-type/street-view/fullscreen buttons, zoom control kept, and
        // no POI cards hijacking taps on a live-updating board.
        disableDefaultUI
        zoomControl
        clickableIcons={false}
        className="h-full w-full"
      >
        {routes.map((route, routeIndex) => (
          <RoutePolyline
            key={route.id}
            geometry={route.geometry}
            color={getRouteColor(routeIndex)}
          />
        ))}
        {routes.map((route, routeIndex) => {
          const color = getRouteColor(routeIndex);
          return route.stops.map((stop, stopIndex) => (
            <TintedWaypointMarker
              key={`${route.id}-stop-${stopIndex}`}
              stop={stop}
              sequence={stopIndex + 1}
              color={color}
              routeName={route.name}
            />
          ));
        })}
        {trips.map((trip, tripIndex) => {
          // No live position: no marker at all — never a fake/default spot.
          const position = trip.position;
          if (!position) {
            return null;
          }
          // Colored by VEHICLE (position in the trips array), not by route:
          // one trip holds one route but many vehicles now, and the color
          // is what ties a marker to its card.
          const color = getRouteColor(tripIndex);
          return (
            <Fragment key={trip.id}>
              {/* The "this is the one you picked" signal: the focused
                  trip's marker gets a ring in its own color — the exact
                  non-interactive fixed-circle treatment TrackMap uses for
                  its multi-vehicle highlight rings. */}
              {focusCommand?.tripId === trip.id && (
                <AdvancedMarker
                  position={{ lat: position.lat, lng: position.lng }}
                >
                  <span
                    style={{
                      display: 'block',
                      width: 44,
                      height: 44,
                      borderRadius: 9999,
                      border: `2px solid ${color}`,
                      transform: 'translateY(50%)',
                      pointerEvents: 'none',
                    }}
                  />
                </AdvancedMarker>
              )}
              <BoardVehicleMarker
                trip={{ ...trip, position }}
                color={color}
                routeName={routeNameById.get(trip.routeId) ?? ''}
              />
            </Fragment>
          );
        })}
        <ViewController
          points={points}
          recenterSeq={recenterSeq}
          focusSeq={focusCommand?.seq ?? 0}
          focusPosition={focusPosition}
        />
      </GoogleMap>
      <button
        type="button"
        onClick={() => {
          // Fit-everything is the reset: it also clears any per-trip focus.
          onClearFocus();
          setRecenterSeq((seq) => seq + 1);
        }}
        aria-label="Re-center map on all routes and vehicles"
        title="Re-center map"
        className="absolute right-3 top-3 z-[1000] rounded-md p-2 shadow-md"
        style={{
          background: 'var(--color-panel)',
          color: 'var(--color-text)',
        }}
      >
        <Locate size={16} />
      </button>
    </div>
  );
}
