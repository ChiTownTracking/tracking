'use client';

import { useEffect, useState } from 'react';
import { formatClock12Hour } from '@/lib/clockFormat';
import { getTripStatus, type TripStatus } from '@/lib/scheduleStatus';

// Today's departures for the selected route. Phase K2: ONE flat
// chronological list (the H1 Completed/In progress/Upcoming sections are
// gone) — each row carries its own inline status text in the same
// three-state color language the sections used, plus an optional predicted
// arrival column when the caller provides one for that entry.
//
// The current instant is STATE, deliberately not a render-time new Date():
// with the React Compiler enabled (reactCompiler: true), everything the row
// computation reads must be a tracked reactive value. An untracked
// new Date() gets baked into an auto-memoized block that only invalidates
// when schedule/durationSeconds change — which is exactly the stale-status
// bug this replaces: a bare re-render tick advanced nothing, and rows
// silently showed old statuses to customers. Updating `now` as state makes
// the 30-second advance a real dependency change, compiler or no compiler.

const STATUS_LABELS: Record<TripStatus, string> = {
  completed: 'Completed',
  'in-progress': 'In progress',
  upcoming: 'Upcoming',
};

export default function ScheduleTimeline({
  schedule,
  durationSeconds,
  extraSecondsPerEntry,
  predictedArrivals,
  cancelledEntries,
}: {
  schedule: string[];
  durationSeconds: number;
  // Optional per-entry seconds added to durationSeconds for THAT entry's
  // status window — how the trip page folds each run's own pickup wait into
  // its in-progress span (Phase I2). Parallel to `schedule` as passed;
  // pairing survives the chronological sort below.
  extraSecondsPerEntry?: number[];
  // Optional display-ready predicted arrival ("7:47 PM") per entry,
  // parallel to `schedule`. Rows without one (null, or the prop absent —
  // /track passes nothing) simply render no third column.
  predictedArrivals?: (string | null)[];
  // Optional per-entry cancelled flags, parallel to `schedule` (Phase L3).
  // A cancelled row overrides its clock status entirely: it reads
  // "Cancelled" — never "In progress" or "Completed" — and shows no
  // predicted arrival.
  cancelledEntries?: boolean[];
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // No network call, nothing added to SWR polling — a pure clock tick.
    const interval = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(interval);
  }, []);

  // Zero-padded "HH:mm" sorts lexicographically === chronologically; never
  // assume the stored order. Times pair with their extra seconds and
  // predicted arrivals BEFORE sorting so the three can't drift apart.
  const entries = schedule
    .map((time, index) => ({
      time,
      index,
      extraSeconds: extraSecondsPerEntry?.[index] ?? 0,
      predictedArrival: predictedArrivals?.[index] ?? null,
      cancelled: cancelledEntries?.[index] ?? false,
    }))
    .sort((a, b) => a.time.localeCompare(b.time))
    .map((entry) => ({
      ...entry,
      status: getTripStatus(
        entry.time,
        durationSeconds + entry.extraSeconds,
        now,
      ),
    }));

  return (
    <div
      className="rounded-xl p-4"
      style={{ background: 'var(--color-panel)' }}
    >
      <p className="mb-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>
        Today&apos;s departures
      </p>
      <ul className="flex flex-col gap-2">
        {entries.map((entry) => {
          // Same three-state treatment the grouped sections used —
          // upcoming: quiet. in-progress: the app-wide "live" teal.
          // completed: red per the brief, muted (low opacity +
          // struck-through time) so it reads "done," not "error" —
          // --color-alert means trouble elsewhere in the app.
          // Cancelled (Phase L3) shares completed's muted-red strike
          // treatment, but its status TEXT says so plainly — "already
          // happened" and "never happened" must not read identically.
          const rowStyle =
            entry.cancelled || entry.status === 'completed'
              ? { color: 'var(--color-alert)', opacity: 0.45 }
              : entry.status === 'in-progress'
                ? { color: 'var(--color-live)' }
                : { color: 'var(--color-text-muted)' };
          const label = entry.cancelled
            ? 'Cancelled'
            : STATUS_LABELS[entry.status];
          return (
            <li
              key={`${entry.time}-${entry.index}`}
              title={entry.cancelled ? 'cancelled' : entry.status}
              className="flex items-center gap-3 text-sm"
              style={rowStyle}
            >
              {!entry.cancelled && entry.status === 'in-progress' && (
                <span className="status-dot status-dot--live" />
              )}
              <span
                className={
                  entry.cancelled || entry.status === 'completed'
                    ? 'font-medium line-through'
                    : 'font-medium'
                }
              >
                {formatClock12Hour(entry.time)}
              </span>
              <span className="text-xs">{label}</span>
              {!entry.cancelled && entry.predictedArrival && (
                <span className="ml-auto text-xs">
                  arrives {entry.predictedArrival}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
