import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { PERSONAS, type MeContext, type Persona } from '../org/contracts.js';

// Persona picker (W4-10, UX_SPEC §6, D9/R-A2). One question at first login.
//
// Without this, §6's role-routed homes are unimplementable: admin/member is an
// AUTHORIZATION role and says nothing about which screen someone wants to land
// on — a security reviewer and a tech lead are both "member".
//
// It opens on `persona === null`, never on "persona is not one I recognise":
// null means never asked, and those are different states. The home mapping
// comes from the API's response so the two cannot drift.

const ME = { endpoint: '/me/context' } as const;

const LABELS: Record<Persona, { title: string; blurb: string }> = {
  lead: { title: 'Team lead', blurb: 'Delivery flow and review health across repos' },
  developer: { title: 'Developer', blurb: 'My PRs, my review queue, code I own' },
  security: { title: 'Security', blurb: 'Findings, risk and unreviewed merges' },
  exec: { title: 'Executive', blurb: 'Org-level trends and DORA, no per-person data' },
  // W20-17 (UX_TODO INS-16): offered to admins only.
  admin: { title: 'Administrator', blurb: 'Setup, connections, sync and system health' },
};

/**
 * Whether the picker should ask now (W20-17, UX_TODO INS-16). Never while the
 * bootstrap admin is still setting up (no repositories yet): every option
 * would describe an empty screen, and it interrupted them straight after the
 * password change. Exported for its test.
 */
export function shouldAskPersona(me: MeContext | undefined): boolean {
  if (!me || me.persona !== null) return false;
  if (me.role === 'admin' && me.repo_count === 0) return false;
  return true;
}

const DEFER_KEY = 'repopulse.persona.deferred';

function readDeferred(): boolean {
  try {
    return window.sessionStorage?.getItem(DEFER_KEY) === '1';
  } catch {
    return false;
  }
}

export function PersonaPicker() {
  const navigate = useNavigate();
  // sessionStorage, not component state: "not now" has to survive a page
  // reload, or someone who defers and then follows a link is asked again — and
  // a dialog that keeps coming back after you dismissed it reads as broken.
  // Session-scoped rather than persisted, because the choice is still worth
  // making and `me.persona` stays null until it is.
  const [deferred, setDeferred] = useState(() => readDeferred());
  const defer = () => {
    try {
      window.sessionStorage?.setItem(DEFER_KEY, '1');
    } catch {
      // Private mode, or storage disabled. Deferring for this mount is still
      // better than refusing to close.
    }
    setDeferred(true);
  };
  const { data: me, isSuccess } = useApiQuery<MeContext>(ME);
  const setPersona = useApiMutation<{ persona: Persona }, { persona: Persona; home: string }>(
    { endpoint: '/me/persona', method: 'PATCH' },
    { invalidate: [queryKeyFor(ME)] },
  );

  const open = !deferred && isSuccess && shouldAskPersona(me);
  const dialogRef = useRef<HTMLDivElement>(null);

  // W20-17 (UX_TODO INS-15): a real modal. Focus moves to the first option,
  // everything else in the shell is inert (so neither Tab nor a screen reader
  // reaches the page behind it), and Escape means "Not now".
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.querySelector<HTMLElement>('button')?.focus();
    const siblings = [...(dialog.parentElement?.children ?? [])].filter(
      (el): el is HTMLElement => el !== dialog && el instanceof HTMLElement && !el.inert,
    );
    for (const el of siblings) el.inert = true;
    return () => {
      for (const el of siblings) el.inert = false;
    };
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      defer();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Render nothing until the answer is known. Defaulting to "show it" would
  // flash the dialog at every returning user on a slow request.
  // Deferred for THIS SESSION only. `me.persona` stays null, so the picker
  // returns on the next visit rather than the choice being silently lost.
  if (!open) return null;
  const choices = PERSONAS.filter((p) => p !== 'admin' || me?.role === 'admin');

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="persona-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 p-4"
      data-testid="persona-picker"
      onKeyDown={onKeyDown}
    >
      <div className="w-full max-w-lg rounded-lg border border-border bg-surface p-5 shadow-lg">
        <h2 id="persona-title" className="text-base font-semibold text-fg">
          What best describes you?
        </h2>
        <p className="mt-1 text-xs text-fg-muted">
          This picks your home screen. You can change it any time from the user menu — it does not
          affect what you are permitted to see.
        </p>
        <ul className="mt-4 flex flex-col gap-2">
          {choices.map((persona) => (
            <li key={persona}>
              <button
                type="button"
                data-testid={`persona-${persona}`}
                disabled={setPersona.isPending}
                className="w-full rounded-md border border-border px-3 py-2 text-left hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                onClick={() =>
                  setPersona.mutate(
                    { persona },
                    {
                      // Route from the API's answer, not a local table: the
                      // server owns which screen is a persona's home.
                      //
                      // Only from `/` (W20-15, UX_TODO X-25). The dialog opens
                      // on every route, so a colleague who followed a shared
                      // link to a finding, PR or report lost it the moment they
                      // answered. Anywhere else the persona is saved and they
                      // stay on the page they were sent to.
                      onSuccess: (res) => {
                        if (window.location.pathname === '/') {
                          void navigate({ to: res.home as never });
                        }
                      },
                    },
                  )
                }
              >
                <span className="block text-sm text-fg">{LABELS[persona].title}</span>
                <span className="block text-xs text-fg-muted">{LABELS[persona].blurb}</span>
              </button>
            </li>
          ))}
        </ul>
        {/* W20-17 (UX_TODO INS-16): a failed save said nothing at all. */}
        {setPersona.isError ? (
          <p className="mt-3 text-xs text-crit" role="alert" data-testid="persona-error">
            Could not save your choice ({setPersona.error.message}). Try again, or choose Not now
            and set it later from the user menu.
          </p>
        ) : null}

        {/*
          A WAY PAST IT (W16-26).
          
          This was mandatory, and it intercepted the one action a first run
          sends you to: the welcome state says "Connect your organization to
          start ingesting history", and clicking that button raised this instead.
          At that moment there are no repositories, no PRs and no findings, so
          every option here describes a screen that will be empty — "My PRs, my
          review queue, code I own" for an account with none.
          
          Deferring costs nothing: the copy above already says the choice can be
          changed any time from the user menu, and `me.persona` stays null so
          the dialog returns on the next visit.
        */}
        <button
          type="button"
          data-testid="persona-defer"
          onClick={defer}
          className="mt-4 text-xs text-fg-muted underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
