'use client';

import { useState } from 'react';
import { ChevronDown, Locate } from 'lucide-react';
import { formatClock12Hour } from '@/lib/clockFormat';
import { selectActiveFromDailyPools } from '@/lib/scheduleEntry';
import { getOccurrenceStatus } from '@/lib/scheduleOccurrence';
import type { TripStatus } from '@/lib/scheduleStatus';
import ScheduleTimeline from './ScheduleTimeline';

// Phase K2: one vehicle's card on the public trip page, redesigned around
// K1's stored traffic prediction. Mobile-first: full-width stacked cards,
// the schedule collapsed behind a comfortable tap target.

export interface TripCardScheduleEntry {
  id: string;
  arrivalTime: string;
  waitMinutes: number;
  status: TripStatus;
  departureClock: string;
  // Present (true) only when staff cancelled this run (Phase L3).
  cancelled?: boolean;
  // Bus-buffered early/late arrival window, already formatted 12-hour.
  predictedArrivalRange: { early: string; late: string } | null;
}

// The quiet inline confidence tag — next to the arrival/predicted time
// itself, never a header-level pill (the earlier design revision).
function ApproximateTag() {
  return (
    <span
      className="ml-2 inline-block rounded px-1.5 py-0.5 align-middle text-[10px]"
      style={{
        border: '1px solid var(--color-text-muted)',
        color: 'var(--color-text-muted)',
      }}
    >
      approximate
    </span>
  );
}

