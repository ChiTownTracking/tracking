'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { Locate, MapPin } from 'lucide-react';
import {
  AdvancedMarker,
  InfoWindow,
  Map,
  useAdvancedMarkerRef,
  useMap,
} from '@vis.gl/react-google-maps';
import type { Vehicle } from '@/lib/liveVehicles';
import {
  boundsOf,
  fitBoundsRespectingReducedMotion,
} from '@/lib/mapCamera';
import { ROUTE_COLORS } from '@/lib/routeColors';
import type { StoredRoute, Waypoint } from '@/lib/trackingTokens';
import { trackFetcher } from '@/lib/trackFetcher';
import { getStatusLabel, isVehicleLive } from '@/lib/vehicleStatus';
import RoutePolyline from './RoutePolyline';
import ScheduleTimeline from './ScheduleTimeline';
import { VehicleMarkerContent } from './VehicleMarkerIcon';

// Phase J4b: rendering converted from react-leaflet/CARTO to
// @vis.gl/react-google-maps. Every accumulated behavior (continuous follow,
// drag-suspend, tab-switch view reset, mode-aware centering, null-heading
// badge omission, reduced-motion handling) survives unchanged — only the
// rendering technology underneath moved. Expects the page to wrap it in the
// ONE shared GoogleMapsProvider; this component never creates its own.
//
// Phase E3b: this component renders at most ONE route. E2's in-page route
// selector (a NamedRoute[] response plus selectedRouteIndex tabs) was
// deliberately removed, not lost to a refactor: switching routes now means
// navigating to a different /track/[token]/[routeIndex] URL, so the
// multi-route model lives in the bare page's directory, not in client state
// here. The route fields below arrive only from the per-route endpoint; the
// bare endpoint's active response (no-routes links) simply omits them.
type TrackResponse =
  | { status: 'not_started' | 'ended'; message: string }
  | {
      status: 'active';
      customerName: string;
      vehicles: Vehicle[];
      // The route's own name (per-route endpoint only) — unused here since
      // the surrounding tab/page already identifies the leg, but part of
      // the response contract.
      name?: string;
      waypoints?: Waypoint[];
      route?: StoredRoute;
      schedule?: string[];
    };

// Distinct per-vehicle highlight colors for the multi-vehicle case: each
// map ring and its legend dot share a color so nearby vehicles stay
// distinguishable. Same palette the public board colors its routes with
// (lib/routeColors.ts) — one "distinguish by color" system app-wide.
const HIGHLIGHT_COLORS = ROUTE_COLORS;

// Customer theme's cloud-styled map ID — this component only ever renders
// inside the .customer-theme context, so there is no dark/light toggle here.
const CUSTOMER_MAP_ID = '31dfa4afbe1fa57821160c7b';

const FIT_PADDING = 40;

function centerMapOnVehicles(map: google.maps.Map, vehicles: Vehicle[]) {
  if (vehicles.length === 0) {
    return;
  }
  if (vehicles.length === 1) {
    map.setZoom(14);
    map.setCenter({
      lat: vehicles[0].latitude,
      lng: vehicles[0].longitude,
    });
  } else {
    map.fitBounds(
      boundsOf(vehicles.map((v) => ({ lat: v.latitude, lng: v.longitude }))),
      FIT_PADDING,
    );
  }
}

function centerMapOnRoute(map: google.maps.Map, geometry: [number, number][]) {
  if (geometry.length === 0) {
    return;
  }
  map.fitBounds(
    boundsOf(geometry.map(([lat, lng]) => ({ lat, lng }))),
    FIT_PADDING,
  );
}

