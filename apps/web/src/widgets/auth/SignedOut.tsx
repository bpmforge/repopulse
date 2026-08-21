import { PasswordChange } from './PasswordChange.js';
import { SignIn } from './SignIn.js';
import { usePendingPasswordChange } from './contracts.js';

// Which screen a visitor without a usable session gets (W15-04).
//
// "Signed out" is two states, not one, and the API cannot tell them apart in
// the answer the shell already has: a session pending a forced password change
// carries no `userId`, so /me/context 401s exactly like a cold visit. Asking
// /auth/local/session is the only way to know, and getting it wrong strands a
// bootstrap admin — the very first person to use a new install — on a sign-in
// form that rejects the password they were handed.

export interface SignedOutProps {
  /** Passed through: "your session ended" reads differently from "hello". */
  expired: boolean;
}

export function SignedOut({ expired }: SignedOutProps) {
  const { pending, ready } = usePendingPasswordChange(true);

  // One round-trip of quiet. Rendering the sign-in form first and swapping it
  // for the password screen a tick later would ask someone to start typing
  // credentials into a form that is about to disappear.
  if (!ready) {
    return (
      <div
        className="flex min-h-screen w-screen items-center justify-center bg-bg text-fg-muted"
        data-testid="signin-probe"
        aria-busy="true"
      >
        <p className="text-sm">Checking your session…</p>
      </div>
    );
  }

  return pending ? <PasswordChange /> : <SignIn expired={expired} />;
}
