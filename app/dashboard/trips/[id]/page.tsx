'use client';

import { Pencil, Plus } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import ConfirmActionRow from '@/components/ConfirmActionRow';
import DashboardNav from '@/components/DashboardNav';
import { fieldInputClass } from '@/components/formStyles';
import VehiclePicker from '@/components/VehiclePicker';
import VehicleScheduleBlock from '@/components/VehicleScheduleBlock';
import { formatClock12Hour } from '@/lib/clockFormat';
import { toDatetimeLocalValue } from '@/lib/datetimeLocalDefault';
import { computeOccurrenceValidity } from '@/lib/scheduleOccurrence';
import { getTripStatus, type TripStatus } from '@/lib/scheduleStatus';
import { redirectIfSessionExpired } from '@/lib/sessionExpiry';
import type { Trip, ScheduleEntry, VehicleAssignment } from '@/lib/trips';
import {
  computeDeparture,
  findVehicleBlockBlocker,
  makeVehicleBlock,
  parseWaitMinutes,
  toVehiclePayload,
} from '@/lib/vehicleBlock';
import type { RosterVehicle } from '@/lib/vehicleRoster';
import { useTheme } from '@/lib/useTheme';

// Phase L2: the staff detail view for one trip — the UI over L1's
// cancel/replace API. Everything shown comes from the single staff GET;
// every action refetches it on success so the page always reflects the
// stored document, never an optimistic guess. Phase O3 added the three
// editing surfaces over the O1/O2 endpoints: the trip's own name and
// window, per-run retiming, and putting another vehicle on the trip.

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

