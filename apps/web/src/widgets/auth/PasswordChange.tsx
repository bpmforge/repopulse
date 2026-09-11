import { useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SESSION_ENDPOINT, queryKeyFor } from '../../api/useApiQuery.js';
import { LOCAL_SESSION_KEY, abandonPendingSession, changePassword } from './contracts.js';

// The forced password change (W15-04, D14).
//
// A fresh install's first admin comes from ADMIN_EMAIL / ADMIN_PASSWORD, which
// means the credential is written in an env file, a compose file, or a chat
// message before anyone signs in with it. The API models that by issuing a
// session that carries `pendingPasswordChangeUserId` instead of `userId`, so
// every guarded route rejects it — the gate is real, not a redirect this screen
// performs. This screen is therefore not a wall in front of the app; it is the
// only thing such a session is able to do.
//
// The minimum length is stated UP FRONT rather than only as a rejection: the
// API's answer is correct but arrives after someone has already chosen.

/** Mirrors MIN_PASSWORD_LENGTH in packages/auth/src/local/password.ts. */
const MIN_PASSWORD_LENGTH = 12;

export function PasswordChange() {
  const queryClient = useQueryClient();
  const currentId = useId();
  const nextId = useId();
  const confirmId = useId();
  const errorId = useId();
  const hintId = useId();
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  // Held separately from the mutation's error so a local objection (the two new
  // fields disagree) does not have to be laundered through a request that would
  // be rejected anyway — and so it clears the moment the user edits a field.
  const [localError, setLocalError] = useState<string | null>(null);

  const change = useMutation<unknown, Error, { current: string; next: string }>({
    mutationFn: (vars) => changePassword(vars.current, vars.next),
    onSuccess: async () => {
      // The API regenerated the session and promoted it to a real one. Asking
      // the shell to re-decide is what mounts the app; this screen never
      // navigates, because it does not know where the user was going.
      await queryClient.invalidateQueries({ queryKey: LOCAL_SESSION_KEY });
      await queryClient.invalidateQueries({
        queryKey: queryKeyFor({ endpoint: SESSION_ENDPOINT }),
      });
    },
    onError: () => requestAnimationFrame(() => errorRef.current?.focus()),
  });

  const abandon = useMutation<unknown, Error, void>({
    mutationFn: () => abandonPendingSession(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: LOCAL_SESSION_KEY });
    },
  });

  const message = localError ?? change.error?.message ?? null;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (next !== confirm) {
      setLocalError('The two new passwords do not match.');
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    if (next.length < MIN_PASSWORD_LENGTH) {
      setLocalError(`Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    setLocalError(null);
    change.mutate({ current, next });
  }

  const field =
    'rounded-sm border border-border bg-surface-2 px-3 py-2 text-sm text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

  return (
    <div className="flex min-h-screen w-screen items-center justify-center bg-bg p-6 text-fg">
      <main
        className="w-full max-w-sm rounded-md border border-border bg-surface p-6"
        data-testid="password-change"
      >
        <h1 className="text-base font-medium">Choose a new password</h1>
        <p className="mt-2 text-sm text-fg-muted">
          This account was created with a password someone else chose. Until it is replaced, this is
          the only screen it can reach.
        </p>

        <p
          id={errorId}
          ref={errorRef}
          tabIndex={-1}
          aria-live="assertive"
          aria-atomic="true"
          data-testid="password-change-error"
          className={
            message
              ? 'mt-4 rounded-sm border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-fg'
              : 'sr-only'
          }
        >
          {message ?? ''}
        </p>

        <form className="mt-5 flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1">
            <label htmlFor={currentId} className="text-xs text-fg-muted">
              Current password
            </label>
            <input
              id={currentId}
              data-testid="password-current"
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className={field}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={nextId} className="text-xs text-fg-muted">
              New password
            </label>
            <input
              id={nextId}
              data-testid="password-new"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={next}
              onChange={(e) => {
                setNext(e.target.value);
                setLocalError(null);
              }}
              aria-describedby={hintId}
              className={field}
            />
            <p id={hintId} className="text-xs text-fg-faint">
              At least {MIN_PASSWORD_LENGTH} characters, and not the one you were given.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={confirmId} className="text-xs text-fg-muted">
              Repeat new password
            </label>
            <input
              id={confirmId}
              data-testid="password-confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                setLocalError(null);
              }}
              className={field}
            />
          </div>
          <button
            type="submit"
            data-testid="password-submit"
            disabled={change.isPending}
            className="inline-flex w-full items-center justify-center rounded-sm border border-border bg-accent-strong px-3 py-2 text-sm text-accent-fg disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {change.isPending ? 'Saving…' : 'Set new password'}
          </button>
        </form>

        {/* /auth/logout only destroys sessions carrying `userId`, so a pending
            session cannot be logged out there — /auth/local/logout exists for
            exactly this: someone who cannot complete the change must still be
            able to walk away rather than be held on one screen. */}
        <button
          type="button"
          data-testid="password-change-abandon"
          disabled={abandon.isPending}
          onClick={() => abandon.mutate()}
          className="mt-4 text-xs text-fg-muted underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Sign out instead
        </button>
      </main>
    </div>
  );
}
