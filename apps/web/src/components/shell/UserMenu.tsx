import { useState } from 'react';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { PERSONAS, type MeContext, type Persona } from '../../widgets/org/contracts.js';
import { signOutAndReload, signOutEverywhereAndReload } from '../../widgets/auth/contracts.js';
import { errorToast, useUiStore } from '../store/uiStore.js';

// User menu (UX_SPEC §3.1 rail bottom). Its one job in W4-10 is making the
// persona changeable, which §6 promises — a first-login question with no way to
// revise it is a trap, not a preference.
//
// The button was already in the rail and did nothing.

const ME = { endpoint: '/me/context' } as const;

const LABELS: Record<Persona, string> = {
  lead: 'Team lead',
  developer: 'Developer',
  security: 'Security',
  exec: 'Executive',
};

export function UserMenu() {
  const [open, setOpen] = useState(false);
  const pushToasts = useUiStore((s) => s.pushToasts);
  const { data: me } = useApiQuery<MeContext>(ME);
  const setPersona = useApiMutation<{ persona: Persona }, { persona: Persona; home: string }>(
    { endpoint: '/me/persona', method: 'PATCH' },
    { invalidate: [queryKeyFor(ME)] },
  );

  return (
    <div className="relative">
      <button
        type="button"
        className="rounded-sm px-2 py-1 text-sm text-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        data-testid="user-menu"
        aria-label="User menu"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          aria-label="User menu"
          className="absolute bottom-full right-0 z-40 mb-1 w-52 panel p-2 shadow-lg"
          data-testid="user-menu-panel"
        >
          <p className="px-1 pb-1 text-[11px] uppercase tracking-wide text-fg-faint">Home screen</p>
          {PERSONAS.map((persona) => {
            const current = me?.persona === persona;
            return (
              <button
                key={persona}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                data-testid={`user-menu-persona-${persona}`}
                className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
                onClick={() => {
                  setPersona.mutate({ persona });
                  setOpen(false);
                }}
              >
                {/* Paired mark + aria-checked: the selection is never carried by
                    colour alone. */}
                <span aria-hidden="true" className="w-3">
                  {current ? '✓' : ''}
                </span>
                {LABELS[persona]}
              </button>
            );
          })}
          {/* W20-01 (UX_TODO ADM-02): there was no way to sign out of the app
              short of clearing cookies. */}
          <div className="mt-1 border-t border-border pt-1">
            {/* W20-04 (UX_TODO ADM-04): theme, home screen and password in one
                place, for everyone. A plain link rather than the router's:
                this menu also renders outside a router in its tests, and a
                full load of a settings page costs nothing anyone would notice. */}
            <a
              href="/account"
              role="menuitem"
              data-testid="user-menu-account"
              className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              <span aria-hidden="true" className="w-3" />
              Your account
            </a>
            <button
              type="button"
              role="menuitem"
              data-testid="user-menu-signout"
              className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
              onClick={() => {
                setOpen(false);
                void signOutAndReload();
              }}
            >
              <span aria-hidden="true" className="w-3" />
              Sign out
            </button>
            {/* W20-10 (UX_TODO ADM-78): every session of this account, not just
                this browser's — for the laptop left signed in somewhere else. */}
            <button
              type="button"
              role="menuitem"
              data-testid="user-menu-signout-everywhere"
              className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
              onClick={() => {
                setOpen(false);
                signOutEverywhereAndReload().catch((err: unknown) =>
                  pushToasts([errorToast('signout-everywhere-err', err)]),
                );
              }}
            >
              <span aria-hidden="true" className="w-3" />
              Sign out everywhere
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
