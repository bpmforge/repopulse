import { Link, useRouterState } from '@tanstack/react-router';
import { useUiStore } from '../store/uiStore.js';
import { SyncStatusChip } from '../primitives/SyncStatusChip.js';
import { ThemeToggle } from './ThemeToggle.js';

// Left rail (UX §3.1): collapsible 240px/64px. Active item = accent bar + tinted
// background. Bottom: sync-status chip, theme toggle, user menu. PRs/Findings
// carry per-user badge counts (review queue / new-since-lastSeenAt). Links carry
// the global search params so navigation preserves window/repos/person.

interface NavItem {
  to: string;
  label: string;
  icon: string;
  badge?: number;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Org Overview', icon: '◈' },
  { to: '/repos', label: 'Repos', icon: '▤' },
  { to: '/pull-requests', label: 'Pull Requests', icon: '⇄' },
  { to: '/findings', label: 'Findings', icon: '⚑' },
  { to: '/plans', label: 'Plans', icon: '◷' },
  { to: '/reports', label: 'Reports', icon: '▦' },
  { to: '/views', label: 'Views', icon: '❏' },
  { to: '/admin', label: 'Admin', icon: '⚙' },
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
                <span aria-hidden="true" className="w-4 shrink-0 text-center">
                  {item.icon}
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
          {!collapsed && (
            <button
              type="button"
              className="rounded-sm px-2 py-1 text-sm text-fg-muted hover:text-fg"
              data-testid="user-menu"
              aria-label="User menu"
            >
              ⋯
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
