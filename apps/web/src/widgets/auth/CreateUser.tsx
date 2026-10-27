import { useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeyFor } from '../../api/useApiQuery.js';
import { createLocalUser, type CreatedUser } from './contracts.js';

// Settings → create a local account (W15-04, D14).
//
// There is no signup route and there must never be one (see local.ts): on a LAN
// or a cloud box, an open registration form hands the install to whoever finds
// the URL. So accounts come from first boot or from an admin — and without this
// form, "from an admin" meant a curl command, which is not user management.
//
// Mounted above <Members/> in apps/web/src/routes/admin/members.tsx (W20-01).
//
// The temporary password is the part that has to be got right. The API returns
// it EXACTLY ONCE and it is a scrypt hash afterwards — nothing can recover it —
// so this screen keeps it on view until dismissed, marks it as unrepeatable in
// so many words, and offers a copy button rather than trusting a triple-click
// on a base64url string.

const MEMBERS_KEY = queryKeyFor({ endpoint: '/admin/members' });

/**
 * The ready-to-send invite (W20-19, UX_TODO INS-62; decision 2026-10-20).
 *
 * The sign-in address, the email to sign in with, and what happens first. The
 * one-time password is deliberately NOT in it: an invite is pasted into chat
 * or mail, which keep a copy, so the password travels separately (it is shown
 * once below, with its own Copy button). Built here, in the browser; the API
 * never sees or logs the message.
 */
export function inviteMessage(created: CreatedUser, origin: string): string {
  const url = created.sign_in_url ?? `${origin.replace(/\/+$/, '')}/`;
  const email = created.user.email ?? created.user.login;
  const role = created.role === 'admin' ? ' as an admin' : '';
  return [
    `You have been added to RepoPulse${role}.`,
    `Sign in at ${url} with ${email}.`,
    'I will send your one-time password separately; you will be asked to choose your own when you first sign in.',
  ].join('\n');
}

export function CreateUser() {
  const queryClient = useQueryClient();
  const emailId = useId();
  const nameId = useId();
  const roleId = useId();
  const errorId = useId();
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [copied, setCopied] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);

  const create = useMutation<
    CreatedUser,
    Error,
    { email: string; name?: string; role: 'member' | 'admin' }
  >({
    mutationFn: (vars) => createLocalUser(vars),
    onSuccess: async () => {
      setEmail('');
      setName('');
      setRole('member');
      setCopied(false);
      setInviteCopied(false);
      // The API adds the new user to the workspace immediately so they appear
      // in Members without waiting for a first sign-in — which only helps if
      // the list is refetched.
      await queryClient.invalidateQueries({ queryKey: MEMBERS_KEY });
    },
    onError: () => requestAnimationFrame(() => errorRef.current?.focus()),
  });

  const created = create.data;
  const field =
    'rounded-sm border border-border bg-surface-2 px-3 py-2 text-sm text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

  return (
    <section className="panel p-4" data-testid="create-user" aria-labelledby="create-user-title">
      <h3 id="create-user-title" className="text-sm font-medium text-fg">
        Add a member
      </h3>
      <p className="mt-1 text-xs text-fg-muted">
        Creates a local account with a one-time password. They must choose their own before they can
        reach anything. You get a ready-to-send invite with the sign-in address.
      </p>

      <p
        id={errorId}
        ref={errorRef}
        tabIndex={-1}
        aria-live="assertive"
        aria-atomic="true"
        data-testid="create-user-error"
        className={
          create.error
            ? 'mt-3 rounded-sm border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-fg'
            : 'sr-only'
        }
      >
        {create.error ? create.error.message : ''}
      </p>

      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({ email, role, ...(name.trim() !== '' ? { name: name.trim() } : {}) });
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={emailId} className="text-xs text-fg-muted">
            Email
          </label>
          <input
            id={emailId}
            data-testid="create-user-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={create.error ? errorId : undefined}
            className={field}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className="text-xs text-fg-muted">
            Name <span className="text-fg-faint">(optional)</span>
          </label>
          <input
            id={nameId}
            data-testid="create-user-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={field}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={roleId} className="text-xs text-fg-muted">
            Role
          </label>
          <select
            id={roleId}
            data-testid="create-user-role"
            value={role}
            onChange={(e) => setRole(e.target.value === 'admin' ? 'admin' : 'member')}
            className={field}
          >
            <option value="member">Member: reads every screen</option>
            <option value="admin">
              Admin: also changes connections, members, models and policy
            </option>
          </select>
        </div>
        <button
          type="submit"
          data-testid="create-user-submit"
          disabled={create.isPending}
          className="inline-flex items-center justify-center self-start rounded-md border border-border px-3 py-1.5 text-xs text-fg hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          {create.isPending ? 'Creating…' : 'Create account'}
        </button>
      </form>

      {created ? (
        <div
          className="mt-4 rounded-sm border border-border bg-surface-2 p-3"
          data-testid="create-user-result"
          role="status"
        >
          <p className="text-xs text-fg">
            <strong>{created.user.email ?? created.user.login}</strong> can now sign in
            {created.role === 'admin' ? ' as an admin' : ''}
            {created.sign_in_url ? (
              <>
                {' '}
                at{' '}
                <span className="font-mono" data-testid="create-user-sign-in-url">
                  {created.sign_in_url}
                </span>
              </>
            ) : null}
            .
          </p>
          <div className="mt-2" data-testid="create-user-invite">
            <p className="text-xs text-fg-muted">
              Invite to send them. It leaves the password out on purpose: send that separately, so
              no chat or mail log holds both.
            </p>
            <pre
              className="mt-1 whitespace-pre-wrap rounded-sm border border-border bg-surface px-2 py-1 font-mono text-xs text-fg"
              data-testid="create-user-invite-text"
            >
              {inviteMessage(created, window.location.origin)}
            </pre>
            <button
              type="button"
              data-testid="create-user-copy-invite"
              className="mt-1 rounded-md border border-border px-2 py-1 text-xs text-fg hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(inviteMessage(created, window.location.origin))
                  .then(() => setInviteCopied(true))
                  .catch(() => setInviteCopied(false));
              }}
            >
              {inviteCopied ? 'Invite copied' : 'Copy invite message'}
            </button>
          </div>
          {created.temporary_password ? (
            <>
              <p className="mt-2 text-xs text-fg-muted">
                Their one-time password. This is the only time it can be read — RepoPulse stores
                only a hash, so nobody, including you, can retrieve it again.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code
                  className="flex-1 truncate rounded-sm border border-border bg-surface px-2 py-1 font-mono text-xs text-fg"
                  data-testid="create-user-temp-password"
                >
                  {created.temporary_password}
                </code>
                <button
                  type="button"
                  data-testid="create-user-copy"
                  className="rounded-md border border-border px-2 py-1 text-xs text-fg hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  onClick={() => {
                    const value = created.temporary_password as string;
                    // Clipboard access can be refused (insecure origin, denied
                    // permission). The password stays on screen and selectable
                    // either way, so a failure here costs nothing and must not
                    // claim success.
                    void navigator.clipboard
                      ?.writeText(value)
                      .then(() => setCopied(true))
                      .catch(() => setCopied(false));
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </>
          ) : (
            <p className="mt-2 text-xs text-fg-muted">
              They sign in with the password you supplied, then must change it.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