// Continuous-follow variant of centerMapOnVehicles. Two deliberate
// differences from the click path: a single vehicle pans at the current
// zoom, so a 30-second follow pan never snaps the customer's zoom back to
// 14; and the pan honors prefers-reduced-motion — the same preference the
// status-ring pulse respects in globals.css — by jumping (setCenter, which
// Google never animates) instead of panTo's glide. The multi-vehicle
// branch honors it too, via the shared idle-snap fitBounds (the J4d
// backport that closed the gap parked at J4b).
function followVehicles(map: google.maps.Map, vehicles: Vehicle[]) {
  const animate = !window.matchMedia('(prefers-reduced-motion: reduce)')
    .matches;
  if (vehicles.length === 1) {
    const position = {
      lat: vehicles[0].latitude,
      lng: vehicles[0].longitude,
    };
    if (animate) {
      map.panTo(position);
    } else {
      map.setCenter(position);
    }
  } else {
    fitBoundsRespectingReducedMotion(
      map,
      vehicles.map((v) => ({ lat: v.latitude, lng: v.longitude })),
      FIT_PADDING,
    );
  }
}

type CenterMode = 'vehicle' | 'route';

// A recenter request: the seq bump triggers it, the mode is snapshotted at
// click time so a later poll can't reinterpret it.
interface RecenterCommand {
  seq: number;
  mode: CenterMode;
}

function ViewController({
  vehicles,
  centerMode,
  recenterCommand,
  routeGeometry,
  routeIndex,
}: {
  vehicles: Vehicle[];
  centerMode: CenterMode;
  recenterCommand: RecenterCommand | null;
  routeGeometry: [number, number][] | null;
  routeIndex?: number;
}) {
  const map = useMap();
  // Fresh-view centering happens exactly once per view: on first data, and
  // again on each routeIndex change (see the reset effect below). After
  // that, Vehicle mode follows each poll (the follow effect), and Route
  // mode moves only via the recenter control — a route never moves.
  const hasCenteredInitially = useRef(false);
  // A user-initiated drag suspends following so the map doesn't fight a
  // customer looking around; an explicit "Center: Vehicle" click clears it.
  const followSuspended = useRef(false);

  // Switching tabs must behave like a fresh view. This matters exactly when
  // the new route's data comes straight from the SWR cache: the map then
  // stays MOUNTED and would silently keep the previous route's camera with
  // new data drawn into it (the reported bug) — an uncached switch unmounts
  // through the loading notice and resets naturally. A drag on route A also
  // must not leave route B's follow suspended before anyone panned it.
  // Declared BEFORE the centering/follow effects so the reset lands first
  // within the same commit.
  const viewResetFor = useRef(routeIndex);
  useEffect(() => {
    if (viewResetFor.current !== routeIndex) {
      viewResetFor.current = routeIndex;
      hasCenteredInitially.current = false;
      followSuspended.current = false;
    }
  }, [routeIndex]);

  useEffect(() => {
    if (!map) {
      return;
    }
    // Google fires 'dragstart' only for user drags, never for programmatic
    // pans (same contract as Leaflet's) — our own follow pans can't suspend
    // themselves.
    const suspendFollow = () => {
      followSuspended.current = true;
    };
    const listener = map.addListener('dragstart', suspendFollow);
    return () => listener.remove();
  }, [map]);

  // Fresh-view centering, fitting whichever mode is active: on first mount
  // that is always Vehicle (the default), but a tab switch while in Route
  // mode should fit the NEW route's bounds, not jump to the vehicle.
  useEffect(() => {
    if (!map || hasCenteredInitially.current) {
      return;
    }
    if (centerMode === 'route' && routeGeometry && routeGeometry.length > 0) {
      centerMapOnRoute(map, routeGeometry);
      hasCenteredInitially.current = true;
      return;
    }
    if (vehicles.length === 0) {
      return;
    }
    centerMapOnVehicles(map, vehicles);
    hasCenteredInitially.current = true;
  }, [vehicles, routeGeometry, centerMode, map]);

  // Continuous follow — the Vehicle-mode contract: whenever a poll delivers
  // new positions while Vehicle mode is active, pan to them. Keyed on the
  // vehicles array itself (SWR only produces a new one when data changed).
  useEffect(() => {
    if (
      !map ||
      centerMode !== 'vehicle' ||
      followSuspended.current ||
      vehicles.length === 0
    ) {
      return;
    }
    followVehicles(map, vehicles);
  }, [vehicles, centerMode, map]);

  // The recenter control uses current positions without re-triggering on
  // every poll: vehicles/geometry live in refs, only the command drives the
  // effect.
  const vehiclesRef = useRef(vehicles);
  vehiclesRef.current = vehicles;
  const routeGeometryRef = useRef(routeGeometry);
  useEffect(() => {
    routeGeometryRef.current = routeGeometry;
  }, [routeGeometry]);

  useEffect(() => {
    if (!map || !recenterCommand) {
      return;
    }
    if (recenterCommand.mode === 'route' && routeGeometryRef.current) {
      centerMapOnRoute(map, routeGeometryRef.current);
    } else {
      // An explicit vehicle recenter also resumes continuous following
      // after a manual drag suspended it.
      followSuspended.current = false;
      centerMapOnVehicles(map, vehiclesRef.current);
    }
  }, [recenterCommand, map]);

  return null;
}

