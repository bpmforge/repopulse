import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useUiStore } from '../store/uiStore.js';
import { ThemeToggle } from './ThemeToggle.js';
import { UserMenu } from './UserMenu.js';
import { RepoPulseWordmark } from '../brand/RepoPulseMark.js';

// Left rail (UX §3.1): collapsible 240px/64px. Active item = accent bar + tinted
// background. Bottom: sync-status chip, theme toggle, user menu. PRs/Findings
// carry per-user badge counts (review queue / new-since-lastSeenAt). Links carry
// the global search params so navigation preserves window/repos/person.

type IconName =
  'overview' | 'repos' | 'prs' | 'focus' | 'findings' | 'plans' | 'reports' | 'views' | 'admin';

/**
 * Rail icons: stroke paths on a 24px grid, drawn at 16px in currentColor so
 * they inherit the active/muted nav colour without a per-state variant.
 *
 * These were text glyphs (◈ ▤ ⇄ ◎ ⚑ ◷ ▦ ❏ ⚙) until the UI canvas put all ten
 * screens side by side and made them the one element in the shell that read as
 * placeholder rather than design. Glyphs also render at the mercy of whatever
 * font falls back — the shape was never actually ours.
 *
 * Inline SVG rather than an icon package: nine icons do not justify a
 * dependency, and these ship in the bundle that already renders them.
 */
const ICON_PATHS: Record<IconName, string[]> = {
  overview: ['M3 3h7v7H3z', 'M14 3h7v5h-7z', 'M14 12h7v9h-7z', 'M3 14h7v7H3z'],
  repos: ['M3 5h18v6H3z', 'M3 13h18v6H3z', 'M7 8h.01', 'M7 16h.01'],
  prs: ['M7 7h10', 'M14 4l3 3-3 3', 'M17 17H7', 'M10 14l-3 3 3 3'],
  focus: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  findings: ['M4 21V4', 'M4 4h13l-2 4 2 4H4'],
  plans: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4 6l1.2 1.2L7.5 5', 'M4 12l1.2 1.2L7.5 11'],
  reports: ['M6 3h9l4 4v14H6z', 'M15 3v4h4', 'M9 13h7', 'M9 17h7'],
  views: ['M8 8h13v13H8z', 'M3 16V3h13'],
  admin: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.1 14.2a1.6 1.6 0 0 0 .4 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.4 14H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.8 3.4V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1z',
  ],
};

export function RailIcon({ name }: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      // The label beside it names the destination; when the rail is collapsed
      // the link carries a title and an accessible name. Either way the icon
      // itself is decoration and must not be announced twice.
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  badge?: number;
}

/**
 * Primary destinations (W17-14, IMPLEMENTATION-PLAN.md §4).
 *
 * Nine flat entries became six plus a Workspace group. Nine is past the point
 * where a list is scanned rather than read, and the nine were not peers: three
 * of them (My Focus, Pull Requests, Saved Views) are personal working surfaces,
 * not places you go to answer "what is wrong with our code?".
 *
 * TWO ARE RENAMED IN PRESENTATION ONLY, and the URLs are deliberately untouched:
 * "Findings" reads like a database table, "Reviews" like something you do; and
 * "Admin" describes who may enter rather than what is inside. /findings and
 * /admin still resolve, every bookmark still works, and the admin RBAC gate is
 * exactly where it was.
 */
const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: 'overview' },
  { to: '/repos', label: 'Repositories', icon: 'repos' },
  { to: '/findings', label: 'Reviews', icon: 'findings' },
  { to: '/plans', label: 'Improvement plans', icon: 'plans' },
  { to: '/reports', label: 'Reports', icon: 'reports' },
  { to: '/admin', label: 'Settings', icon: 'admin' },
];

/**
 * The Workspace group — one click away, never deleted.
 *
 * W4-07 had to ADD My Focus to the rail because it was reachable only by typing
 * the URL. Removing these would repeat that mistake, so they are grouped and
 * labelled rather than dropped, and the group shows an active state when you
 * are inside one of them.
 */
const SECONDARY_NAV: NavItem[] = [
  { to: '/me', label: 'My Focus', icon: 'focus' },
  { to: '/pull-requests', label: 'Pull Requests', icon: 'prs' },
  { to: '/views', label: 'Saved Views', icon: 'views' },
];

