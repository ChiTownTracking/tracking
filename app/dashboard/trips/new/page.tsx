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

// Phase I2: THE creation flow for the collapsed Trip model — one form, one
// POST: name + stops (the trip's one physical path), then any number of
// vehicle blocks, each with its own run rows (arrival + pickup wait). One
// /trip/[token] link comes back; there is no separate route link anymore.

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (redirectIfSessionExpired(res.status)) {
    throw new Error('Session expired');
  }
  if (!res.ok) {
    throw new Error(`request failed (${res.status})`);
  }
  return res.json();
}

// One run row as edited: waitMinutes stays a raw string until submit so the
// input never fights the user mid-typing; validation names bad values.
interface RunRow {
  key: string;
  arrivalTime: string;
  waitMinutes: string;
}

interface VehicleBlock {
  key: string;
  vehicleId: string | null;
  query: string;
  runs: RunRow[];
}

function makeRun(): RunRow {
  return { key: crypto.randomUUID(), arrivalTime: '', waitMinutes: '0' };
}

function makeVehicleBlock(): VehicleBlock {
  return {
    key: crypto.randomUUID(),
    vehicleId: null,
    query: '',
    runs: [makeRun()],
  };
}

function parseWaitMinutes(raw: string): number | null {
  if (raw.trim() === '') {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// "07:05" + 25 → "07:30": the computed departure staff see live next to
// their own inputs, so nobody does clock math in their head. Wraps past
// midnight the same way the schedule status logic would read it.
function computeDeparture(arrivalTime: string, waitRaw: string): string | null {
  const wait = parseWaitMinutes(waitRaw);
  if (!/^\d{2}:\d{2}$/.test(arrivalTime) || wait === null) {
    return null;
  }
  const [hours, minutes] = arrivalTime.split(':').map(Number);
  const total = (hours * 60 + minutes + wait) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(
    total % 60,
  ).padStart(2, '0')}`;
}

// Client-side mirror of createTripInputSchema (the server still enforces
// it). First problem wins — one clear, named message at a time; never a
// silently disabled button.
function findBlocker(
  name: string,
  windowStart: string,
  windowEnd: string,
  stops: StopEntry[],
  vehicles: VehicleBlock[],
): string | null {
  if (name.trim().length === 0) {
    return 'The trip needs a name.';
  }
  if (windowStart === '' || windowEnd === '') {
    return 'Set a tracking window (start and end).';
  }
  // Same end-after-start rule the server's schema enforces (and create-link
  // mirrors client-side).
  if (new Date(windowEnd).getTime() <= new Date(windowStart).getTime()) {
    return 'Window end must be after window start.';
  }
  if (stops.some((stop) => stop.resolved === null)) {
    return 'Every stop must be confirmed to a location (or removed) before saving.';
  }
  if (stops.length < 2) {
    return 'A trip needs at least 2 stops.';
  }
  if (
    stops.some(
      (stop) => stop.resolved !== null && stop.label.trim().length === 0,
    )
  ) {
    return 'Every stop needs a label.';
  }
  if (vehicles.length === 0) {
    return 'Add at least one vehicle.';
  }
  for (const [index, block] of vehicles.entries()) {
    const position = `Vehicle ${index + 1}`;
    if (block.vehicleId === null) {
      return `${position} needs a vehicle selected.`;
    }
    if (block.runs.length === 0) {
      return `${position} needs at least one departure time.`;
    }
    if (block.runs.some((run) => run.arrivalTime.trim() === '')) {
      return `${position}: every arrival time needs a value (or remove the empty row).`;
    }
    if (block.runs.some((run) => parseWaitMinutes(run.waitMinutes) === null)) {
      return `${position}: wait minutes must be a whole number of 0 or more.`;
    }
  }
  return null;
}

export default function NewTripPage() {
  // Applies the persisted app theme on this page too; the pin maps follow it.
  const { theme } = useTheme();

  const { data: roster, error: rosterError, isLoading: rosterLoading } =
    useSWR('/api/internal/roster', fetchJson<RosterVehicle[]>);

  const [name, setName] = useState('');
  // Lazy initializers: "now" through "now + 7 days" computed once at mount,
  // in the render that creates the state — never a useEffect that could
  // re-run and clobber a manual edit. Same pattern as create-link.
  const [windowStart, setWindowStart] = useState(defaultWindowStart);
  const [windowEnd, setWindowEnd] = useState(() => defaultWindowEnd(24 * 7));
  const [stops, setStops] = useState<StopEntry[]>([]);
  // Start with one open vehicle block — the form's whole point is
  // assigning at least one vehicle.
  const [vehicles, setVehicles] = useState<VehicleBlock[]>([
    makeVehicleBlock(),
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const blocker = findBlocker(name, windowStart, windowEnd, stops, vehicles);

  function updateBlock(key: string, patch: Partial<VehicleBlock>) {
    setVehicles((current) =>
      current.map((block) =>
        block.key === key ? { ...block, ...patch } : block,
      ),
    );
  }

  function updateRun(blockKey: string, runKey: string, patch: Partial<RunRow>) {
    setVehicles((current) =>
      current.map((block) =>
        block.key === blockKey
          ? {
              ...block,
              runs: block.runs.map((run) =>
                run.key === runKey ? { ...run, ...patch } : run,
              ),
            }
          : block,
      ),
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setResultUrl(null);
    setCopied(false);
    setSubmitting(true);
    try {
      const res = await fetch('/api/internal/trips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          // datetime-local values are timezone-less; normalize to UTC ISO
          // so the server stores an absolute window (same as create-link).
          windowStart: new Date(windowStart).toISOString(),
          windowEnd: new Date(windowEnd).toISOString(),
          // Search state stays client-side; only the confirmed essentials
          // are submitted.
          waypoints: stops.flatMap((stop) =>
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
          vehicles: vehicles.map((block) => ({
            vehicleId: block.vehicleId,
            schedule: block.runs.map((run) => ({
              arrivalTime: run.arrivalTime,
              waitMinutes: parseWaitMinutes(run.waitMinutes) ?? 0,
            })),
          })),
        }),
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
      // The link panel, right here — staff never go hunting for the URL.
      setResultUrl(`${window.location.origin}${body.tripPath}`);
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
        <h2 className="font-heading text-xl font-medium">New trip</h2>
        <p className="mt-1 text-sm text-text-muted">
          One route, any number of vehicles, each on its own departure
          schedule — you get a shareable link when it saves.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-5">
          <label className="block">
            <span className="mb-1.5 block text-sm text-text-muted">Name</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              placeholder="North Shore Run"
              className={fieldInputClass}
            />
          </label>

          <div>
            <span className="mb-1.5 block text-sm text-text-muted">
              Tracking window
            </span>
            <p className="mb-2 text-xs text-text-muted">
              When the public trip link is live — before it starts and after
              it ends, the link shows a status message instead of the map.
            </p>
            {/* Stacked below sm: datetime-local inputs have a large intrinsic
                min-width and can't share a 375px row. */}
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
          </div>

          <div>
            <span className="mb-1.5 block text-sm text-text-muted">Stops</span>
            <p className="mb-2 text-xs text-text-muted">
              Search a location, click the map, or paste coordinates — every
              stop needs an explicit confirmation, nothing is chosen
              automatically.
            </p>
            <StopListEditor
              stops={stops}
              setStops={(updater) => setStops((current) => updater(current))}
              tileStyle={theme}
            />
          </div>

          <div>
            <span className="mb-1.5 block text-sm text-text-muted">
              Vehicles
            </span>
            <div className="flex flex-col gap-4">
              {vehicles.map((block, blockIndex) => (
                <fieldset
                  key={block.key}
                  className="rounded-md border border-white/10 p-3"
                >
                  <legend className="flex items-center gap-2 px-1 text-sm text-text-muted">
                    Vehicle {blockIndex + 1}
                    <button
                      type="button"
                      onClick={() =>
                        setVehicles((current) =>
                          current.filter((entry) => entry.key !== block.key),
                        )
                      }
                      aria-label={`Remove vehicle ${blockIndex + 1}`}
                      title="Remove vehicle"
                      className="rounded-md p-1 hover:opacity-75"
                      style={{ color: 'var(--color-alert)' }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </legend>

                  <VehiclePicker
                    roster={roster}
                    isLoading={rosterLoading}
                    loadFailed={Boolean(rosterError)}
                    query={block.query}
                    onQueryChange={(query) => updateBlock(block.key, { query })}
                    selected={
                      new Set(block.vehicleId === null ? [] : [block.vehicleId])
                    }
                    onToggle={(id) =>
                      updateBlock(block.key, {
                        vehicleId: block.vehicleId === id ? null : id,
                      })
                    }
                    searchLabel={`Search vehicles for vehicle ${blockIndex + 1}`}
                  />

                  <div className="mt-3">
                    <span className="mb-1.5 block text-xs text-text-muted">
                      Departures (arrival at first stop + wait before leaving)
                    </span>
                    <ul className="flex flex-col gap-2">
                      {block.runs.map((run, runIndex) => {
                        const departure = computeDeparture(
                          run.arrivalTime,
                          run.waitMinutes,
                        );
                        return (
                          <li
                            key={run.key}
                            className="flex flex-wrap items-center gap-2"
                          >
                            <input
                              type="time"
                              value={run.arrivalTime}
                              onChange={(event) =>
                                updateRun(block.key, run.key, {
                                  arrivalTime: event.target.value,
                                })
                              }
                              aria-label={`Vehicle ${blockIndex + 1} arrival time ${runIndex + 1}`}
                              className={`${fieldInputClass} w-auto`}
                            />
                            <label className="flex items-center gap-1.5 text-xs text-text-muted">
                              wait
                              <input
                                type="number"
                                min={0}
                                step={1}
                                value={run.waitMinutes}
                                onChange={(event) =>
                                  updateRun(block.key, run.key, {
                                    waitMinutes: event.target.value,
                                  })
                                }
                                aria-label={`Vehicle ${blockIndex + 1} wait minutes ${runIndex + 1}`}
                                className={`${fieldInputClass} w-16`}
                              />
                              min
                            </label>
                            {/* Staff see the result of their own inputs
                                immediately — no head math. */}
                            <span className="font-mono text-xs text-text-muted">
                              {departure ? `→ departs ${departure}` : ''}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                setVehicles((current) =>
                                  current.map((entry) =>
                                    entry.key === block.key
                                      ? {
                                          ...entry,
                                          runs: entry.runs.filter(
                                            (r) => r.key !== run.key,
                                          ),
                                        }
                                      : entry,
                                  ),
                                )
                              }
                              aria-label={`Remove vehicle ${blockIndex + 1} departure ${runIndex + 1}`}
                              title="Remove departure"
                              className="rounded-md p-1 hover:opacity-75"
                              style={{ color: 'var(--color-alert)' }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <button
                      type="button"
                      onClick={() =>
                        updateBlock(block.key, {
                          runs: [...block.runs, makeRun()],
                        })
                      }
                      className="mt-2 flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-sm text-text-muted hover:bg-white/5"
                    >
                      <Plus size={14} />
                      Add a departure time
                    </button>
                  </div>
                </fieldset>
              ))}
            </div>
            <button
              type="button"
              onClick={() =>
                setVehicles((current) => [...current, makeVehicleBlock()])
              }
              className="mt-3 flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-sm text-text-muted hover:bg-white/5"
            >
              <Plus size={14} />
              Add another vehicle
            </button>
          </div>

          {blocker && <p className="text-sm text-text-muted">{blocker}</p>}
          {formError && (
            <p className="text-sm" style={{ color: 'var(--color-alert)' }}>
              {formError}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || blocker !== null}
            className="self-start rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--color-accent)' }}
          >
            {submitting ? 'Creating…' : 'Create trip & get link'}
          </button>
        </form>

        {resultUrl && (
          <div className="mt-6 rounded-md bg-panel p-4">
            <p className="mb-2 text-sm text-text-muted">
              Link ready — anyone holding it can follow this trip live:
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
                aria-label="Copy trip link"
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
