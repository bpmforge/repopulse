import { Link, useRouterState } from '@tanstack/react-router';
import { useUiStore } from '../store/uiStore.js';
import { SyncStatusChip } from '../primitives/SyncStatusChip.js';
import { ThemeToggle } from './ThemeToggle.js';
import { UserMenu } from './UserMenu.js';

// Left rail (UX §3.1): collapsible 240px/64px. Active item = accent bar + tinted
// background. Bottom: sync-status chip, theme toggle, user menu. PRs/Findings
// carry per-user badge counts (review queue / new-since-lastSeenAt). Links carry
// the global search params so navigation preserves window/repos/person.

type IconName =
  | 'overview'
  | 'repos'
  | 'prs'
  | 'focus'
  | 'findings'
  | 'plans'
  | 'reports'
  | 'views'
  | 'admin';

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

function RailIcon({ name }: { name: IconName }) {
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

const NAV: NavItem[] = [
  { to: '/', label: 'Org Overview', icon: 'overview' },
  { to: '/repos', label: 'Repos', icon: 'repos' },
  { to: '/pull-requests', label: 'Pull Requests', icon: 'prs' },
  // W4-07: the rail had no My Focus entry, so the screen was reachable only by
  // typing the URL — while __root.tsx already carried its breadcrumb label.
  { to: '/me', label: 'My Focus', icon: 'focus' },
  { to: '/findings', label: 'Findings', icon: 'findings' },
  { to: '/plans', label: 'Plans', icon: 'plans' },
  { to: '/reports', label: 'Reports', icon: 'reports' },
  { to: '/views', label: 'Views', icon: 'views' },
  { to: '/admin', label: 'Admin', icon: 'admin' },
];

export interface RailProps {
  /** Per-user badge counts keyed by path (e.g. review queue, new findings). */
  badges?: Record<string, number>;
  isAdmin?: boolean;
  search?: Record<string, string>;
}

export function Rail({ badges = {}, isAdmin = true, search }: RailProps) {
  const collapsed = useUiStore((s) => s.railCollapsed);
  const toggleRail = useUiStore((s) => s.toggleRail);
  const sseConnection = useUiStore((s) => s.sseConnection);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const items = NAV.filter((item) => item.to !== '/admin' || isAdmin);

  return (
    <nav
      className={`flex h-full flex-col border-r border-border bg-surface ${collapsed ? 'w-16' : 'w-60'}`}
      aria-label="Primary"
      data-testid="rail"
      data-collapsed={collapsed}
    >
      <div className="flex items-center justify-between px-3 py-3">
        {!collapsed && <span className="font-semibold text-fg">RepoPulse</span>}
        <button
          type="button"
          onClick={toggleRail}
          className="rounded-sm px-1.5 py-1 text-fg-muted hover:text-fg"
          data-testid="rail-collapse"
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!collapsed}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      <ul className="flex flex-1 flex-col gap-0.5 px-2">
        {items.map((item) => {
          const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
          const badge = badges[item.to];
          return (
            <li key={item.to}>
              <Link
                to={item.to}
                search={search}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm ${
                  active
                    ? 'border-l-2 border-accent bg-accent/10 text-fg'
                    : 'border-l-2 border-transparent text-fg-muted hover:bg-surface-2 hover:text-fg'
                }`}
                data-testid={`rail-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
                aria-current={active ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
              >
                <span className="flex w-4 shrink-0 items-center justify-center">
                  <RailIcon name={item.icon} />
                </span>
                {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
                {!collapsed && badge !== undefined && badge > 0 && (
                  <span className="rounded-full bg-accent/20 px-1.5 text-xs tabular-nums text-accent">
                    {badge}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-1 border-t border-border px-3 py-2">
        {!collapsed && <SyncStatusChip connection={sseConnection} />}
        <div className="flex items-center justify-between">
          <ThemeToggle />
          {/* W4-10: this button existed and did nothing. It now opens the
              persona switcher UX_SPEC §6 promises. */}
          {!collapsed && <UserMenu />}
        </div>
      </div>
    </nav>
  );
}
