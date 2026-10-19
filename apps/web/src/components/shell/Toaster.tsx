import { useEffect } from 'react';
import { useUiStore, type Toast } from '../store/uiStore.js';

// Toast host (DASHBOARD §6): SSE emits BATCHED toasts into the store; this
// renders them in a polite live region (role=status) so screen readers announce
// sync milestones without stealing focus. Each toast auto-dismisses.
//
// EXCEPT ERRORS (W20-04, UX_TODO ADM-12). A failed write used to vanish after
// six seconds from a polite region, so the one toast someone needs to read and
// act on was the one most easily missed. UX_SPEC §7 says errors use
// role=alert; crit toasts now do, and stay until dismissed.

const TONE_CLASS = {
  info: 'border-info/40 bg-info/10 text-fg',
  ok: 'border-ok/40 bg-ok/10 text-fg',
  warn: 'border-warn/40 bg-warn/10 text-fg',
  crit: 'border-crit/40 bg-crit/10 text-fg',
} as const;

const AUTO_DISMISS_MS = 6000;

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  return (
    <div
      className={`pointer-events-auto flex items-start gap-3 rounded-md border px-3 py-2 text-sm shadow ${TONE_CLASS[toast.tone]}`}
      data-testid="toast"
      data-tone={toast.tone}
      {...(toast.tone === 'crit' ? { role: 'alert' } : {})}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span>{toast.message}</span>
        {toast.detail ? (
          <span className="text-xs text-fg-muted" data-testid="toast-detail">
            {toast.detail}
          </span>
        ) : null}
        {toast.requestId ? (
          <span className="font-mono text-xs text-fg-faint" data-testid="toast-request-id">
            (request {toast.requestId})
          </span>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="text-fg-faint hover:text-fg"
        aria-label="Dismiss notification"
      >
        ✕
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);

  useEffect(() => {
    // Only the non-error toasts time out; a crit one waits for the person.
    const passing = toasts.filter((t) => t.tone !== 'crit');
    if (passing.length === 0) return;
    const timers = passing.map((t) => setTimeout(() => dismissToast(t.id), AUTO_DISMISS_MS));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismissToast]);

  const errors = toasts.filter((t) => t.tone === 'crit');
  const others = toasts.filter((t) => t.tone !== 'crit');

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-md flex-col gap-2"
      data-testid="toaster"
    >
      {/* Each error carries its own role=alert, so it is announced when it
          appears; nesting it inside the polite region would downgrade it. */}
      {errors.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => dismissToast(toast.id)} />
      ))}
      <div className="flex flex-col gap-2" role="status" aria-live="polite">
        {others.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={() => dismissToast(toast.id)} />
        ))}
      </div>
    </div>
  );
}
