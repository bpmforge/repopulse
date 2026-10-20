import { useEffect } from 'react';

// The app-level error screen and the stale-chunk recovery (W20-17, UX_TODO
// INS-57).
//
// Routes are code-split. After an upgrade, a tab left open still holds the old
// hashed chunk names, and its next navigation to a page it has not loaded yet
// asks for a file that no longer exists. There was no handler for that and no
// error component, so the router's raw default error appeared.

const RELOAD_KEY = 'repopulse.chunk-reload-at';
/** One automatic reload per this many ms, so a genuinely missing file cannot loop. */
const RELOAD_GUARD_MS = 60_000;

/** True for the errors a stale code-split chunk produces in each browser. */
export function isChunkLoadError(error: unknown): boolean {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== 'string') return false;
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk [\w-]+ failed|Unable to preload CSS/i.test(
    message,
  );
}

/**
 * Reload once to pick up the new version. Returns false when a reload already
 * happened within the guard window (the caller then shows the error screen).
 */
export function reloadForNewVersion(now = Date.now()): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? '0');
    if (now - last < RELOAD_GUARD_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    // No storage: still reload once; the next failure shows the screen.
  }
  window.location.reload();
  return true;
}

export function AppError({ error }: { error: unknown }) {
  const stale = isChunkLoadError(error);
  // A router-caught stale chunk reloads once, like the vite:preloadError path.
  useEffect(() => {
    if (stale) reloadForNewVersion();
  }, [stale]);
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return (
    <div
      className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-6 text-fg"
      data-testid="app-error"
    >
      <div className="panel max-w-lg p-6" role="alert">
        <h1 className="text-base font-medium">
          {stale ? 'A new version of RepoPulse is available' : 'Something went wrong on this page'}
        </h1>
        <p className="mt-2 text-sm text-fg-muted">
          {stale
            ? 'RepoPulse was upgraded while this tab was open, so this page belongs to the old version. Reload to continue; nothing you saved is lost.'
            : 'This page hit an error it could not recover from. Reloading usually fixes it; if it keeps happening, tell your admin what you were doing.'}
        </p>
        {!stale && typeof message === 'string' && message !== '' ? (
          <p className="mt-2 font-mono text-xs text-fg-faint" data-testid="app-error-detail">
            {message}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-4 rounded-sm border border-border px-2 py-1 text-xs text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="app-error-reload"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