// Stop marker: lucide MapPin (same iconography family as Bus/Navigation2 in
// VehicleMarkerContent) with a small sequence badge in its corner. Colors
// live in globals.css (.waypoint-marker__*) so the accent token resolves.
// AdvancedMarker's default bottom-center anchoring already puts the
// teardrop's tip on the waypoint. Tap opens the full label — each marker
// owns its InfoWindow state, same as the Leaflet per-marker Popup.
function WaypointMarker({
  waypoint,
  sequence,
}: {
  waypoint: Waypoint;
  sequence: number;
}) {
  const [markerRef, marker] = useAdvancedMarkerRef();
  const [open, setOpen] = useState(false);

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={{ lat: waypoint.lat, lng: waypoint.lng }}
        onClick={() => setOpen(true)}
      >
        <div className="waypoint-marker">
          <MapPin className="waypoint-marker__pin" size={28} />
          <span className="waypoint-marker__badge">{sequence}</span>
        </div>
      </AdvancedMarker>
      {open && (
        <InfoWindow anchor={marker} onCloseClick={() => setOpen(false)}>
          <div style={{ color: '#1f2937' }}>
            <strong>Stop {sequence}</strong>
            <br />
            {waypoint.label}
          </div>
        </InfoWindow>
      )}
    </>
  );
}

// Vehicle marker: same Bus + status ring + heading badge as always (shared
// VehicleMarkerContent — the badge renders only when a heading is actually
// present, never a fake default direction). The 40px content is centered on
// the position via translateY(50%), matching the old iconAnchor [20, 20].
function VehicleMarker({ vehicle }: { vehicle: Vehicle }) {
  const [markerRef, marker] = useAdvancedMarkerRef();
  const [open, setOpen] = useState(false);

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={{ lat: vehicle.latitude, lng: vehicle.longitude }}
        onClick={() => setOpen(true)}
      >
        <div style={{ transform: 'translateY(50%)' }}>
          <VehicleMarkerContent
            heading={vehicle.heading}
            isLive={isVehicleLive(vehicle.lastUpdatedAt)}
          />
        </div>
      </AdvancedMarker>
      {open && (
        <InfoWindow anchor={marker} onCloseClick={() => setOpen(false)}>
          <div style={{ color: '#1f2937' }}>
            <strong>{vehicle.registrationNumber}</strong>
            <br />
            {getStatusLabel(vehicle.speed, vehicle.lastUpdatedAt)}
          </div>
        </InfoWindow>
      )}
    </>
  );
}

function formatMiles(distanceMeters: number): string {
  return `${(distanceMeters / 1609.344).toFixed(1)} miles`;
}

function formatDuration(durationSeconds: number): string {
  const totalMinutes = Math.max(1, Math.round(durationSeconds / 60));
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mx-auto max-w-xl rounded-xl p-8 text-center"
      style={{ background: 'var(--color-panel)', color: 'var(--color-text-muted)' }}
    >
      {children}
    </div>
  );
}