/**
 * A member's own settings (W20-04, UX_TODO ADM-04). "Settings" reads as
 * personal — theme, password — so a member who clicked it and met "You need an
 * admin role" had been promised something and refused it. Members get THEIR
 * page in that slot; the workspace's Settings stays with admins.
 */
const ACCOUNT_ITEM: NavItem = { to: '/account', label: 'Account', icon: 'admin' };

/** Every destination, in render order. Exported for the narrow-screen drawer. */
export function navGroups(isAdmin: boolean): { label: string | null; items: NavItem[] }[] {
  return [
    {
      label: null,
      items: NAV.map((i) => (i.to === '/admin' && !isAdmin ? ACCOUNT_ITEM : i)),
    },
    { label: 'Workspace', items: SECONDARY_NAV },
  ];
}

export type { NavItem };

/**
 * What a rail badge means, in words (W20-12 DSH-64; W20-17 ADM-62 adds the
 * Settings count of install components that are not working).
 */
export function badgeLabel(to: string, badge: number): string {
  if (to === '/pull-requests')
    return `${badge} ${badge === 1 ? 'review' : 'reviews'} waiting on you`;
  if (to === '/admin') {
    return `${badge} install ${badge === 1 ? 'component is' : 'components are'} not working`;
  }
  return `${badge} new`;
}

/**
 * Test id for a destination, derived from its PATH rather than its label.
 *
 * W17-14 renamed two labels in presentation only, and every rail test broke —
 * because the ids were built from the display text. The path is the stable
 * contract (that is the entire point of renaming presentation and not routes),
 * so it is what the id is built from now. A future rename cannot break a test
 * that is not about naming.
 */
