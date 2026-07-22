'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import ConfirmActionRow from '@/components/ConfirmActionRow';
import DashboardNav from '@/components/DashboardNav';
import { fieldInputClass } from '@/components/formStyles';
import VehiclePicker from '@/components/VehiclePicker';
import { formatClock12Hour } from '@/lib/clockFormat';
import { getTripStatus, type TripStatus } from '@/lib/scheduleStatus';
import { redirectIfSessionExpired } from '@/lib/sessionExpiry';
import type { Trip, ScheduleEntry, VehicleAssignment } from '@/lib/trips';
import type { RosterVehicle } from '@/lib/vehicleRoster';
import { useTheme } from '@/lib/useTheme';

// Phase L2: the staff detail view for one trip — the UI over L1's
// cancel/replace API. Everything shown comes from the single staff GET;
// the two PATCH actions refetch it on success so the page always reflects
// the stored document, never an optimistic guess.

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

// Cancelled wins outright: a cancelled run reads as cancelled no matter
// what the clock would say about its time window.
function entryStatusLabel(
  entry: ScheduleEntry,
  totalDurationSeconds: number,
  now: Date,
): 'Cancelled' | 'Upcoming' | 'In progress' | 'Completed' {
  if (entry.cancelled) {
    return 'Cancelled';
  }
  const labels: Record<TripStatus, 'Upcoming' | 'In progress' | 'Completed'> = {
    upcoming: 'Upcoming',
    'in-progress': 'In progress',
    completed: 'Completed',
  };
  return labels[
    getTripStatus(
      entry.arrivalTime,
      entry.waitMinutes * 60 + totalDurationSeconds,
      now,
    )
  ];
}

// Same upcoming-only rule the cancel/replace routes apply server-side, so
// the disabled states match what the API would actually do.
function countUpcoming(
  assignment: VehicleAssignment,
  totalDurationSeconds: number,
  now: Date,
): number {
  return assignment.schedule.filter(
    (entry) =>
      !entry.cancelled &&
      getTripStatus(
        entry.arrivalTime,
        entry.waitMinutes * 60 + totalDurationSeconds,
        now,
      ) === 'upcoming',
  ).length;
}

