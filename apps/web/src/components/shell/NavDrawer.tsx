import { useCallback, useEffect, useRef } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { navGroups, navTestId, RailIcon } from './Rail.js';
import { RepoPulseWordmark } from '../brand/RepoPulseMark.js';

// The narrow-screen navigation drawer (W17-14).
//
// WHAT THIS REPLACES. Below 768px the rail collapsed to a bare column of nine
// UNLABELLED icons — 56px of a 390px screen, permanently, with nothing but a
// `title` attribute (which a touch device never shows) to say what any of them
// did. Measured on a real phone viewport in the W17-01 baseline.
//
// HAND-ROLLED, deliberately. RP-14 says to reuse an installed accessible
// primitive if one exists; none does — this app has no Radix, no Headless UI,
// and adding a dependency needs a docs/TECH_STACK.md amendment (PLAYBOOK
// refusal conditions), which is not this ticket's call. So the four things a
// dialog primitive would give us are implemented and TESTED here instead:
// Escape closes, focus is trapped, focus returns to the trigger, and choosing a
// destination closes the drawer.

export interface NavDrawerProps {
  open: boolean;
  onClose: () => void;
  isAdmin?: boolean;
  badges?: Record<string, number>;
  search?: Record<string, string>;
  /** Focus returns here on close — the button that opened it. */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}

export function NavDrawer({
  open,
  onClose,
  isAdmin = true,
  badges = {},
  search,
  returnFocusTo,
}: NavDrawerProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const close = useCallback(() => {
    onClose();
    // Focus must land somewhere deliberate. Dropping it on <body> is how a
    // keyboard user ends up back at the top of the document with no idea where
    // they are.
    returnFocusTo?.current?.focus();
  }, [onClose, returnFocusTo]);

  // Escape, and a focus trap. Both live here rather than in a library because
  // there is no library — see the header note.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;

      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;

      // Wrap at both ends, so Tab cannot walk out of an open drawer into the
      // page behind it — which is the whole point of a modal surface.
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  // Move focus INTO the drawer when it opens, or a keyboard user has to tab
  // through the whole page to reach it.
  useEffect(() => {
    if (!open) return;
    const first = panelRef.current?.querySelector<HTMLElement>('a[href], button');
    first?.focus();
  }, [open]);

  if (!open) return null;

  const groups = navGroups(isAdmin);

  return (
    <div className="fixed inset-0 z-50 md:hidden" data-testid="nav-drawer-root">
      {/* Scrim. A click outside is the gesture everyone tries first; it is
          aria-hidden because the drawer's own Close button is the accessible
          route out. */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={close}
        aria-hidden="true"
        data-testid="nav-drawer-scrim"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface"
        id="nav-drawer"
        data-testid="nav-drawer"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-3">
          <RepoPulseWordmark />
          <button
            type="button"
            onClick={close}
            className="rounded-md px-2 py-1 text-sm text-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="nav-drawer-close"
          >
            Close
          </button>
        </div>

        <nav aria-label="Primary" className="flex flex-1 flex-col gap-3 overflow-y-auto py-2">
          {groups.map((group) => (
            <ul key={group.label ?? 'primary'} className="flex flex-col gap-0.5 px-2">
              {group.label ? (
                <li
                  className="px-2.5 pt-2 pb-1 text-xs font-medium uppercase tracking-wide text-fg-faint"
                  aria-hidden="true"
                >
                  {group.label}
                </li>
              ) : null}
              {group.items.map((item) => {
                const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
                const badge = badges[item.to];
                return (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      search={search}
                      // Close AFTER navigating: leaving it open over the screen
                      // the user just asked for is the commonest drawer bug.
                      onClick={close}
                      aria-current={active ? 'page' : undefined}
                      className={`flex items-center gap-2.5 rounded-md px-2.5 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                        active
                          ? 'bg-accent/10 text-fg'
                          : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
                      }`}
                      data-testid={`drawer-${navTestId(item.to)}`}
                    >
                      <span className="flex w-4 shrink-0 items-center justify-center">
                        <RailIcon name={item.icon} />
                      </span>
                      {/* LABELLED, unlike the icon rail this replaces. */}
                      <span className="flex-1 truncate">{item.label}</span>
                      {badge !== undefined && badge > 0 ? (
                        <span className="rounded-full bg-accent/20 px-1.5 text-xs tabular-nums text-accent">
                          {badge}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          ))}
        </nav>
      </div>
    </div>
  );
}
