'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { Check, Copy, Plus, Trash2 } from 'lucide-react';
import DashboardNav from '@/components/DashboardNav';
import { fieldInputClass } from '@/components/formStyles';
import StopListEditor, { type StopEntry } from '@/components/StopListEditor';
import VehiclePicker from '@/components/VehiclePicker';
import {
  defaultWindowEnd,
  defaultWindowStart,
} from '@/lib/datetimeLocalDefault';
import type { RosterVehicle } from '@/lib/vehicleRoster';
import { redirectIfSessionExpired } from '@/lib/sessionExpiry';
import { useTheme } from '@/lib/useTheme';

async function fetcher(url: string): Promise<RosterVehicle[]> {
  const res = await fetch(url);
  if (redirectIfSessionExpired(res.status)) {
    throw new Error('Session expired');
  }
  if (!res.ok) {
    throw new Error(`roster request failed (${res.status})`);
  }
  return res.json();
}

// StopEntry/makeStop and the whole stop-picking UI live in
// components/StopListEditor.tsx (extracted for reuse by standalone Route
// creation in Phase F2).

// One named route block: its own vehicles and time window, its own stop
// list, plus optional daily departure times ("HH:mm" straight from
// <input type="time">).
interface RouteEntry {
  id: string;
  name: string;
  vehicleIds: ReadonlySet<string>;
  vehicleQuery: string;
  // datetime-local strings, normalized to UTC ISO at submit (same
  // convention as the top-level window).
  windowStart: string;
  windowEnd: string;
  stops: StopEntry[];
  schedule: string[];
}

// Client-side mirror of createLinkInputSchema's route rules, so these never
// reach the server in normal use (the server still enforces them). First
// problem wins — one clear message at a time.
function findRouteBlocker(routes: RouteEntry[]): string | null {
  for (const [index, route] of routes.entries()) {
    const label =
      route.name.trim().length > 0 ? route.name.trim() : `Route ${index + 1}`;
    if (route.name.trim().length === 0) {
      return `Route ${index + 1} needs a name.`;
    }
    if (route.vehicleIds.size === 0) {
      return `${label}: select at least 1 vehicle.`;
    }
    if (route.windowStart === '' || route.windowEnd === '') {
      return `${label}: set a time window.`;
    }
    if (
      new Date(route.windowEnd).getTime() <=
      new Date(route.windowStart).getTime()
    ) {
      return `${label}: window end must be after window start.`;
    }
    if (route.stops.some((stop) => stop.resolved === null)) {
      return `${label}: every stop must be confirmed to a location (or removed) before saving.`;
    }
    if (route.stops.length < 2) {
      return `${label}: a route needs at least 2 stops.`;
    }
    if (
      route.stops.some(
        (stop) => stop.resolved !== null && stop.label.trim().length === 0,
      )
    ) {
      return `${label}: every stop needs a label.`;
    }
    if (route.schedule.some((time) => time.trim().length === 0)) {
      return `${label}: every departure time needs a value (or remove the empty row).`;
    }
  }
  return null;
}

