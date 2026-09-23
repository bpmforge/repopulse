import { useState } from 'react';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { PERSONAS, type MeContext, type Persona } from '../../widgets/org/contracts.js';

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
        </div>
      )}
    </div>
  );
}