function VehicleSection({
  trip,
  assignment,
  roster,
  rosterLoading,
  rosterFailed,
  onChanged,
}: {
  trip: Trip;
  assignment: VehicleAssignment;
  roster: RosterVehicle[] | undefined;
  rosterLoading: boolean;
  rosterFailed: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const [note, setNote] = useState(assignment.serviceNote ?? '');
  // Phase N4: the card label is its OWN field with its own Save action —
  // a persistent display setting, not part of the disruptive cancel/
  // replace flow, so no confirmation friction.
  const [cardLabel, setCardLabel] = useState(assignment.cardLabel ?? '');
  const [labelBusy, setLabelBusy] = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [labelSaved, setLabelSaved] = useState(false);
  // 'cancel' shows the confirm row; 'replace' shows the picker (whose
  // submit button is itself the explicit second step).
  const [openAction, setOpenAction] = useState<'cancel' | 'replace' | null>(
    null,
  );
  const [replacementId, setReplacementId] = useState<string | null>(null);
  const [pickerQuery, setPickerQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rosterVehicle = roster?.find(
    (vehicle) => vehicle.vehicleId === assignment.vehicleId,
  );
  const now = new Date();
  const upcomingCount = countUpcoming(
    assignment,
    trip.totalDurationSeconds,
    now,
  );
  const nothingUpcoming = upcomingCount === 0;
  const runsWord = upcomingCount === 1 ? 'run' : 'runs';

  async function fireAction(path: 'cancel' | 'replace') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/internal/trips/${trip.id}/vehicles/${assignment.vehicleId}/${path}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // Empty field → no note key at all: the API only overwrites
            // serviceNote when note is present, and '' is not a note.
            ...(note.trim() === '' ? {} : { note }),
            ...(path === 'replace'
              ? { replacementVehicleId: replacementId }
              : {}),
          }),
        },
      );
      if (redirectIfSessionExpired(res.status)) {
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(
          body && typeof body.error === 'string'
            ? body.error
            : `Request failed (${res.status})`,
        );
        return;
      }
      await onChanged();
      setOpenAction(null);
      setReplacementId(null);
      setPickerQuery('');
    } catch {
      setError('Request failed — please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function saveLabel() {
    setLabelBusy(true);
    setLabelError(null);
    setLabelSaved(false);
    try {
      const res = await fetch(
        `/api/internal/trips/${trip.id}/vehicles/${assignment.vehicleId}/label`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          // Empty string clears the label server-side (field removed, not
          // stored as '').
          body: JSON.stringify({ cardLabel: cardLabel.trim() || null }),
        },
      );
      if (redirectIfSessionExpired(res.status)) {
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setLabelError(
          body && typeof body.error === 'string'
            ? body.error
            : `Request failed (${res.status})`,
        );
        return;
      }
      await onChanged();
      setLabelSaved(true);
    } catch {
      setLabelError('Request failed — please try again.');
    } finally {
      setLabelBusy(false);
    }
  }

  const replacementLabel =
    replacementId === null
      ? null
      : (roster?.find((vehicle) => vehicle.vehicleId === replacementId)
          ?.registrationNumber ?? replacementId);

  return (
    <section className="rounded-md border border-white/10 p-4">
      <h3 className="font-heading text-base font-medium">
        {rosterVehicle
          ? `${rosterVehicle.registrationNumber} — ${rosterVehicle.description}`
          : assignment.vehicleId}
      </h3>

      <div className="mt-3">
        <span className="mb-1.5 block text-xs text-text-muted">
          Card label (shown before the vehicle number on the customer card)
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={cardLabel}
            onChange={(event) => {
              setCardLabel(event.target.value);
              setLabelSaved(false);
            }}
            maxLength={40}
            placeholder="e.g. Route A (empty clears it)"
            aria-label={`Card label for ${assignment.vehicleId}`}
            className={`flex-1 ${fieldInputClass}`}
          />
          <button
            type="button"
            onClick={saveLabel}
            disabled={labelBusy}
            className="rounded-md border border-white/10 px-3 py-1.5 text-sm font-medium disabled:opacity-50 hover:bg-white/5"
          >
            {labelBusy ? 'Saving…' : 'Save label'}
          </button>
        </div>
        {labelSaved && (
          <p className="mt-1 text-xs" style={{ color: 'var(--color-live)' }}>
            Label saved.
          </p>
        )}
        {labelError && (
          <p className="mt-1 text-sm" style={{ color: 'var(--color-alert)' }}>
            {labelError}
          </p>
        )}
      </div>

      <label className="mt-3 block">
        <span className="mb-1.5 block text-xs text-text-muted">
          Service note (saved with the next cancel or replace)
        </span>
        <input
          type="text"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="e.g. transmission fault, swapped to spare"
          className={fieldInputClass}
        />
      </label>

      {assignment.schedule.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">
          No runs — this vehicle&apos;s remaining runs were moved to a
          replacement.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1">
          {assignment.schedule.map((entry) => {
            const status = entryStatusLabel(
              entry,
              trip.totalDurationSeconds,
              now,
            );
            return (
              <li
                key={entry.id}
                className="flex items-baseline gap-3 text-sm"
              >
                <span
                  className={`font-mono ${status === 'Cancelled' ? 'line-through opacity-60' : ''}`}
                >
                  {formatClock12Hour(entry.arrivalTime)}
                </span>
                {entry.waitMinutes > 0 && (
                  <span className="text-xs text-text-muted">
                    +{entry.waitMinutes} min wait
                  </span>
                )}
                <span
                  className="text-xs"
                  style={{
                    color:
                      status === 'Cancelled'
                        ? 'var(--color-alert)'
                        : 'var(--color-text-muted)',
                  }}
                >
                  {status}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            setOpenAction(openAction === 'cancel' ? null : 'cancel')
          }
          disabled={busy || nothingUpcoming}
          title={
            nothingUpcoming
              ? 'No upcoming runs left to cancel.'
              : 'Cancel every upcoming run for this vehicle'
          }
          className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          style={{
            borderColor: 'var(--color-alert)',
            color: 'var(--color-alert)',
          }}
        >
          Cancel remaining runs
        </button>
        <button
          type="button"
          onClick={() => {
            setOpenAction(openAction === 'replace' ? null : 'replace');
            setReplacementId(null);
          }}
          disabled={busy || nothingUpcoming}
          title={
            nothingUpcoming
              ? 'No upcoming runs left to move.'
              : 'Move every upcoming run to a different vehicle'
          }
          className="rounded-md border border-white/10 px-3 py-1.5 text-sm font-medium disabled:opacity-50 hover:bg-white/5"
        >
          Replace vehicle
        </button>
      </div>

      {openAction === 'cancel' && (
        <ConfirmActionRow
          className="mt-3"
          message={`Cancel ${upcomingCount} upcoming ${runsWord}? Customers see this immediately.`}
          confirmLabel={`Confirm — cancel ${upcomingCount} ${runsWord}`}
          busyLabel="Cancelling…"
          dismissLabel="Keep them"
          busy={busy}
          onConfirm={() => fireAction('cancel')}
          onDismiss={() => setOpenAction(null)}
        />
      )}

      {openAction === 'replace' && (
        <div className="mt-3 rounded-md bg-panel p-3">
          <p className="mb-2 text-sm">
            Move {upcomingCount} upcoming {runsWord} to:
          </p>
          <VehiclePicker
            // The API rejects self-replacement; keeping this vehicle out
            // of the picker removes the dead-end choice entirely.
            roster={roster?.filter(
              (vehicle) => vehicle.vehicleId !== assignment.vehicleId,
            )}
            isLoading={rosterLoading}
            loadFailed={rosterFailed}
            query={pickerQuery}
            onQueryChange={setPickerQuery}
            selected={new Set(replacementId === null ? [] : [replacementId])}
            onToggle={(id) =>
              setReplacementId(replacementId === id ? null : id)
            }
            searchLabel={`Search replacement vehicles for ${assignment.vehicleId}`}
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => fireAction('replace')}
              disabled={busy || replacementId === null}
              title={
                replacementId === null
                  ? 'Pick the replacement vehicle first.'
                  : undefined
              }
              className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--color-accent)' }}
            >
              {busy
                ? 'Moving…'
                : replacementLabel === null
                  ? 'Move runs'
                  : `Confirm — move ${upcomingCount} ${runsWord} to ${replacementLabel}`}
            </button>
            <button
              type="button"
              onClick={() => setOpenAction(null)}
              disabled={busy}
              className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-text-muted hover:bg-white/5"
            >
              Never mind
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 text-sm" style={{ color: 'var(--color-alert)' }}>
          {error}
        </p>
      )}
    </section>
  );
}

export default function TripDetailPage() {
  // Applies the persisted app theme on this page too.
  useTheme();

  const params = useParams<{ id: string }>();
  const { data: trip, error, isLoading, mutate } = useSWR(
    `/api/internal/trips/${params.id}`,
    fetchJson<Trip>,
  );
  const { data: roster, error: rosterError, isLoading: rosterLoading } =
    useSWR('/api/internal/roster', fetchJson<RosterVehicle[]>);

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <header className="flex shrink-0 items-center gap-6 bg-panel px-4 py-2">
        <h1 className="min-w-0 truncate font-heading text-lg font-medium">
          ChiTown Tracking — Fleet Dispatch
        </h1>
        <DashboardNav />
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 p-6">
        {isLoading && (
          <p className="text-sm text-text-muted">Loading trip…</p>
        )}
        {error && (
          <p className="text-sm" style={{ color: 'var(--color-alert)' }}>
            Unable to load this trip.
          </p>
        )}

        {trip && (
          <>
            <h2 className="font-heading text-xl font-medium">{trip.name}</h2>
            <p className="mt-1 text-sm text-text-muted">
              {trip.waypoints.map((waypoint) => waypoint.label).join(' → ')}
            </p>

            <div className="mt-4 flex flex-col gap-4">
              {trip.vehicles.map((assignment) => (
                <VehicleSection
                  // Remount on refetch so the note field re-seeds from the
                  // freshly stored serviceNote after a cancel/replace.
                  key={`${assignment.vehicleId}-${assignment.serviceNote ?? ''}`}
                  trip={trip}
                  assignment={assignment}
                  roster={roster}
                  rosterLoading={rosterLoading}
                  rosterFailed={Boolean(rosterError)}
                  onChanged={() => mutate()}
                />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
