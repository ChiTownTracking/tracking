'use client';

import { Plus, Trash2 } from 'lucide-react';
import { fieldInputClass } from '@/components/formStyles';
import VehiclePicker from '@/components/VehiclePicker';
import {
  computeDeparture,
  makeRun,
  type VehicleBlock,
} from '@/lib/vehicleBlock';
import type { RosterVehicle } from '@/lib/vehicleRoster';

// Phase O3: ONE vehicle assignment being composed — picker, card label, and
// the repeatable arrival/wait rows with their live departure preview.
// Extracted from the create-trip form when adding a vehicle to an existing
// trip needed the identical thing; the two callers differ only in what
// wraps this (create-trip puts each in a numbered, removable fieldset;
// the trip detail page shows exactly one).
//
// Deliberately controlled: all state lives in the caller's VehicleBlock, so
// whichever form owns it also owns validation and submission.
export default function VehicleScheduleBlock({
  block,
  onChange,
  roster,
  rosterLoading,
  rosterFailed,
  labelPrefix,
}: {
  block: VehicleBlock;
  onChange: (patch: Partial<VehicleBlock>) => void;
  roster: RosterVehicle[] | undefined;
  rosterLoading: boolean;
  rosterFailed: boolean;
  // Disambiguates the aria-labels when a page shows several blocks at once
  // (e.g. "Vehicle 2 arrival time 1").
  labelPrefix: string;
}) {
  return (
    <>
      <VehiclePicker
        roster={roster}
        isLoading={rosterLoading}
        loadFailed={rosterFailed}
        query={block.query}
        onQueryChange={(query) => onChange({ query })}
        selected={new Set(block.vehicleId === null ? [] : [block.vehicleId])}
        onToggle={(id) =>
          onChange({ vehicleId: block.vehicleId === id ? null : id })
        }
        searchLabel={`Search vehicles for ${labelPrefix.toLowerCase()}`}
      />

      <label className="mt-3 block">
        <span className="mb-1.5 block text-xs text-text-muted">
          Card label (optional)
        </span>
        <input
          type="text"
          value={block.cardLabel}
          onChange={(event) => onChange({ cardLabel: event.target.value })}
          maxLength={40}
          placeholder="Card label (optional) — e.g. Route A"
          aria-label={`Card label for ${labelPrefix.toLowerCase()}`}
          className={fieldInputClass}
        />
      </label>

      <div className="mt-3">
        <span className="mb-1.5 block text-xs text-text-muted">
          Departures (arrival at first stop + wait before leaving)
        </span>
        <ul className="flex flex-col gap-2">
          {block.runs.map((run, runIndex) => {
            const departure = computeDeparture(run.arrivalTime, run.waitMinutes);
            return (
              <li key={run.key} className="flex flex-wrap items-center gap-2">
                <input
                  type="time"
                  value={run.arrivalTime}
                  onChange={(event) =>
                    onChange({
                      runs: block.runs.map((entry) =>
                        entry.key === run.key
                          ? { ...entry, arrivalTime: event.target.value }
                          : entry,
                      ),
                    })
                  }
                  aria-label={`${labelPrefix} arrival time ${runIndex + 1}`}
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
                      onChange({
                        runs: block.runs.map((entry) =>
                          entry.key === run.key
                            ? { ...entry, waitMinutes: event.target.value }
                            : entry,
                        ),
                      })
                    }
                    aria-label={`${labelPrefix} wait minutes ${runIndex + 1}`}
                    className={`${fieldInputClass} w-16`}
                  />
                  min
                </label>
                {/* Staff see the result of their own inputs immediately —
                    no head math. */}
                <span className="font-mono text-xs text-text-muted">
                  {departure ? `→ departs ${departure}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      runs: block.runs.filter((entry) => entry.key !== run.key),
                    })
                  }
                  aria-label={`Remove ${labelPrefix.toLowerCase()} departure ${runIndex + 1}`}
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
          onClick={() => onChange({ runs: [...block.runs, makeRun()] })}
          className="mt-2 flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-sm text-text-muted hover:bg-white/5"
        >
          <Plus size={14} />
          Add a departure time
        </button>
      </div>
    </>
  );
}
