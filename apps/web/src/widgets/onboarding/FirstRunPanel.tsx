import { Link } from '@tanstack/react-router';
import type { MeContext } from '../org/contracts.js';

// The first-run panel (W20-17, UX_TODO INS-17).
//
// The welcome CTA and the setup checklist live only on Overview, but the
// persona picker sends a Security, Developer or Executive first sign-in to
// Findings, My Focus or Reports. Those are empty on a new install and said
// nothing about why, so the admin lost the path to setup. While the workspace
// tracks no repository, every other screen opens with this panel.

/** Screens that already explain an empty install, or are where you fix it. */
const QUIET_PREFIXES = ['/admin', '/account', '/setup', '/print'];

/** Whether to show it. Exported for its test. */
export function showFirstRun(me: MeContext | undefined, pathname: string): boolean {
  if (!me || me.repo_count !== 0) return false;
  if (pathname === '/') return false;
  return !QUIET_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function FirstRunPanel({ me, pathname }: { me: MeContext | undefined; pathname: string }) {
  if (!showFirstRun(me, pathname)) return null;
  const isAdmin = me?.role === 'admin';
  const admins = me?.admin_logins ?? [];
  return (
    <section
      className="mb-4 rounded-md border border-accent/40 bg-accent/5 p-4 text-sm"
      aria-labelledby="first-run-title"
      data-testid="first-run-panel"
    >
      <h2 id="first-run-title" className="font-medium text-fg">
        Nothing is tracked yet
      </h2>
      {isAdmin ? (
        <p className="mt-1 text-fg-muted">
          This page fills in once RepoPulse is reading your repositories. Add a forge connection and
          choose repositories; history starts arriving within minutes.{' '}
          <Link
            to="/admin"
            className="text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="first-run-connect"
          >
            Connect a forge →
          </Link>
        </p>
      ) : (
        <p className="mt-1 text-fg-muted" data-testid="first-run-ask">
          This page fills in once an admin connects a forge and chooses repositories.{' '}
          {admins.length > 0
            ? `Ask an admin (${admins.join(', ')}) to connect one.`
            : 'Ask an admin to connect one.'}
        </p>
      )}
    </section>
  );
}
