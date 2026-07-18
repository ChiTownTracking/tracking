'use client';

import dynamic from 'next/dynamic';
import { ArrowDown, ArrowUp, Check, Plus, Trash2 } from 'lucide-react';
import { parseManualLocation } from '@/lib/manualLocationInput';
import type { GeocodeCandidate } from '@/lib/orsClient';
import { redirectIfSessionExpired } from '@/lib/sessionExpiry';
import type { Theme } from '@/lib/useTheme';
import { stopInputClass } from './formStyles';

// The stop-picking UI, extracted verbatim from create-link so standalone
// Route creation reuses the exact same component: manual-trigger search
// (ORS quota is metered — never per-keystroke), pin-drop, and pasted
// coordinates/Plus Code, all requiring an explicit confirmation. The only
// addition is the optional per-stop dwell-minutes input (showDwellMinutes),
// which Routes use and tracking links don't.

// Maps JS needs window — same Client Component + ssr:false requirement as
// every map in this codebase.
const StopPinMap = dynamic(() => import('@/components/StopPinMap'), {
  ssr: false,
  loading: () => (
    <div className="flex h-44 items-center justify-center rounded-md border border-white/10 text-xs text-text-muted">
      Loading map…
    </div>
  ),
});

// Phase J4a: ONE provider around the whole stop list — several stops can
// show their pin maps at once, and each <APIProvider> instance loading the
// Maps JS script redundantly is a known footgun. Every StopPinMap below
// (compact and fullscreen alike) shares this single script load.
const GoogleMapsProvider = dynamic(
  () => import('@/components/GoogleMapsProvider'),
  { ssr: false },
);

// One waypoint being built. `resolved` + `label` (+ `dwellMinutes` where
// shown) are what survives into the submitted waypoints array;
// query/candidates/search state are UI-only scratch and never leave the
// browser.
export interface StopEntry {
  id: string;
  query: string;
  searching: boolean;
  searchError: string | null;
  candidates: GeocodeCandidate[] | null;
  resolved: { lat: number; lng: number; sourceLabel: string } | null;
  label: string;
  // This stop's last confirmed point, kept through "Choose again" so the
  // pin map re-opens with visual context instead of a blank Chicago view.
  lastPin: { lat: number; lng: number } | null;
  // Pasted "lat, lng" or Plus Code — the third resolution path.
  manualInput: string;
  manualError: string | null;
  // Minutes the vehicle waits at this stop. Only rendered (and only
  // submitted) by consumers that pass showDwellMinutes.
  dwellMinutes: number;
}

export function makeStop(): StopEntry {
  return {
    id: crypto.randomUUID(),
    query: '',
    searching: false,
    searchError: null,
    candidates: null,
    resolved: null,
    label: '',
    lastPin: null,
    manualInput: '',
    manualError: null,
    // Suggested default — editable per stop where the input is shown.
    dwellMinutes: 2,
  };
}

function matchTypeColor(matchType: string): string {
  if (matchType === 'exact') {
    return 'var(--color-live)';
  }
  if (matchType === 'fallback') {
    return 'var(--color-alert)';
  }
  return 'var(--color-text-muted)';
}

