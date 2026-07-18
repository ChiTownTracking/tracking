'use client';

// The dashboard's destructive-action confirm, extracted from the trip
// detail page the moment link revocation became its second consumer:
// nothing fires until an explicit second click, and the message states
// the real consequence ("customers see this immediately", "will lose
// access immediately") rather than a generic "are you sure?".
export default function ConfirmActionRow({
  message,
  confirmLabel,
  busyLabel,
  dismissLabel,
  busy,
  onConfirm,
  onDismiss,
  className,
}: {
  message: string;
  confirmLabel: string;
  busyLabel: string;
  dismissLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <div className={`rounded-md bg-panel p-3 ${className ?? ''}`}>
      <p className="text-sm">{message}</p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--color-alert)' }}
        >
          {busy ? busyLabel : confirmLabel}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-text-muted hover:bg-white/5"
        >
          {dismissLabel}
        </button>
      </div>
    </div>
  );
}
