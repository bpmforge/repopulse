import { useEffect } from 'react';
import { useUiStore } from '../store/uiStore.js';

// Toast host (DASHBOARD §6): SSE emits BATCHED toasts into the store; this
// renders them in a polite live region (role=status) so screen readers announce
// sync milestones without stealing focus. Each toast auto-dismisses.

const TONE_CLASS = {
  info: 'border-info/40 bg-info/10 text-fg',
  ok: 'border-ok/40 bg-ok/10 text-fg',
  warn: 'border-warn/40 bg-warn/10 text-fg',
  crit: 'border-crit/40 bg-crit/10 text-fg',
} as const;

const AUTO_DISMISS_MS = 6000;

export function Toaster() {
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) => setTimeout(() => dismissToast(t.id), AUTO_DISMISS_MS));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismissToast]);

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
      role="status"
      aria-live="polite"
      data-testid="toaster"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-center gap-3 rounded-md border px-3 py-2 text-sm shadow ${TONE_CLASS[toast.tone]}`}
          data-testid="toast"
          data-tone={toast.tone}
        >
          <span className="flex-1">{toast.message}</span>
          <button
            type="button"
            onClick={() => dismissToast(toast.id)}
            className="text-fg-faint hover:text-fg"
            aria-label="Dismiss notification"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
