'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { Check, Copy, Trash2 } from 'lucide-react';
import BulkSelectList from '@/components/BulkSelectList';
import ConfirmActionRow from '@/components/ConfirmActionRow';
import DashboardNav from '@/components/DashboardNav';
import { redirectIfSessionExpired } from '@/lib/sessionExpiry';
import type { TrackingLink } from '@/lib/trackingTokens';
import { useTheme } from '@/lib/useTheme';

type LinkEntry = { token: string } & TrackingLink;

async function fetcher(url: string): Promise<LinkEntry[]> {
  const res = await fetch(url);
  if (redirectIfSessionExpired(res.status)) {
    throw new Error('Session expired');
  }
  if (!res.ok) {
    throw new Error(`links request failed (${res.status})`);
  }
  return res.json();
}

function formatWindow(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function LinksPage() {
  // Applies the persisted app theme on this page too.
  useTheme();

  const { data: links, error, isLoading, mutate } = useSWR(
    '/api/internal/links',
    fetcher,
  );
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [revokingToken, setRevokingToken] = useState<string | null>(null);
  // Same second-click confirm as the trip detail page's cancel/replace:
  // revocation is customer-visible, so a stray click isn't enough.
  const [confirmingToken, setConfirmingToken] = useState<string | null>(null);

  async function copyLink(token: string) {
    await navigator.clipboard.writeText(
      `${window.location.origin}/track/${token}`,
    );
    setCopiedToken(token);
  }

  async function revokeLink(token: string) {
    setRevokingToken(token);
    try {
      const res = await fetch(`/api/internal/links/${token}`, {
        method: 'DELETE',
      });
      if (redirectIfSessionExpired(res.status)) {
        return;
      }
      await mutate();
    } finally {
      setRevokingToken(null);
      setConfirmingToken(null);
    }
  }

  // The bulk variant rejects on any non-OK status — BulkSelectList counts
  // a resolved promise as a successful revocation.
  async function revokeForBulk(link: LinkEntry) {
    const res = await fetch(`/api/internal/links/${link.token}`, {
      method: 'DELETE',
    });
    if (redirectIfSessionExpired(res.status)) {
      throw new Error('Session expired');
    }
    if (!res.ok) {
      throw new Error(`revoke failed (${res.status})`);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <header className="flex shrink-0 items-center gap-6 bg-panel px-4 py-2">
        <h1 className="min-w-0 truncate font-heading text-lg font-medium">
          ChiTown Tracking — Fleet Dispatch
        </h1>
        <DashboardNav />
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 p-6">
        <h2 className="font-heading text-xl font-medium">Tracking links</h2>

        {isLoading && (
          <p className="mt-4 text-sm text-text-muted">Loading links…</p>
        )}
        {error && (
          <p className="mt-4 text-sm" style={{ color: 'var(--color-alert)' }}>
            Unable to load tracking links.
          </p>
        )}
        {links && links.length === 0 && (
          <p className="mt-4 text-sm text-text-muted">
            No active tracking links.
          </p>
        )}

        {links && links.length > 0 && (
          <BulkSelectList
            rows={links}
            rowKey={(link) => link.token}
            rowLabel={(link) => link.customerName}
            headers={
              <>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Vehicles</th>
                <th className="px-3 py-2 font-medium">Window start</th>
                <th className="px-3 py-2 font-medium">Window end</th>
                <th className="px-3 py-2 font-medium" aria-label="Actions" />
              </>
            }
            renderRowCells={(link) => (
              <>
                <td className="px-3 py-2 font-medium">{link.customerName}</td>
                <td className="px-3 py-2 text-text-muted">
                  {link.vehicleIds.length}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-text-muted">
                  {formatWindow(link.windowStart)}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-text-muted">
                  {formatWindow(link.windowEnd)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => copyLink(link.token)}
                      aria-label={`Copy link for ${link.customerName}`}
                      title="Copy tracking URL"
                      className="rounded-md p-1.5 text-text-muted hover:opacity-75"
                    >
                      {copiedToken === link.token ? (
                        <Check size={15} color="var(--color-live)" />
                      ) : (
                        <Copy size={15} />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setConfirmingToken(
                          confirmingToken === link.token ? null : link.token,
                        )
                      }
                      disabled={revokingToken === link.token}
                      aria-label={`Revoke link for ${link.customerName}`}
                      title="Revoke tracking link"
                      className="rounded-md p-1.5 disabled:opacity-50"
                      style={{ color: 'var(--color-alert)' }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </td>
              </>
            )}
            renderRowTrailer={(link) =>
              confirmingToken === link.token ? (
                <tr>
                  {/* The page's 5 columns + the checkbox column. */}
                  <td colSpan={6} className="px-3 pb-3">
                    <ConfirmActionRow
                      message={`Revoke this link? ${link.customerName} will lose access immediately.`}
                      confirmLabel="Confirm — revoke link"
                      busyLabel="Revoking…"
                      dismissLabel="Keep it"
                      busy={revokingToken === link.token}
                      onConfirm={() => revokeLink(link.token)}
                      onDismiss={() => setConfirmingToken(null)}
                    />
                  </td>
                </tr>
              ) : null
            }
            actionLabel="Revoke selected"
            confirmMessage={(selected) =>
              `Revoke ${selected.length} ${
                selected.length === 1 ? 'link' : 'links'
              }? ${selected
                .map((link) => link.customerName)
                .join(', ')} will lose access immediately.`
            }
            confirmLabel={(count) =>
              `Confirm — revoke ${count} ${count === 1 ? 'link' : 'links'}`
            }
            busyLabel="Revoking…"
            failureMessage={(labels) =>
              `Could not revoke: ${labels.join(', ')} — still listed below; try again.`
            }
            deleteRow={revokeForBulk}
            onCompleted={() => mutate()}
          />
        )}
      </main>
    </div>
  );
}