export default function StopListEditor({
  stops,
  setStops,
  tileStyle,
  showDwellMinutes = false,
}: {
  stops: StopEntry[];
  // Functional updates only — async handlers (search) patch state after an
  // await and must never clobber concurrent edits.
  setStops: (updater: (current: StopEntry[]) => StopEntry[]) => void;
  tileStyle: Theme;
  showDwellMinutes?: boolean;
}) {
  function updateStop(stopId: string, patch: Partial<StopEntry>) {
    setStops((current) =>
      current.map((stop) =>
        stop.id === stopId ? { ...stop, ...patch } : stop,
      ),
    );
  }

  function addStop() {
    setStops((current) => [...current, makeStop()]);
  }

  function removeStop(stopId: string) {
    setStops((current) => current.filter((stop) => stop.id !== stopId));
  }

  function moveStop(stopId: string, delta: -1 | 1) {
    setStops((current) => {
      const index = current.findIndex((stop) => stop.id === stopId);
      const target = index + delta;
      if (index === -1 || target < 0 || target >= current.length) {
        return current;
      }
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  // Deliberately manual-trigger only (button / Enter), never per-keystroke:
  // ORS's free tier is a metered daily quota.
  async function searchStop(stopId: string) {
    const stop = stops.find((entry) => entry.id === stopId);
    if (!stop || stop.query.trim().length === 0) {
      return;
    }
    updateStop(stopId, {
      searching: true,
      searchError: null,
      candidates: null,
    });
    try {
      const res = await fetch('/api/internal/geocode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: stop.query }),
      });
      if (redirectIfSessionExpired(res.status)) {
        return;
      }
      const body = await res.json();
      if (!res.ok) {
        updateStop(stopId, {
          searching: false,
          searchError:
            typeof body.error === 'string' ? body.error : 'Search failed',
        });
        return;
      }
      updateStop(stopId, { searching: false, candidates: body });
    } catch {
      updateStop(stopId, {
        searching: false,
        searchError: 'Search failed — please try again.',
      });
    }
  }

  function chooseCandidate(stopId: string, candidate: GeocodeCandidate) {
    updateStop(stopId, {
      resolved: {
        lat: candidate.lat,
        lng: candidate.lng,
        sourceLabel: candidate.label,
      },
      label: candidate.label,
      candidates: null,
    });
  }

  // The "drop a pin" path: resolves the stop exactly like a candidate click,
  // except there's no ORS label to pre-fill (no reverse-geocoding on
  // purpose — it would add another metered ORS dependency), so the label
  // starts empty and the blank-label validation makes staff name it. The
  // manual coordinates/Plus Code path funnels through here too.
  function pinStop(stopId: string, lat: number, lng: number) {
    updateStop(stopId, {
      resolved: {
        lat,
        lng,
        sourceLabel: `Pinned at ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      },
      label: '',
      candidates: null,
      manualError: null,
    });
  }

  // Third path: pasted "lat, lng" or Plus Code, parsed offline — no ORS
  // call, no quota.
  function applyManualLocation(stopId: string) {
    const stop = stops.find((entry) => entry.id === stopId);
    if (!stop || stop.manualInput.trim().length === 0) {
      return;
    }
    const parsed = parseManualLocation(stop.manualInput);
    if (!parsed) {
      updateStop(stopId, {
        manualError: "Couldn't read that as coordinates or a Plus Code",
      });
      return;
    }
    pinStop(stopId, parsed.lat, parsed.lng);
  }

  return (
    <GoogleMapsProvider>
      {stops.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {stops.map((stop, index) => (
            <li
              key={stop.id}
              className="rounded-md border border-white/10 bg-panel p-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wider text-text-muted">
                  Stop {index + 1}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveStop(stop.id, -1)}
                    disabled={index === 0}
                    aria-label={`Move stop ${index + 1} up`}
                    title="Move up"
                    className="rounded-md p-1 text-text-muted hover:opacity-75 disabled:opacity-30"
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveStop(stop.id, 1)}
                    disabled={index === stops.length - 1}
                    aria-label={`Move stop ${index + 1} down`}
                    title="Move down"
                    className="rounded-md p-1 text-text-muted hover:opacity-75 disabled:opacity-30"
                  >
                    <ArrowDown size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeStop(stop.id)}
                    aria-label={`Remove stop ${index + 1}`}
                    title="Remove stop"
                    className="rounded-md p-1 hover:opacity-75"
                    style={{ color: 'var(--color-alert)' }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {stop.resolved ? (
                <div className="mt-2">
                  <div
                    className="flex items-center gap-1.5 text-xs"
                    style={{ color: 'var(--color-live)' }}
                  >
                    <Check size={14} className="shrink-0" />
                    <span className="min-w-0 truncate">
                      {stop.resolved.sourceLabel}
                    </span>
                  </div>
                  <label className="mt-2 block">
                    <span className="mb-1.5 block text-sm text-text-muted">
                      Label
                    </span>
                    <input
                      type="text"
                      value={stop.label}
                      onChange={(event) =>
                        updateStop(stop.id, { label: event.target.value })
                      }
                      placeholder="Name this stop"
                      aria-label={`Label for stop ${index + 1}`}
                      className={stopInputClass}
                    />
                  </label>
                  {showDwellMinutes && (
                    <label className="mt-2 block">
                      <span className="mb-1.5 block text-sm text-text-muted">
                        Dwell time (minutes at this stop)
                      </span>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={stop.dwellMinutes}
                        onChange={(event) =>
                          updateStop(stop.id, {
                            dwellMinutes: Math.max(
                              0,
                              Math.floor(Number(event.target.value) || 0),
                            ),
                          })
                        }
                        aria-label={`Dwell minutes for stop ${index + 1}`}
                        className={`${stopInputClass} w-28`}
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      updateStop(stop.id, {
                        resolved: null,
                        candidates: null,
                        lastPin: stop.resolved
                          ? {
                              lat: stop.resolved.lat,
                              lng: stop.resolved.lng,
                            }
                          : stop.lastPin,
                      })
                    }
                    className="mt-2 text-xs text-text-muted underline-offset-2 hover:underline"
                  >
                    Choose again
                  </button>
                </div>
              ) : (
                <div className="mt-2">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={stop.query}
                      onChange={(event) =>
                        updateStop(stop.id, { query: event.target.value })
                      }
                      onKeyDown={(event) => {
                        // Enter searches this stop; never submit the whole
                        // form from here.
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          searchStop(stop.id);
                        }
                      }}
                      placeholder="Search an address or venue…"
                      aria-label={`Search location for stop ${index + 1}`}
                      className={`flex-1 ${stopInputClass}`}
                    />
                    <button
                      type="button"
                      onClick={() => searchStop(stop.id)}
                      disabled={
                        stop.searching || stop.query.trim().length === 0
                      }
                      className="shrink-0 rounded-md border border-white/10 px-3 py-2 text-sm text-text hover:bg-white/5 disabled:opacity-50"
                    >
                      {stop.searching ? 'Searching…' : 'Search'}
                    </button>
                  </div>

                  {stop.searchError && (
                    <p
                      className="mt-2 text-sm"
                      style={{ color: 'var(--color-alert)' }}
                    >
                      {stop.searchError}
                    </p>
                  )}

                  {stop.candidates && stop.candidates.length === 0 && (
                    <p className="mt-2 text-sm text-text-muted">
                      No matches — try a different search.
                    </p>
                  )}

                  {stop.candidates && stop.candidates.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-1">
                      {stop.candidates.map((candidate, candidateIndex) => (
                        <li key={candidateIndex}>
                          <button
                            type="button"
                            onClick={() => chooseCandidate(stop.id, candidate)}
                            className="w-full rounded-md border border-white/10 px-3 py-2 text-left hover:bg-white/5"
                          >
                            <span className="block text-sm font-medium">
                              {candidate.label}
                            </span>
                            <span className="mt-0.5 block text-xs text-text-muted">
                              <span
                                style={{
                                  color: matchTypeColor(candidate.matchType),
                                }}
                              >
                                {candidate.matchType}
                              </span>
                              {' · confidence '}
                              {candidate.confidence}
                              {candidate.distanceKm !== null && (
                                <>
                                  {' · '}
                                  {candidate.distanceKm.toFixed(1)} km from the
                                  Loop
                                </>
                              )}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="mt-3 flex gap-2">
                    <input
                      type="text"
                      value={stop.manualInput}
                      onChange={(event) =>
                        updateStop(stop.id, {
                          manualInput: event.target.value,
                          manualError: null,
                        })
                      }
                      onKeyDown={(event) => {
                        // Enter applies this stop's manual entry; never
                        // submit the whole form from here.
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          applyManualLocation(stop.id);
                        }
                      }}
                      placeholder="Or paste coordinates or a Plus Code"
                      aria-label={`Coordinates or Plus Code for stop ${index + 1}`}
                      className={`flex-1 ${stopInputClass}`}
                    />
                    <button
                      type="button"
                      onClick={() => applyManualLocation(stop.id)}
                      disabled={stop.manualInput.trim().length === 0}
                      className="shrink-0 rounded-md border border-white/10 px-3 py-2 text-sm text-text hover:bg-white/5 disabled:opacity-50"
                    >
                      Use this
                    </button>
                  </div>

                  {stop.manualError && (
                    <p
                      className="mt-2 text-sm"
                      style={{ color: 'var(--color-alert)' }}
                    >
                      {stop.manualError}
                    </p>
                  )}

                  <p className="mb-1.5 mt-3 text-xs text-text-muted">
                    Or click a location on the map:
                  </p>
                  <StopPinMap
                    tileStyle={tileStyle}
                    pin={stop.lastPin}
                    onPick={(lat, lng) => pinStop(stop.id, lat, lng)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={addStop}
        className="mt-2 flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-sm text-text-muted hover:bg-white/5"
      >
        <Plus size={14} />
        Add stop
      </button>
    </GoogleMapsProvider>
  );
}