// Every action on this page reports failure the same way: the API's own
// message when it sent one (it names the real problem — an in-progress
// run, a duplicate vehicle), a generic line otherwise.
async function readError(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body && typeof body.error === 'string'
    ? body.error
    : `Request failed (${res.status})`;
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

// Phase O3: exactly the two conditions the schedule PATCH endpoint refuses
// on — deliberately computed the SAME window-aware way the route does
// (computeOccurrenceValidity, not a bare clock read), so the edit
// affordance is never offered on a run the API would reject, and never
// withheld from one it would accept. A run whose today-occurrence falls
// outside the trip's window isn't happening, so it stays editable even
// when the wall clock sits inside its span.
function canEditRun(
  entry: ScheduleEntry,
  trip: Trip,
  now: Date,
): boolean {
  if (entry.cancelled) {
    return false;
  }
  const validity = computeOccurrenceValidity(
    entry,
    0,
    trip.windowStart,
    trip.windowEnd,
    entry.waitMinutes * 60 + trip.totalDurationSeconds,
    now,
  );
  return !(validity.withinWindow && validity.status === 'in-progress');
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

// Phase O3: the trip's own name and active window. Two independent Save
// actions on one panel — renaming and rewindowing are unrelated decisions
// and shouldn't be forced into a single submit. Same plain-field-plus-own-
// button pattern the card label already uses.
function TripHeaderEditor({
  trip,
  onChanged,
}: {
  trip: Trip;
  onChanged: () => Promise<unknown>;
}) {
  const [name, setName] = useState(trip.name);
  // datetime-local wants LOCAL wall-clock text; the stored values are
  // absolute ISO. Pre-N3 trips have no window at all — those fields start
  // empty and only what staff fill in gets sent.
  const [windowStart, setWindowStart] = useState(
    trip.windowStart ? toDatetimeLocalValue(new Date(trip.windowStart)) : '',
  );
  const [windowEnd, setWindowEnd] = useState(
    trip.windowEnd ? toDatetimeLocalValue(new Date(trip.windowEnd)) : '',
  );
  const [nameBusy, setNameBusy] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [windowBusy, setWindowBusy] = useState(false);
  const [windowSaved, setWindowSaved] = useState(false);
  const [windowError, setWindowError] = useState<string | null>(null);
  const [confirmingEarlyEnd, setConfirmingEarlyEnd] = useState(false);

  // Returns the message to show, or null when it worked.
  async function patchTrip(body: Record<string, unknown>): Promise<string | null> {
    try {
      const res = await fetch(`/api/internal/trips/${trip.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (redirectIfSessionExpired(res.status)) {
        return null;
      }
      if (!res.ok) {
        return await readError(res);
      }
      await onChanged();
      return null;
    } catch {
      return 'Request failed — please try again.';
    }
  }

  async function saveName() {
    setNameBusy(true);
    setNameSaved(false);
    setNameError(null);
    const message = await patchTrip({ name });
    setNameError(message);
    setNameSaved(message === null);
    setNameBusy(false);
  }

  async function saveWindow() {
    setWindowBusy(true);
    setWindowSaved(false);
    setWindowError(null);
    const message = await patchTrip({
      // datetime-local values are timezone-less; normalize to UTC ISO so
      // the server stores an absolute window (same as create-trip).
      ...(windowStart !== ''
        ? { windowStart: new Date(windowStart).toISOString() }
        : {}),
      ...(windowEnd !== ''
        ? { windowEnd: new Date(windowEnd).toISOString() }
        : {}),
    });
    setWindowError(message);
    setWindowSaved(message === null);
    setConfirmingEarlyEnd(false);
    setWindowBusy(false);
  }

  // Client-side mirror of the API's rules — the server is still the
  // authority, this just avoids an obviously-doomed round trip.
  const windowBlocker =
    windowStart === '' && windowEnd === ''
      ? 'Set a window start and end.'
      : windowStart !== '' &&
          windowEnd !== '' &&
          new Date(windowEnd).getTime() <= new Date(windowStart).getTime()
        ? 'Window end must be after window start.'
        : null;

  // An end that's already behind us kills the public link the moment it
  // saves — a real consequence for anyone holding it, so it goes through
  // the confirm row. A trip whose window has ALREADY ended is a different
  // matter: nothing changes for anyone, so it saves directly, as does any
  // extension.
  const nowMs = Date.now();
  const endsInPast =
    windowEnd !== '' && new Date(windowEnd).getTime() < nowMs;
  const alreadyEnded =
    trip.windowEnd !== undefined && new Date(trip.windowEnd).getTime() < nowMs;
  const needsEarlyEndConfirm = endsInPast && !alreadyEnded;

  return (
    <section className="rounded-md border border-white/10 p-4">
      <label className="block">
        <span className="mb-1.5 block text-xs text-text-muted">Trip name</span>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameSaved(false);
            }}
            placeholder="North Shore Run"
            className={`flex-1 ${fieldInputClass}`}
          />
          <button
            type="button"
            onClick={saveName}
            disabled={nameBusy || name.trim() === ''}
            title={name.trim() === '' ? 'The trip needs a name.' : undefined}
            className="rounded-md border border-white/10 px-3 py-1.5 text-sm font-medium disabled:opacity-50 hover:bg-white/5"
          >
            {nameBusy ? 'Saving…' : 'Save name'}
          </button>
        </div>
      </label>
      {nameSaved && (
        <p className="mt-1 text-xs" style={{ color: 'var(--color-live)' }}>
          Name saved.
        </p>
      )}
      {nameError && (
        <p className="mt-1 text-sm" style={{ color: 'var(--color-alert)' }}>
          {nameError}
        </p>
      )}

      <div className="mt-4">
        <span className="mb-1.5 block text-xs text-text-muted">
          Tracking window
        </span>
        <p className="mb-2 text-xs text-text-muted">
          When the public trip link is live — before it starts and after it
          ends, the link shows a status message instead of the map.
        </p>
        {/* Stacked below sm: datetime-local inputs have a large intrinsic
            min-width and can't share a 375px row. */}
        <div className="flex flex-col gap-4 sm:flex-row">
          <label className="block flex-1">
            <span className="mb-1.5 block text-xs text-text-muted">
              Window start
            </span>
            <input
              type="datetime-local"
              value={windowStart}
              onChange={(event) => {
                setWindowStart(event.target.value);
                setWindowSaved(false);
                setConfirmingEarlyEnd(false);
              }}
              className={fieldInputClass}
            />
          </label>
          <label className="block flex-1">
            <span className="mb-1.5 block text-xs text-text-muted">
              Window end
            </span>
            <input
              type="datetime-local"
              value={windowEnd}
              onChange={(event) => {
                setWindowEnd(event.target.value);
                setWindowSaved(false);
                setConfirmingEarlyEnd(false);
              }}
              className={fieldInputClass}
            />
          </label>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              needsEarlyEndConfirm ? setConfirmingEarlyEnd(true) : saveWindow()
            }
            disabled={windowBusy || windowBlocker !== null}
            className="rounded-md border border-white/10 px-3 py-1.5 text-sm font-medium disabled:opacity-50 hover:bg-white/5"
          >
            {windowBusy ? 'Saving…' : 'Save window'}
          </button>
          {windowBlocker && (
            <span className="text-xs text-text-muted">{windowBlocker}</span>
          )}
        </div>
        {confirmingEarlyEnd && (
          <ConfirmActionRow
            className="mt-3"
            message="This will end the trip's public link immediately — anyone holding it will see that tracking has ended."
            confirmLabel="Confirm — end the link now"
            busyLabel="Saving…"
            dismissLabel="Keep it live"
            busy={windowBusy}
            onConfirm={saveWindow}
            onDismiss={() => setConfirmingEarlyEnd(false)}
          />
        )}
        {windowSaved && (
          <p className="mt-1 text-xs" style={{ color: 'var(--color-live)' }}>
            Window saved.
          </p>
        )}
        {windowError && (
          <p className="mt-1 text-sm" style={{ color: 'var(--color-alert)' }}>
            {windowError}
          </p>
        )}
      </div>
    </section>
  );
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
  // Phase O3: which run (if any) is open for retiming, and its draft
  // values. One at a time — an inline row that replaces the run it edits.
  const [editingRunId, setEditingRunId] = useState<string | null>(null);
  const [runArrival, setRunArrival] = useState('');
  const [runWait, setRunWait] = useState('0');
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

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
        setError(await readError(res));
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
        setLabelError(await readError(res));
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

  function openRunEdit(entry: ScheduleEntry) {
    setEditingRunId(entry.id);
    setRunArrival(entry.arrivalTime);
    setRunWait(String(entry.waitMinutes));
    setRunError(null);
  }

  async function saveRun(entryId: string) {
    const wait = parseWaitMinutes(runWait);
    if (!/^\d{2}:\d{2}$/.test(runArrival) || wait === null) {
      setRunError(
        'Enter an arrival time and a whole number of wait minutes (0 or more).',
      );
      return;
    }
    setRunBusy(true);
    setRunError(null);
    try {
      const res = await fetch(
        `/api/internal/trips/${trip.id}/vehicles/${assignment.vehicleId}/schedule/${entryId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ arrivalTime: runArrival, waitMinutes: wait }),
        },
      );
      if (redirectIfSessionExpired(res.status)) {
        return;
      }
      if (!res.ok) {
        // The API names the real problem — e.g. a run that became
        // in-progress between page load and save.
        setRunError(await readError(res));
        return;
      }
      // Refetch so the new time AND its refreshed predicted arrival land
      // together, straight from the stored document.
      await onChanged();
      setEditingRunId(null);
    } catch {
      setRunError('Request failed — please try again.');
    } finally {
      setRunBusy(false);
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
            // The run being retimed swaps its static row for the edit
            // form — same compact time/wait/departure-preview shape the
            // create-trip form uses, so a run reads the same way wherever
            // it's being edited.
            if (editingRunId === entry.id) {
              const departure = computeDeparture(runArrival, runWait);
              return (
                <li
                  key={entry.id}
                  className="flex flex-col gap-2 rounded-md bg-panel p-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="time"
                      value={runArrival}
                      onChange={(event) => setRunArrival(event.target.value)}
                      aria-label={`New arrival time for the ${formatClock12Hour(entry.arrivalTime)} run`}
                      className={`${fieldInputClass} w-auto`}
                    />
                    <label className="flex items-center gap-1.5 text-xs text-text-muted">
                      wait
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={runWait}
                        onChange={(event) => setRunWait(event.target.value)}
                        aria-label={`New wait minutes for the ${formatClock12Hour(entry.arrivalTime)} run`}
                        className={`${fieldInputClass} w-16`}
                      />
                      min
                    </label>
                    <span className="font-mono text-xs text-text-muted">
                      {departure ? `→ departs ${departure}` : ''}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => saveRun(entry.id)}
                      disabled={runBusy}
                      className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                      style={{ background: 'var(--color-accent)' }}
                    >
                      {runBusy ? 'Saving…' : 'Save run'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingRunId(null)}
                      disabled={runBusy}
                      className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-text-muted hover:bg-white/5"
                    >
                      Never mind
                    </button>
                  </div>
                  {runError && (
                    <p
                      className="text-sm"
                      style={{ color: 'var(--color-alert)' }}
                    >
                      {runError}
                    </p>
                  )}
                </li>
              );
            }

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
                {/* Offered ONLY where the API would accept it — no form
                    that opens just to fail on save. */}
                {canEditRun(entry, trip, now) && (
                  <button
                    type="button"
                    onClick={() => openRunEdit(entry)}
                    disabled={runBusy}
                    aria-label={`Edit the ${formatClock12Hour(entry.arrivalTime)} run`}
                    title="Change this run's time"
                    className="ml-auto rounded-md p-1 text-text-muted hover:opacity-75"
                  >
                    <Pencil size={13} />
                  </button>
                )}
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

// Phase O3: put ANOTHER vehicle on this trip. Distinct from Replace, which
// moves an existing vehicle's runs elsewhere — this adds a vehicle that
// wasn't here before, on its own schedule, over the same physical path.
// The composer itself is the create-trip form's vehicle block, shared
// rather than rebuilt.
function AddVehicleSection({
  trip,
  roster,
  rosterLoading,
  rosterFailed,
  onChanged,
}: {
  trip: Trip;
  roster: RosterVehicle[] | undefined;
  rosterLoading: boolean;
  rosterFailed: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [block, setBlock] = useState(makeVehicleBlock);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assignedIds = new Set(trip.vehicles.map((v) => v.vehicleId));
  // One assignment per vehicle per trip: the API rejects a duplicate, so
  // vehicles already here are kept out of the picker entirely rather than
  // offered as a dead end (same treatment Replace gives self-replacement).
  const available = roster?.filter(
    (vehicle) => !assignedIds.has(vehicle.vehicleId),
  );

  const blocker =
    findVehicleBlockBlocker(block, 'New vehicle') ??
    // Belt and braces: a refetch could add the picked vehicle to the trip
    // while this form sits open, and the filtered picker wouldn't know.
    (block.vehicleId !== null && assignedIds.has(block.vehicleId)
      ? 'That vehicle is already on this trip — edit its existing schedule instead.'
      : null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/trips/${trip.id}/vehicles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toVehiclePayload(block)),
      });
      if (redirectIfSessionExpired(res.status)) {
        return;
      }
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      // Refetch: the new vehicle appears above as its own section, in the
      // same style as every other one.
      await onChanged();
      setBlock(makeVehicleBlock());
      setOpen(false);
    } catch {
      setError('Request failed — please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 self-start rounded-md border border-white/10 px-3 py-1.5 text-sm text-text-muted hover:bg-white/5"
      >
        <Plus size={14} />
        Add another vehicle
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-md border border-white/10 p-4"
    >
      <h3 className="font-heading text-base font-medium">
        Add another vehicle
      </h3>
      <p className="mb-3 mt-1 text-xs text-text-muted">
        Runs the same route as the rest of this trip, on its own schedule.
      </p>

      <VehicleScheduleBlock
        block={block}
        onChange={(patch) => setBlock((current) => ({ ...current, ...patch }))}
        roster={available}
        rosterLoading={rosterLoading}
        rosterFailed={rosterFailed}
        labelPrefix="New vehicle"
      />

      {error && (
        <p className="mt-3 text-sm" style={{ color: 'var(--color-alert)' }}>
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={busy || blocker !== null}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--color-accent)' }}
        >
          {busy ? 'Adding…' : 'Add vehicle to trip'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={busy}
          className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-text-muted hover:bg-white/5"
        >
          Never mind
        </button>
        {blocker && <span className="text-xs text-text-muted">{blocker}</span>}
      </div>
    </form>
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
              <TripHeaderEditor
                // Re-seed the fields from the stored document whenever it
                // changes underneath (same remount-on-refetch reasoning as
                // the vehicle sections below).
                key={`${trip.name}-${trip.windowStart ?? ''}-${trip.windowEnd ?? ''}`}
                trip={trip}
                onChanged={() => mutate()}
              />

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

              <AddVehicleSection
                trip={trip}
                roster={roster}
                rosterLoading={rosterLoading}
                rosterFailed={Boolean(rosterError)}
                onChanged={() => mutate()}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
