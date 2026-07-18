'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { Check, Copy, Trash2 } from 'lucide-react';
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
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <header className="flex shrink-0 items-center gap-6 bg-panel px-4 py-2">
        <h1 className="font-heading text-lg font-medium">
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
          <table className="mt-4 w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-text-muted">
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Vehicles</th>
                <th className="px-3 py-2 font-medium">Window start</th>
                <th className="px-3 py-2 font-medium">Window end</th>
                <th className="px-3 py-2 font-medium" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.token} className="border-t border-white/10">
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
                        onClick={() => revokeLink(link.token)}
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}
