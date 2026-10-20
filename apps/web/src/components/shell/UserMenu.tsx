import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
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
  admin: 'Administrator',
};

/** The menu's items, in order, for roving arrow-key focus (W20-17, ADM-57). */
function menuItems(panel: HTMLElement | null): HTMLElement[] {
  return panel
    ? [...panel.querySelectorAll<HTMLElement>('[role^="menuitem"]')].filter((el) => !el.hidden)
    : [];
}

export function UserMenu({ placement = 'up' }: { placement?: 'up' | 'down' } = {}) {
  const [open, setOpen] = useState(false);
  const pushToasts = useUiStore((s) => s.pushToasts);
  const { data: me } = useApiQuery<MeContext>(ME);
  const setPersona = useApiMutation<{ persona: Persona }, { persona: Persona; home: string }>(
    { endpoint: '/me/persona', method: 'PATCH' },
    { invalidate: [queryKeyFor(ME)] },
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  // W20-17 (UX_TODO ADM-57): on open, focus the checked item (else the first);
  // a click anywhere outside closes it.
  useEffect(() => {
    if (!open) return;
    const items = menuItems(panelRef.current);
    (items.find((el) => el.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = menuItems(panelRef.current);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if (e.key === 'Tab') setOpen(false);
  };

  const who = me?.login ?? me?.email ?? null;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="min-h-6 min-w-6 rounded-sm px-2 py-1 text-sm text-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        data-testid="user-menu"
        aria-label={who ? `User menu (${who})` : 'User menu'}
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
          ref={panelRef}
          onKeyDown={onMenuKeyDown}
          className={`absolute ${placement === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'} left-0 z-40 w-56 panel p-2 shadow-lg`}
          data-testid="user-menu-panel"
        >
          {/* W20-17 (UX_TODO ADM-54): which account this is, and its role.
              Someone sharing a machine, or an admin checking a promotion
              worked, could not tell. */}
          {me ? (
            <div className="mb-1 border-b border-border px-1 pb-2" data-testid="user-menu-who">
              <p className="truncate text-sm text-fg">{who ?? 'Signed in'}</p>
              <p className="text-xs text-fg-faint">
                {me.role === 'admin' ? 'Admin' : 'Member'}
                {me.workspace?.name ? ` · ${me.workspace.name}` : ''}
              </p>
            </div>
          ) : null}
          <p className="px-1 pb-1 text-[11px] uppercase tracking-wide text-fg-faint">Home screen</p>
          {PERSONAS.filter((p) => p !== 'admin' || me?.role === 'admin').map((persona) => {
            const current = me?.persona === persona;
            return (
              <button
                key={persona}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                data-testid={`user-menu-persona-${persona}`}
                tabIndex={-1}
                className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-sm text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:outline-none"
                onClick={() => {
                  setPersona.mutate({ persona });
                  close(true);
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
              tabIndex={-1}
              className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-sm text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:outline-none"
            >
              <span aria-hidden="true" className="w-3" />
              Your account
            </a>
            <button
              type="button"
              role="menuitem"
              data-testid="user-menu-signout"
              tabIndex={-1}
              className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-sm text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:outline-none"
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
              tabIndex={-1}
              className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-sm text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:outline-none"
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