export default function TrackMap({
  token,
  routeIndex,
  onCustomerName,
}: {
  token: string;
  // When set, polls the per-route endpoint instead of the bare one. The
  // server is the authority on index validity — a bad value just 404s into
  // the same not_found notice as a bad token.
  routeIndex?: number;
  // Lets the page's header show the customer's name while this component
  // stays the single owner of the SWR subscription — same pattern as
  // DashboardShell's onVehiclesUpdate.
  onCustomerName?: (name: string) => void;
}) {
  const { data, error, isLoading } = useSWR<TrackResponse>(
    routeIndex == null
      ? `/api/track/${token}`
      : `/api/track/${token}/${routeIndex}`,
    trackFetcher,
    { refreshInterval: 30_000 },
  );

  const activeCustomerName =
    data?.status === 'active' ? data.customerName : null;
  useEffect(() => {
    if (activeCustomerName) {
      onCustomerName?.(activeCustomerName);
    }
  }, [activeCustomerName, onCustomerName]);

  if (isLoading) {
    return <Notice>Loading your trip…</Notice>;
  }
  if (error) {
    return (
      <Notice>
        {error.message === 'not_found'
          ? 'This tracking link is no longer available. Please contact ChiTown Trolley if you believe this is a mistake.'
          : 'We had trouble loading your trip. Retrying automatically…'}
      </Notice>
    );
  }
  if (!data) {
    return null;
  }
  if (data.status !== 'active') {
    return <Notice>{data.message}</Notice>;
  }

  const { vehicles, customerName } = data;
  if (vehicles.length === 0) {
    return (
      <Notice>
        No vehicles are reporting a position yet — check back shortly.
      </Notice>
    );
  }

  const single = vehicles.length === 1;

  return (
    <TrackMapContent
      vehicles={vehicles}
      customerName={customerName}
      single={single}
      routeIndex={routeIndex}
      waypoints={data.waypoints ?? null}
      route={data.route ?? null}
      schedule={data.schedule ?? null}
    />
  );
}

