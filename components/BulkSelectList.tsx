'use client';

import { Fragment, useState } from 'react';
import ConfirmActionRow from './ConfirmActionRow';

// Phase M2: the shared bulk-select table used by BOTH the Trips and Links
// dashboards — one selection model, one sticky action bar, one confirm
// step (ConfirmActionRow again), never two copies of the interaction.
//
// The component owns the checkbox column and the delete orchestration;
// each page keeps its own columns via `headers`/`renderRowCells` (and, for
// links, its per-row confirm via `renderRowTrailer`). Deletion fires one
// DELETE per selected row through Promise.allSettled — a bulk action must
// not let one failure swallow the rest — and anything that failed is named
// afterward instead of reporting blanket success.
export default function BulkSelectList<Row>({
  rows,
  rowKey,
  rowLabel,
  headers,
  renderRowCells,
  renderRowTrailer,
  actionLabel,
  confirmMessage,
  confirmLabel,
  busyLabel,
  failureMessage,
  deleteRow,
  onCompleted,
}: {
  rows: Row[];
  rowKey: (row: Row) => string;
  // Human-readable name for a row — used in failure reporting (and
  // available to confirmMessage for naming what's about to go).
  rowLabel: (row: Row) => string;
  // The page's own <th> cells; the select-all checkbox column is prepended.
  headers: React.ReactNode;
  // The page's own <td> cells for one row; the checkbox cell is prepended.
  renderRowCells: (row: Row) => React.ReactNode;
  // Optional extra full-width <tr> rendered after a row (the links page's
  // per-row revoke confirm). Must span the page's columns + 1.
  renderRowTrailer?: (row: Row) => React.ReactNode;
  // "Delete selected" / "Revoke selected".
  actionLabel: string;
  confirmMessage: (selected: Row[]) => string;
  confirmLabel: (count: number) => string;
  busyLabel: string;
  failureMessage: (labels: string[]) => string;
  // Must reject on failure — a resolved promise counts as success.
  deleteRow: (row: Row) => Promise<void>;
  // Refetch after the batch settles (success or partial failure alike).
  onCompleted: () => Promise<unknown>;
}) {
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failedLabels, setFailedLabels] = useState<string[]>([]);

  // Selection is keys, membership is recomputed against the CURRENT rows —
  // keys that vanished in a background refetch simply stop counting.
  const selectedRows = rows.filter((row) => selectedKeys.has(rowKey(row)));
  const allSelected =
    rows.length > 0 && selectedRows.length === rows.length;

  function toggleAll() {
    setSelectedKeys(allSelected ? new Set() : new Set(rows.map(rowKey)));
    setConfirming(false);
  }

  function toggleRow(key: string) {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    setConfirming(false);
  }

  async function deleteSelected() {
    setBusy(true);
    setFailedLabels([]);
    try {
      const targets = selectedRows;
      const results = await Promise.allSettled(
        targets.map((row) => deleteRow(row)),
      );
      const failed = targets.filter(
        (_, index) => results[index].status === 'rejected',
      );
      await onCompleted();
      setSelectedKeys(new Set());
      setConfirming(false);
      setFailedLabels(failed.map(rowLabel));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {selectedRows.length > 0 && (
        <div className="sticky top-4 z-10 mt-4">
          {confirming ? (
            <ConfirmActionRow
              className="border border-white/10 shadow-lg"
              message={confirmMessage(selectedRows)}
              confirmLabel={confirmLabel(selectedRows.length)}
              busyLabel={busyLabel}
              dismissLabel="Keep them"
              busy={busy}
              onConfirm={deleteSelected}
              onDismiss={() => setConfirming(false)}
            />
          ) : (
            <div className="flex items-center gap-3 rounded-md border border-white/10 bg-panel p-3 shadow-lg">
              <span className="text-sm">
                {selectedRows.length} selected
              </span>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded-md border px-3 py-1.5 text-sm font-medium"
                style={{
                  borderColor: 'var(--color-alert)',
                  color: 'var(--color-alert)',
                }}
              >
                {actionLabel}
              </button>
              <button
                type="button"
                onClick={() => setSelectedKeys(new Set())}
                className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-text-muted hover:bg-white/5"
              >
                Clear selection
              </button>
            </div>
          )}
        </div>
      )}

      {/* Overflow becomes a contained sideways scroll of the table area
          only — never a whole-page scroll dragging the header and the
          sticky bar along (Phase N1; the links table's six columns
          genuinely exceed a 375px viewport). */}
      <div className="overflow-x-auto">
      <table className="mt-4 w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-text-muted">
            <th className="w-8 px-3 py-2">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                aria-label={
                  allSelected ? 'Deselect all rows' : 'Select all rows'
                }
                className="h-4 w-4 accent-accent"
              />
            </th>
            {headers}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            return (
              <Fragment key={key}>
                <tr className="border-t border-white/10">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selectedKeys.has(key)}
                      onChange={() => toggleRow(key)}
                      aria-label={`Select ${rowLabel(row)}`}
                      className="h-4 w-4 accent-accent"
                    />
                  </td>
                  {renderRowCells(row)}
                </tr>
                {renderRowTrailer?.(row)}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      </div>

      {failedLabels.length > 0 && (
        <p className="mt-2 text-sm" style={{ color: 'var(--color-alert)' }}>
          {failureMessage(failedLabels)}
        </p>
      )}
    </>
  );
}
