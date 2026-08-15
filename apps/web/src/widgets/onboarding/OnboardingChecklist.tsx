import { Link } from '@tanstack/react-router';
import { WidgetFrame } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import type { MeContext, UserPrefs } from '../org/contracts.js';

// Onboarding checklist (W4-10, R-A1). Shown on Org Overview until dismissed.
//
// Two variants, because the admin and member first runs are different problems:
// an admin has setup to do, a member has orientation to do. State lives in
// users.prefs (per-user) rather than workspaces.settings — a workspace-scoped
// dismissal would hide one member's checklist for everyone.
//
// Steps are LINKS, not checkboxes. Nothing here tracks completion, and a
// checkbox that never ticks itself is worse than no checkbox: it implies the
// app is watching progress it is not watching. Connecting is the exception —
// the caller already knows whether repos exist, so that one can honestly show
// as done.

const ME = { endpoint: '/me/context' } as const;

interface Props {
  /** True when the workspace has at least one repo — the only step we can verify. */
  hasRepos: boolean;
}

interface Step {
  label: string;
  to?: string;
  done?: boolean;
}

export function OnboardingChecklist({ hasRepos }: Props) {
  const { data: me } = useApiQuery<MeContext>(ME);
  const dismiss = useApiMutation<UserPrefs, { prefs: UserPrefs }>(
    { endpoint: '/me/prefs', method: 'PATCH' },
    { invalidate: [queryKeyFor(ME)] },
  );

  if (!me || me.prefs?.onboardingDismissed) return null;

  const isAdmin = me.role === 'admin';
  const steps: Step[] = isAdmin
    ? [
        { label: 'Connect your organisation', to: '/admin', done: hasRepos },
        { label: 'Review the bot list and stale-PR window', to: '/admin/settings' },
        { label: 'Assign workspace roles', to: '/admin/members' },
        { label: 'Watch the first sync land', to: '/admin/sync' },
      ]
    : [
        { label: 'See what needs you today', to: '/me' },
        { label: 'Drill into a repository', to: '/repos' },
        { label: 'Follow a pull request end to end', to: '/pull-requests' },
      ];

  return (
    <WidgetFrame title={isAdmin ? 'Finish setting up' : 'Find your way around'} state="ready">
      <div className="flex flex-col gap-3" data-testid="onboarding-checklist">
        <ol className="flex flex-col gap-1.5">
          {steps.map((step) => (
            <li key={step.label} className="flex items-center gap-2 text-sm">
              {/* The mark is paired with text, never colour alone (WCAG). */}
              <span aria-hidden="true" className={step.done ? 'text-ok' : 'text-fg-faint'}>
                {step.done ? '✓' : '○'}
              </span>
              {step.to ? (
                <Link to={step.to as never} className="text-accent hover:underline">
                  {step.label}
                </Link>
              ) : (
                <span>{step.label}</span>
              )}
              {step.done && <span className="sr-only">(done)</span>}
            </li>
          ))}
        </ol>
        <div>
          <button
            type="button"
            className="rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted hover:border-accent hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="onboarding-dismiss"
            disabled={dismiss.isPending}
            onClick={() => dismiss.mutate({ onboardingDismissed: true })}
          >
            Dismiss
          </button>
        </div>
      </div>
    </WidgetFrame>
  );
}