export function TrackMapContent({
  vehicles,
  customerName,
  single,
  routeIndex,
  waypoints,
  route,
  schedule,
}: {
  vehicles: Vehicle[];
  customerName: string;
  single: boolean;
  routeIndex?: number;
  waypoints: Waypoint[] | null;
  route: StoredRoute | null;
  schedule: string[] | null;
}) {
  const [centerMode, setCenterMode] = useState<CenterMode>('vehicle');
  const [recenterCommand, setRecenterCommand] =
    useState<RecenterCommand | null>(null);

  function requestRecenter(mode: CenterMode) {
    setCenterMode(mode);
    setRecenterCommand((current) => ({ seq: (current?.seq ?? 0) + 1, mode }));
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      {single ? (
        <div>
          <p
            className="text-xs font-medium uppercase tracking-widest"
            style={{ color: 'var(--color-accent)' }}
          >
            Vehicle {vehicles[0].registrationNumber}
          </p>
          <h1 className="customer-heading mt-1 text-2xl">
            {vehicles[0].locationText}
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--color-text-muted)' }}>
            {getStatusLabel(vehicles[0].speed, vehicles[0].lastUpdatedAt)}
          </p>
        </div>
      ) : (
        <h1 className="customer-heading text-2xl">{customerName}</h1>
      )}

      <div
        className="relative h-[420px] overflow-hidden rounded-xl"
        style={{ background: 'var(--color-panel)' }}
      >
        <Map
          mapId={CUSTOMER_MAP_ID}
          defaultCenter={{
            lat: vehicles[0].latitude,
            lng: vehicles[0].longitude,
          }}
          defaultZoom={13}
          // Drop Google's map-type/street-view/fullscreen buttons — they
          // don't fit the app's minimal design; zoom control stays. Default
          // gestureHandling on purpose (unlike StopPinMap's 'cooperative'):
          // this map IS the page's primary content, not a compact widget
          // inside a long form, so scroll-to-zoom isn't fighting page
          // scroll. A tap must always interact with OUR markers, never
          // open a Google POI card — hence clickableIcons off.
          disableDefaultUI
          zoomControl
          clickableIcons={false}
          className="h-full w-full"
        >
          {route && (
            <>
              <RoutePolyline geometry={route.geometry} />
              {waypoints?.map((waypoint, index) => (
                <WaypointMarker
                  key={`waypoint-${index}-${waypoint.lat}-${waypoint.lng}`}
                  waypoint={waypoint}
                  sequence={index + 1}
                />
              ))}
            </>
          )}
          {vehicles.map((vehicle, index) => (
            <Fragment key={vehicle.vehicleId}>
              {!single && (
                // Screen-space highlight ring (the old Leaflet CircleMarker,
                // radius 22): a fixed 44px circle centered on the vehicle,
                // non-interactive so the bus marker keeps the tap.
                <AdvancedMarker
                  position={{
                    lat: vehicle.latitude,
                    lng: vehicle.longitude,
                  }}
                >
                  <span
                    style={{
                      display: 'block',
                      width: 44,
                      height: 44,
                      borderRadius: 9999,
                      border: `2px solid ${
                        HIGHLIGHT_COLORS[index % HIGHLIGHT_COLORS.length]
                      }`,
                      transform: 'translateY(50%)',
                      pointerEvents: 'none',
                    }}
                  />
                </AdvancedMarker>
              )}
              <VehicleMarker vehicle={vehicle} />
            </Fragment>
          ))}
          <ViewController
            vehicles={vehicles}
            centerMode={centerMode}
            recenterCommand={recenterCommand}
            routeGeometry={route ? route.geometry : null}
            routeIndex={routeIndex}
          />
        </Map>
        {/* Top-right: clear of the zoom control and Google's own logo/Terms
            attribution (both bottom corners). In Vehicle mode the map also
            follows the poll on its own; this control recenters immediately,
            switches modes, and resumes following after a manual drag. With
            a route, a Vehicle/Route segmented control; without one, today's
            single recenter button. */}
        {route ? (
          <div className="absolute right-3 top-3 z-[1000] flex overflow-hidden rounded-md text-xs shadow-md"
            style={{ background: 'var(--color-panel)' }}
          >
            {(['vehicle', 'route'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => requestRecenter(mode)}
                aria-pressed={centerMode === mode}
                className="px-2.5 py-1.5 font-medium"
                style={
                  centerMode === mode
                    ? { background: 'var(--color-accent)', color: '#ffffff' }
                    : { color: 'var(--color-text-muted)' }
                }
              >
                {mode === 'vehicle' ? 'Center: Vehicle' : 'Center: Route'}
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => requestRecenter('vehicle')}
            aria-label="Re-center map on vehicles"
            title="Re-center map"
            className="absolute right-3 top-3 z-[1000] rounded-md p-2 shadow-md"
            style={{
              background: 'var(--color-panel)',
              color: 'var(--color-text)',
            }}
          >
            <Locate size={16} />
          </button>
        )}
      </div>

      {route && (
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Planned route: {formatMiles(route.distanceMeters)} · about{' '}
          {formatDuration(route.durationSeconds)}
        </p>
      )}

      {route && schedule && schedule.length > 0 && (
        <ScheduleTimeline
          schedule={schedule}
          durationSeconds={route.durationSeconds}
        />
      )}

      {!single && (
        <ul
          className="flex flex-col gap-2 rounded-xl p-4"
          style={{ background: 'var(--color-panel)' }}
        >
          {vehicles.map((vehicle, index) => (
            <li key={vehicle.vehicleId} className="flex items-center gap-2.5 text-sm">
              <span
                className="inline-block h-3 w-3 shrink-0 rounded-full"
                style={{
                  background: HIGHLIGHT_COLORS[index % HIGHLIGHT_COLORS.length],
                }}
              />
              <span className="font-medium">{vehicle.registrationNumber}</span>
              <span style={{ color: 'var(--color-text-muted)' }}>
                {getStatusLabel(vehicle.speed, vehicle.lastUpdatedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
