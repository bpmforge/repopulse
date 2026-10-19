import { Button, ErrorNote, PageHeader } from '../../components/index.js';
import { useUiStore } from '../../components/store/uiStore.js';
import { useApiMutation, useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import { PERSONAS, type MeContext, type Persona } from '../org/contracts.js';
import { PasswordChange } from '../auth/PasswordChange.js';
import { signOutAndReload } from '../auth/contracts.js';

// Your own settings (W20-04, UX_TODO ADM-04).
//
// Members clicked "Settings" in the rail — a word that reads as personal — and
// met "You need an admin role". The workspace's Settings are an admin's, but
// theme, home screen, password and sign-out belong to everyone, and until now
// the only one with a page was none of them: the theme and persona hid in the
// rail's footer and a voluntary password change had no screen at all.

const ME = { endpoint: '/me/context' } as const;

const PERSONA_LABELS: Record<Persona, string> = {
  lead: 'Team lead — the organisation overview',
  developer: 'Developer — My Focus',
  security: 'Security — the review queue',
  exec: 'Executive — reports',
};

export function AccountSettings() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const { data: me } = useApiQuery<MeContext>(ME);
  const setPersona = useApiMutation<{ persona: Persona }, { persona: Persona; home: string }>(
    { endpoint: '/me/persona', method: 'PATCH' },
    { invalidate: [queryKeyFor(ME)] },
  );

  return (
    <div className="flex flex-col gap-4" data-testid="account-settings">
      <PageHeader
        title="Account"
        description={
          me?.workspace?.name
            ? `Your own settings in ${me.workspace.name}. Nothing here changes anyone else’s view.`
            : 'Your own settings. Nothing here changes anyone else’s view.'
        }
      />

      <section className="panel flex max-w-md flex-col gap-2 p-6" aria-labelledby="account-theme">
        <h2 id="account-theme" className="text-base font-medium">
          Theme
        </h2>
        <div className="flex gap-2" role="radiogroup" aria-label="Theme">
          {(['dark', 'light'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={theme === t}
              data-testid={`account-theme-${t}`}
              onClick={() => setTheme(t)}
              className="rounded-md border border-border px-3 py-1.5 text-sm aria-checked:border-accent aria-checked:text-fg text-fg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {t === 'dark' ? 'Dark' : 'Light'}
            </button>
          ))}
        </div>
      </section>

      <section className="panel flex max-w-md flex-col gap-2 p-6" aria-labelledby="account-home">
        <h2 id="account-home" className="text-base font-medium">
          Home screen
        </h2>
        <div className="flex flex-col gap-1" role="radiogroup" aria-label="Home screen">
          {PERSONAS.map((persona) => (
            <label key={persona} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="account-persona"
                checked={me?.persona === persona}
                disabled={setPersona.isPending}
                data-testid={`account-persona-${persona}`}
                onChange={() => setPersona.mutate({ persona })}
              />
              {PERSONA_LABELS[persona]}
            </label>
          ))}
        </div>
        <ErrorNote error={setPersona.error} testId="account-persona-error" />
      </section>

      <PasswordChange variant="account" />

      <section className="panel flex max-w-md flex-col gap-2 p-6" aria-labelledby="account-signout">
        <h2 id="account-signout" className="text-base font-medium">
          Sign out
        </h2>
        <div>
          <Button data-testid="account-signout" onClick={() => void signOutAndReload()}>
            Sign out of RepoPulse
          </Button>
        </div>
      </section>
    </div>
  );
}
