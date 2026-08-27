import { useState } from 'react';
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
};

export function PersonaPicker() {
  const navigate = useNavigate();
  const [deferred, setDeferred] = useState(false);
  const { data: me, isSuccess } = useApiQuery<MeContext>(ME);
  const setPersona = useApiMutation<{ persona: Persona }, { persona: Persona; home: string }>(
    { endpoint: '/me/persona', method: 'PATCH' },
    { invalidate: [queryKeyFor(ME)] },
  );

  // Render nothing until the answer is known. Defaulting to "show it" would
  // flash the dialog at every returning user on a slow request.
  // Deferred for THIS visit only — nothing is persisted, so the picker returns
  // next time rather than being silently lost.
  if (deferred) return null;
  if (!isSuccess || me?.persona !== null) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="persona-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 p-4"
      data-testid="persona-picker"
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
          {PERSONAS.map((persona) => (
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
                      onSuccess: (res) => void navigate({ to: res.home as never }),
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
          onClick={() => setDeferred(true)}
          className="mt-4 text-xs text-fg-muted underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Not now — I want to finish setting up
        </button>
      </div>
    </div>
  );
}