export default function CreateLinkPage() {
  // Applies the persisted app theme on this page too; the pin maps follow it.
  const { theme } = useTheme();

  const { data: roster, error: rosterError, isLoading } = useSWR(
    '/api/internal/roster',
    fetcher,
  );

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [vehicleQuery, setVehicleQuery] = useState('');
  const [customerName, setCustomerName] = useState('');
  // Lazy initializers: "now" and "now + 12h" computed once, at mount, in
  // the render that creates the state — never a useEffect that could
  // re-run and clobber a manual edit later.
  const [windowStart, setWindowStart] = useState(defaultWindowStart);
  const [windowEnd, setWindowEnd] = useState(() => defaultWindowEnd(12));
  const [routes, setRoutes] = useState<RouteEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function toggleVehicle(vehicleId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(vehicleId)) {
        next.delete(vehicleId);
      } else {
        next.add(vehicleId);
      }
      return next;
    });
  }

  function addRoute() {
    setRoutes((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        // Suggested default only — fully editable, same convention as
        // waypoint labels.
        name: `Route ${String.fromCharCode(65 + (current.length % 26))}`,
        vehicleIds: new Set<string>(),
        vehicleQuery: '',
        // Computed at the moment THIS block is created (not page load), so
        // a route added minutes into filling out the form starts near that
        // real time.
        windowStart: defaultWindowStart(),
        windowEnd: defaultWindowEnd(12),
        stops: [],
        schedule: [],
      },
    ]);
  }

  function toggleRouteVehicle(routeId: string, vehicleId: string) {
    setRoutes((current) =>
      current.map((route) => {
        if (route.id !== routeId) {
          return route;
        }
        const next = new Set(route.vehicleIds);
        if (next.has(vehicleId)) {
          next.delete(vehicleId);
        } else {
          next.add(vehicleId);
        }
        return { ...route, vehicleIds: next };
      }),
    );
  }

  function updateRoute(routeId: string, patch: Partial<RouteEntry>) {
    setRoutes((current) =>
      current.map((route) =>
        route.id === routeId ? { ...route, ...patch } : route,
      ),
    );
  }

  function removeRoute(routeId: string) {
    setRoutes((current) => current.filter((route) => route.id !== routeId));
  }

  function addDeparture(routeId: string) {
    setRoutes((current) =>
      current.map((route) =>
        route.id === routeId
          ? { ...route, schedule: [...route.schedule, ''] }
          : route,
      ),
    );
  }

  function updateDeparture(routeId: string, timeIndex: number, value: string) {
    setRoutes((current) =>
      current.map((route) =>
        route.id === routeId
          ? {
              ...route,
              schedule: route.schedule.map((time, index) =>
                index === timeIndex ? value : time,
              ),
            }
          : route,
      ),
    );
  }

  function removeDeparture(routeId: string, timeIndex: number) {
    setRoutes((current) =>
      current.map((route) =>
        route.id === routeId
          ? {
              ...route,
              schedule: route.schedule.filter((_, index) => index !== timeIndex),
            }
          : route,
      ),
    );
  }

  const routeBlocker = findRouteBlocker(routes);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setResultUrl(null);
    setCopied(false);
    setSubmitting(true);
    try {
      // Search state stays client-side. With any route blocks present, the
      // payload carries per-route vehicleIds/window and the top-level
      // versions are omitted entirely (meaningless in routes mode); with
      // zero blocks, today's simple top-level body, unchanged.
      const routesPayload =
        routes.length > 0 && findRouteBlocker(routes) === null
          ? routes.map((route) => ({
              name: route.name,
              vehicleIds: [...route.vehicleIds],
              // datetime-local values are timezone-less; normalize to UTC
              // ISO so the server compares absolute times.
              windowStart: route.windowStart
                ? new Date(route.windowStart).toISOString()
                : '',
              windowEnd: route.windowEnd
                ? new Date(route.windowEnd).toISOString()
                : '',
              waypoints: route.stops.flatMap((stop) =>
                stop.resolved
                  ? [
                      {
                        label: stop.label,
                        lat: stop.resolved.lat,
                        lng: stop.resolved.lng,
                      },
                    ]
                  : [],
              ),
              schedule: route.schedule,
            }))
          : null;

      const res = await fetch('/api/internal/create-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          routesPayload
            ? { customerName, routes: routesPayload }
            : {
                vehicleIds: [...selected],
                customerName,
                // datetime-local values are timezone-less; normalize to UTC
                // ISO so the server compares absolute times.
                windowStart: windowStart
                  ? new Date(windowStart).toISOString()
                  : '',
                windowEnd: windowEnd ? new Date(windowEnd).toISOString() : '',
              },
        ),
      });
      if (redirectIfSessionExpired(res.status)) {
        return;
      }
      const body = await res.json();
      if (!res.ok) {
        setFormError(
          typeof body.error === 'string' ? body.error : 'Request failed',
        );
        return;
      }
      setResultUrl(`${window.location.origin}${body.url}`);
    } catch {
      setFormError('Request failed — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function copyResult() {
    if (!resultUrl) {
      return;
    }
    await navigator.clipboard.writeText(resultUrl);
    setCopied(true);
  }

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <header className="flex shrink-0 items-center gap-6 bg-panel px-4 py-2">
        <h1 className="min-w-0 truncate font-heading text-lg font-medium">
          ChiTown Tracking — Fleet Dispatch
        </h1>
        <DashboardNav />
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 p-6">
        <h2 className="font-heading text-xl font-medium">
          Create tracking link
        </h2>

        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-5">
          {/* The moment any route block exists, vehicles and window are set
              per route — the top-level pickers are meaningless and hide. */}
          {routes.length === 0 && (
            <div>
              <span className="mb-1.5 block text-sm text-text-muted">
                Vehicles
              </span>
              <VehiclePicker
                roster={roster}
                isLoading={isLoading}
                loadFailed={Boolean(rosterError)}
                query={vehicleQuery}
                onQueryChange={setVehicleQuery}
                selected={selected}
                onToggle={toggleVehicle}
                searchLabel="Search vehicles"
              />
            </div>
          )}

          <label className="block">
            <span className="mb-1.5 block text-sm text-text-muted">
              Customer name
            </span>
            <input
              type="text"
              value={customerName}
              onChange={(event) => setCustomerName(event.target.value)}
              required
              placeholder="Smith Wedding"
              className={fieldInputClass}
            />
          </label>

          {routes.length === 0 ? (
            // Stacked below sm: datetime-local inputs have a large intrinsic
            // min-width and can't share a 375px row (Phase N1).
            <div className="flex flex-col gap-4 sm:flex-row">
              <label className="block flex-1">
                <span className="mb-1.5 block text-sm text-text-muted">
                  Window start
                </span>
                <input
                  type="datetime-local"
                  value={windowStart}
                  onChange={(event) => setWindowStart(event.target.value)}
                  required
                  className={fieldInputClass}
                />
              </label>
              <label className="block flex-1">
                <span className="mb-1.5 block text-sm text-text-muted">
                  Window end
                </span>
                <input
                  type="datetime-local"
                  value={windowEnd}
                  onChange={(event) => setWindowEnd(event.target.value)}
                  required
                  className={fieldInputClass}
                />
              </label>
            </div>
          ) : (
            <p className="text-sm text-text-muted">
              Vehicle and time window are set per route below.
            </p>
          )}

          <div>
            <span className="mb-1.5 block text-sm text-text-muted">
              Routes (optional)
            </span>
            <p className="mb-2 text-xs text-text-muted">
              Each route is an ordered list of stops with optional daily
              departure times. Search a location, click the map, or paste
              coordinates — every stop needs an explicit confirmation, nothing
              is chosen automatically.
            </p>

            {routes.length > 0 && (
              <ul className="flex flex-col gap-3">
                {routes.map((route, routeIndex) => (
                  <li
                    key={route.id}
                    className="rounded-md border border-white/10 p-3"
                  >
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 text-xs font-medium uppercase tracking-wider text-text-muted">
                        Route {routeIndex + 1}
                      </span>
                      <input
                        type="text"
                        value={route.name}
                        onChange={(event) =>
                          updateRoute(route.id, { name: event.target.value })
                        }
                        aria-label={`Name for route ${routeIndex + 1}`}
                        className={`flex-1 ${fieldInputClass}`}
                      />
                      <button
                        type="button"
                        onClick={() => removeRoute(route.id)}
                        aria-label={`Remove route ${routeIndex + 1}`}
                        title="Remove route"
                        className="shrink-0 rounded-md p-1.5 hover:opacity-75"
                        style={{ color: 'var(--color-alert)' }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>

                    <div className="mt-3">
                      <span className="mb-1.5 block text-sm text-text-muted">
                        Vehicles
                      </span>
                      <VehiclePicker
                        roster={roster}
                        isLoading={isLoading}
                        loadFailed={Boolean(rosterError)}
                        query={route.vehicleQuery}
                        onQueryChange={(value) =>
                          updateRoute(route.id, { vehicleQuery: value })
                        }
                        selected={route.vehicleIds}
                        onToggle={(vehicleId) =>
                          toggleRouteVehicle(route.id, vehicleId)
                        }
                        searchLabel={`Search vehicles for route ${routeIndex + 1}`}
                      />
                    </div>

                    <div className="mt-3 flex flex-col gap-4 sm:flex-row">
                      <label className="block flex-1">
                        <span className="mb-1.5 block text-sm text-text-muted">
                          Window start
                        </span>
                        <input
                          type="datetime-local"
                          value={route.windowStart}
                          onChange={(event) =>
                            updateRoute(route.id, {
                              windowStart: event.target.value,
                            })
                          }
                          aria-label={`Window start for route ${routeIndex + 1}`}
                          className={fieldInputClass}
                        />
                      </label>
                      <label className="block flex-1">
                        <span className="mb-1.5 block text-sm text-text-muted">
                          Window end
                        </span>
                        <input
                          type="datetime-local"
                          value={route.windowEnd}
                          onChange={(event) =>
                            updateRoute(route.id, {
                              windowEnd: event.target.value,
                            })
                          }
                          aria-label={`Window end for route ${routeIndex + 1}`}
                          className={fieldInputClass}
                        />
                      </label>
                    </div>

                    {/* The whole stop picker (search / pin-drop / pasted
                        coordinates) is shared with standalone Route creation
                        — see StopListEditor. Dwell inputs stay hidden here:
                        link waypoints have no dwell time. */}
                    <StopListEditor
                      stops={route.stops}
                      setStops={(updater) =>
                        setRoutes((current) =>
                          current.map((entry) =>
                            entry.id === route.id
                              ? { ...entry, stops: updater(entry.stops) }
                              : entry,
                          ),
                        )
                      }
                      tileStyle={theme}
                    />

                    <div className="mt-3">
                      <span className="mb-1.5 block text-sm text-text-muted">
                        Departure times
                      </span>
                      {route.schedule.length === 0 && (
                        <p className="text-xs text-text-muted">
                          No scheduled departures — optional.
                        </p>
                      )}
                      {route.schedule.length > 0 && (
                        <ul className="flex flex-col gap-2">
                          {route.schedule.map((time, timeIndex) => (
                            <li
                              key={timeIndex}
                              className="flex items-center gap-2"
                            >
                              <input
                                type="time"
                                value={time}
                                onChange={(event) =>
                                  updateDeparture(
                                    route.id,
                                    timeIndex,
                                    event.target.value,
                                  )
                                }
                                aria-label={`Departure time ${timeIndex + 1} for route ${routeIndex + 1}`}
                                className={`${fieldInputClass} w-auto`}
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  removeDeparture(route.id, timeIndex)
                                }
                                aria-label={`Remove departure time ${timeIndex + 1} for route ${routeIndex + 1}`}
                                title="Remove departure time"
                                className="rounded-md p-1 hover:opacity-75"
                                style={{ color: 'var(--color-alert)' }}
                              >
                                <Trash2 size={14} />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <button
                        type="button"
                        onClick={() => addDeparture(route.id)}
                        className="mt-2 flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-sm text-text-muted hover:bg-white/5"
                      >
                        <Plus size={14} />
                        Add departure time
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              onClick={addRoute}
              className="mt-2 flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-sm text-text-muted hover:bg-white/5"
            >
              <Plus size={14} />
              Add route
            </button>

            {routeBlocker && (
              <p className="mt-2 text-sm" style={{ color: 'var(--color-alert)' }}>
                {routeBlocker}
              </p>
            )}
          </div>

          {formError && (
            <p className="text-sm" style={{ color: 'var(--color-alert)' }}>
              {formError}
            </p>
          )}

          <button
            type="submit"
            disabled={
              submitting ||
              // Top-level vehicle selection only gates the no-routes mode;
              // in routes mode each route's own picker is checked by the
              // blocker instead.
              (routes.length === 0 && selected.size === 0) ||
              routeBlocker !== null
            }
            className="self-start rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--color-accent)' }}
          >
            {submitting ? 'Creating…' : 'Create link'}
          </button>
        </form>

        {resultUrl && (
          <div className="mt-6 rounded-md bg-panel p-4">
            <p className="mb-2 text-sm text-text-muted">
              Tracking link created — share it with the customer:
            </p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={resultUrl}
                onFocus={(event) => event.target.select()}
                className="w-full rounded-md border border-white/10 bg-bg px-3 py-2 font-mono text-sm text-text"
              />
              <button
                type="button"
                onClick={copyResult}
                aria-label="Copy tracking link"
                className="rounded-md p-2 text-text-muted hover:opacity-75"
              >
                {copied ? (
                  <Check size={16} color="var(--color-live)" />
                ) : (
                  <Copy size={16} />
                )}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