export default function TripStatusCard({
  vehicleLabel,
  cardLabel,
  hasPosition,
  positionConfident,
  schedule,
  tomorrowSchedule,
  activeRunDateLabel,
  serviceNote,
  pickupLabel,
  destinationLabel,
  totalDurationSeconds,
  color,
  now,
  focused,
  onCenter,
}: {
  vehicleLabel: string;
  // Phase N4: optional staff-set prefix shown before the vehicle number
  // ("ROUTE A - 2401"); absent renders just the vehicle number as before.
  cardLabel?: string | null;
  hasPosition: boolean;
  positionConfident: boolean | null;
  // Every run whose occurrence is valid TODAY (Phase N6: window-checked —
  // can be genuinely EMPTY, e.g. a same-evening trip whose early-morning
  // times all precede the window opening).
  schedule: TripCardScheduleEntry[];
  // The SAME entries and window, one day ahead — every run valid TOMORROW.
  tomorrowSchedule: TripCardScheduleEntry[];
  // Phase N5: the active run's Chicago-anchored calendar date ("Fri, Jul
  // 17"), from the API — appended after the active-run time in every
  // time-stating variant. Null only when there's no active run at all.
  activeRunDateLabel?: string | null;
  // The staff-written "why service changed" message (Phase L3) — the whole
  // point of the cancel/replace feature for customers, so it renders
  // prominently on the card, never buried in the collapsed schedule.
  serviceNote?: string | null;
  pickupLabel: string;
  destinationLabel: string;
  totalDurationSeconds: number;
  // This vehicle's own map-marker color (getRouteColor by index) — the
  // header dot matches the marker, it is NOT a live-status signal.
  color: string;
  now: Date;
  // The "this is the one you picked" signal, mirrored on the map marker's
  // ring — cleared by centering another vehicle or the fit-everything
  // button.
  focused: boolean;
  onCenter: () => void;
}) {
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [tomorrowOpen, setTomorrowOpen] = useState(false);

  // Phase N6: searches BOTH pools (today's window-valid runs, tomorrow's)
  // — the client-side counterpart to the server's own day-spanning
  // selection, recomputed against the ticking clock (not the fetch-time
  // status field) so the emphasized block appears/disappears between
  // polls. Null only when NEITHER pool has anything at all (a fully
  // emptied assignment, e.g. every run moved by an L1 replace). When
  // every run in both pools is cancelled, it returns the last one WITH
  // its cancelled flag — a display anchor, not a live run.
  const selection = selectActiveFromDailyPools(
    schedule,
    tomorrowSchedule,
    totalDurationSeconds,
    now,
  );
  const active = selection?.entry ?? null;
  const activeStatus = active
    ? getOccurrenceStatus(
        active.arrivalTime,
        selection?.dateOffsetDays ?? 0,
        active.waitMinutes * 60 + totalDurationSeconds,
        now,
      )
    : null;
  const activeCancelled = active?.cancelled === true;
  const uncertain = positionConfident === false;

  return (
    <section
      className="rounded-xl p-4"
      style={{
        background: 'var(--color-panel)',
        boxShadow: focused ? `0 0 0 2px ${color}` : undefined,
      }}
    >
      <div className="flex items-center gap-2.5">
        {hasPosition && (
          <span
            className="inline-block h-3 w-3 shrink-0 rounded-full"
            style={{ background: color }}
          />
        )}
        <h2 className="customer-heading text-lg">
          {cardLabel ? `${cardLabel} - ${vehicleLabel}` : vehicleLabel}
        </h2>
        <button
          type="button"
          onClick={onCenter}
          // Nothing to center on without a position — same "no fake
          // location" rule as the map marker.
          disabled={!hasPosition}
          aria-label={`Center map on ${vehicleLabel}`}
          title={
            hasPosition
              ? 'Center map on this vehicle'
              : 'No position to center on'
          }
          className="ml-auto shrink-0 rounded-md p-2 disabled:opacity-40"
          style={{
            background: 'var(--color-bg)',
            color: focused ? color : 'var(--color-text-muted)',
          }}
        >
          <Locate size={14} />
        </button>
      </div>

      {/* The service note, front and center — the customer shouldn't have
          to expand anything to learn their vehicle isn't coming. */}
      {serviceNote && (
        <div
          className="mt-2 rounded-lg p-3"
          style={{
            background:
              'color-mix(in srgb, var(--color-alert) 10%, transparent)',
          }}
        >
          <p className="text-xs font-medium uppercase tracking-wider">
            Service update
          </p>
          <p className="mt-0.5 text-sm">{serviceNote}</p>
        </div>
      )}

      {/* Pickup arrival/departure from the ACTIVE run. With no live
          position the pickup time is still known, but nothing is actually
          tracking it — "Scheduled", not "Arrives". A cancelled anchor run
          (every run cancelled) or an emptied schedule (all runs replaced
          away) gets a calm plain statement instead — never an "Arrives"
          line for a bus that isn't coming. */}
      {active === null ? (
        <p className="mt-2 text-sm">
          No more runs scheduled for this vehicle.
        </p>
      ) : activeCancelled ? (
        <p className="mt-2 text-sm">
          The{' '}
          <span className="font-medium">
            {formatClock12Hour(active.arrivalTime)}
          </span>{' '}
          pickup at {pickupLabel} is cancelled.
          {activeRunDateLabel ? ` - ${activeRunDateLabel}` : ''}
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm">
            {hasPosition ? 'Arrives' : 'Scheduled:'} {pickupLabel} at{' '}
            <span className="font-medium">
              {formatClock12Hour(active.arrivalTime)}
            </span>
            {/* Phase N5: always append the active run's date, today or not. */}
            {activeRunDateLabel ? ` - ${activeRunDateLabel}` : ''}
            {/* The confidence tag sits beside the predicted time when the
                emphasized block is shown; when it isn't, beside this time. */}
            {hasPosition &&
              uncertain &&
              !(
                activeStatus === 'in-progress' && active.predictedArrivalRange
              ) && <ApproximateTag />}
          </p>
          {active.waitMinutes > 0 && (
            <p
              className="mt-0.5 text-sm"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Departs at {formatClock12Hour(active.departureClock)}
            </p>
          )}
        </>
      )}
      {!hasPosition && (
        <p className="mt-0.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Position unavailable
        </p>
      )}

      {/* The emphasized predicted-arrival block: ONLY for a real
          (non-cancelled) run currently in progress on a live vehicle —
          upcoming, fully-done, and cancelled runs don't get a big number
          that isn't happening right now. */}
      {hasPosition &&
        active !== null &&
        !activeCancelled &&
        activeStatus === 'in-progress' &&
        active.predictedArrivalRange && (
          <div
            className="mt-3 rounded-lg p-3"
            style={{
              background:
                'color-mix(in srgb, var(--color-accent) 8%, transparent)',
            }}
          >
            <p className="text-2xl font-medium">
              {/* En-dash range; a single time when both ends agree. */}
              {active.predictedArrivalRange.early ===
              active.predictedArrivalRange.late
                ? active.predictedArrivalRange.early
                : `${active.predictedArrivalRange.early}–${active.predictedArrivalRange.late}`}
              {uncertain && <ApproximateTag />}
            </p>
            <p className="mt-0.5 text-sm">
              Estimated arrival at {destinationLabel}
            </p>
            {/* Distinct from the header's live "Updated Xm ago": this
                number was computed once, at booking — not live-refreshed. */}
            <p
              className="mt-0.5 text-xs"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Predicted at booking
            </p>
          </div>
        )}

      {/* Collapsed by default, always — the block above already surfaces an
          in-progress run without expanding. Both toggles are hidden only
          when the vehicle has NOTHING in either pool at all (a fully
          emptied assignment, e.g. every run moved by an L1 replace) —
          otherwise each toggle always shows, and an individually-empty
          pool (Phase N6: a real, correct outcome, not a bug) says so
          explicitly instead of rendering an ambiguous blank panel. */}
      {(schedule.length > 0 || tomorrowSchedule.length > 0) && (
        <>
          <button
            type="button"
            onClick={() => setScheduleOpen((open) => !open)}
            aria-expanded={scheduleOpen}
            className="mt-3 flex w-full items-center justify-between rounded-md py-2 text-sm"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Today&apos;s schedule
            <ChevronDown
              size={16}
              className={scheduleOpen ? 'rotate-180 transition-transform' : 'transition-transform'}
            />
          </button>
          {scheduleOpen &&
            (schedule.length === 0 ? (
              <p
                className="rounded-xl p-4 text-sm"
                style={{
                  background: 'var(--color-panel)',
                  color: 'var(--color-text-muted)',
                }}
              >
                Nothing left today.
              </p>
            ) : (
              <ScheduleTimeline
                schedule={schedule.map((entry) => entry.arrivalTime)}
                durationSeconds={totalDurationSeconds}
                extraSecondsPerEntry={schedule.map(
                  (entry) => entry.waitMinutes * 60,
                )}
                // Rows keep a single time (the early end) — the full range
                // lives in the emphasized block above, not in every
                // schedule row.
                predictedArrivals={schedule.map(
                  (entry) => entry.predictedArrivalRange?.early ?? null,
                )}
                cancelledEntries={schedule.map(
                  (entry) => entry.cancelled === true,
                )}
              />
            ))}

          <button
            type="button"
            onClick={() => setTomorrowOpen((open) => !open)}
            aria-expanded={tomorrowOpen}
            className="mt-1 flex w-full items-center justify-between rounded-md py-2 text-sm"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Tomorrow&apos;s schedule
            <ChevronDown
              size={16}
              className={tomorrowOpen ? 'rotate-180 transition-transform' : 'transition-transform'}
            />
          </button>
          {tomorrowOpen &&
            (tomorrowSchedule.length === 0 ? (
              <p
                className="rounded-xl p-4 text-sm"
                style={{
                  background: 'var(--color-panel)',
                  color: 'var(--color-text-muted)',
                }}
              >
                Nothing scheduled tomorrow yet.
              </p>
            ) : (
              <ScheduleTimeline
                schedule={tomorrowSchedule.map((entry) => entry.arrivalTime)}
                durationSeconds={totalDurationSeconds}
                extraSecondsPerEntry={tomorrowSchedule.map(
                  (entry) => entry.waitMinutes * 60,
                )}
                predictedArrivals={tomorrowSchedule.map(
                  (entry) => entry.predictedArrivalRange?.early ?? null,
                )}
                cancelledEntries={tomorrowSchedule.map(
                  (entry) => entry.cancelled === true,
                )}
                dateOffsetDays={1}
              />
            ))}
        </>
      )}
    </section>
  );
}
