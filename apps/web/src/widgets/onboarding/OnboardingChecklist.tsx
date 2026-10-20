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
// Steps are LINKS. A step shows as done only where the data says so (W20-17,
// UX_TODO INS-39): connected (repositories exist), the first sync landed (a
// repository is live) and roles assigned (anyone besides you is a member). The
// review step has no fact behind it and never ticks. Dismissed, it comes back
// from Settings → Setup ("Show the setup checklist again").

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
        { label: 'Connect a forge and choose repositories', to: '/admin', done: hasRepos },
        {
          label: 'Watch the first sync land',
          to: '/admin/sync',
          done: (me.live_repo_count ?? 0) > 0,
        },
        { label: 'Review the bot list and stale-PR window', to: '/admin/settings' },
        {
          label: 'Add people and assign roles',
          to: '/admin/members',
          done: (me.member_count ?? 0) > 1,
        },
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
          <span className="ml-2 text-xs text-fg-faint">
            You can bring it back from Settings → Setup.
          </span>
        </div>
      </div>
    </WidgetFrame>
  );
}