export function navTestId(to: string): string {
  return to === '/' ? 'home' : to.replace(/^\//, '').replace(/\//g, '-');
}

export interface RailProps {
  /** Per-user badge counts keyed by path (e.g. review queue, new findings). */
  badges?: Record<string, number>;
  isAdmin?: boolean;
  search?: Record<string, string>;
}

/**
 * Below this, the rail collapses to icons (W16-05, F21).
 *
 * 768px, matching Tailwind's `md`. At ~800px the expanded rail took 240px of a
 * screen that had none to spare: content was pushed out of view, repository
 * names truncated to "pay…", and the page scrolled sideways. The collapsed
 * state already existed and was only ever reachable by clicking the toggle —
 * which is not much use to someone whose window is already too narrow to read.
 */
const COLLAPSE_BELOW_PX = 768;

export function Rail({ badges = {}, isAdmin = true, search }: RailProps) {
  const stored = useUiStore((s) => s.railCollapsed);
  const toggleRail = useUiStore((s) => s.toggleRail);

  // Narrow WINS over the stored preference, and deliberately does not overwrite
  // it: someone who expanded the rail on a wide screen should still find it
  // expanded when they go back to one, rather than having their choice
  // destroyed by a moment at a small window size.
  const [narrow, setNarrow] = useState(
    typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.innerWidth < COLLAPSE_BELOW_PX,
  );
  useEffect(() => {
    // Guarded: matchMedia is absent in jsdom and in any non-browser render, and
    // an unguarded call there throws while mounting the whole shell — the rail
    // is on every screen, so that is not a small blast radius. Without it the
    // rail simply never auto-collapses, which is the pre-W16-05 behaviour.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const mq = window.matchMedia(`(max-width: ${COLLAPSE_BELOW_PX - 1}px)`);
    const onChange = (e: MediaQueryListEvent | MediaQueryList) => setNarrow(e.matches);
    onChange(mq);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const collapsed = stored || narrow;

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const groups = navGroups(isAdmin);

  return (
    <nav
      className={`flex h-full flex-col border-r border-border bg-[var(--rail-bg)] ${collapsed ? 'w-16' : 'w-60'}`}
      aria-label="Primary"
      data-testid="rail"
      data-collapsed={collapsed}
    >
      <div className="flex items-center justify-between px-3 pt-4 pb-3">
        {/* W17-13: the mark shows in BOTH states. Collapsed, the rail used to
            carry no brand at all — just a column of icons with nothing saying
            what application this is. */}
        <RepoPulseWordmark markOnly={collapsed} />
        {/* Hidden when the window forces the collapse: the button could not
            change anything, and a control that visibly does nothing is worse
            than no control. */}
        <button
          type="button"
          hidden={narrow}
          onClick={toggleRail}
          className="rounded-md px-1.5 py-1 text-fg-faint hover:bg-surface-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="rail-collapse"
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!collapsed}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
        {groups.map((group) => (
          <ul key={group.label ?? 'primary'} className="flex flex-col gap-0.5 px-2">
            {group.label && !collapsed ? (
              <li className="px-2.5 pt-3 pb-1 text-xs font-medium text-fg-faint" aria-hidden="true">
                {group.label}
              </li>
            ) : null}
            {group.label && collapsed ? (
              // Collapsed, a text heading has nowhere to go, so the groups are
              // separated by a rule instead — the grouping still reads.
              <li className="mx-2 my-1 border-t border-border" aria-hidden="true" />
            ) : null}
            {group.items.map((item) => {
              const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
              const badge = badges[item.to];
              return (
                <li key={item.to} className="relative">
                  <Link
                    to={item.to}
                    search={search}
                    className={`group relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm ${
                      active
                        ? 'bg-surface-2 font-medium text-fg'
                        : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg'
                    }`}
                    data-testid={`rail-${navTestId(item.to)}`}
                    aria-current={active ? 'page' : undefined}
                    title={collapsed ? item.label : undefined}
                    // W20-17 (UX_TODO ADM-40): collapsed, the link's name came
                    // only from `title`, which not every reader announces.
                    aria-label={collapsed ? item.label : undefined}
                  >
                    <span
                      className={`flex w-4 shrink-0 items-center justify-center ${active ? 'text-accent' : 'text-fg-faint group-hover:text-fg-muted'}`}
                    >
                      <RailIcon name={item.icon} />
                    </span>
                    {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
                    {!collapsed &&
                      badge !== undefined &&
                      badge > 0 &&
                      item.to !== '/pull-requests' && (
                        <span
                          className={`rounded-full px-1.5 py-px text-[11px] font-medium tabular-nums ${
                            item.to === '/admin'
                              ? 'bg-warn/20 text-warn'
                              : 'bg-accent/15 text-accent'
                          }`}
                          aria-label={badgeLabel(item.to, badge)}
                          title={
                            item.to === '/admin'
                              ? 'System health: open Settings → Connections to see which'
                              : undefined
                          }
                          data-testid={`rail-badge-${navTestId(item.to)}`}
                        >
                          {badge}
                        </span>
                      )}
                  </Link>
                  {/* W20-16 (UX_TODO DSH-64): the Pull Requests count is YOUR
                      review queue, so it is its own link to that queue on My
                      Focus rather than part of the org-wide list's link, where
                      nothing matched the number. */}
                  {!collapsed &&
                    badge !== undefined &&
                    badge > 0 &&
                    item.to === '/pull-requests' && (
                      <Link
                        to="/me"
                        hash="review-queue"
                        search={search}
                        className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full bg-accent/15 px-1.5 py-px text-[11px] font-medium tabular-nums text-accent hover:bg-accent/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                        aria-label={`${badge} ${badge === 1 ? 'review' : 'reviews'} waiting on you — open your review queue`}
                        title="Reviews waiting on you — opens your queue on My Focus"
                        data-testid={`rail-badge-${navTestId(item.to)}`}
                      >
                        {badge}
                      </Link>
                    )}
                </li>
              );
            })}
          </ul>
        ))}
      </div>

      {/* W20-17 (UX_TODO ADM-30): no sync chip here any more. The top bar's
          is on every screen at every width, and two role=status chips made a
          screen reader announce each change twice. */}
      <div className="flex flex-col gap-1 border-t border-border px-3 py-2">
        <div className={`flex items-center ${collapsed ? 'flex-col gap-1' : 'justify-between'}`}>
          <ThemeToggle />
          {/* W4-10: this button existed and did nothing. It now opens the
              persona switcher UX_SPEC §6 promises. W20-17 (ADM-40): kept when
              the rail is collapsed — it holds sign-out. */}
          <UserMenu />
        </div>
      </div>
    </nav>
  );
}
