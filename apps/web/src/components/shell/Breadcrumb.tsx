import { Link } from '@tanstack/react-router';

// Sticky breadcrumb (UX §3.2 drill-down spine): org → repo → PR → file →
// finding. Each hop is a URL segment; clicks and browser-back are equivalent.
// The container derives crumbs from the active route; global search params ride
// along on each link so drill-down preserves window/repos/person (DASHBOARD §1).

export interface Crumb {
  label: string;
  /** Target path; the last (current) crumb usually has none. */
  to?: string;
}

export interface BreadcrumbProps {
  crumbs: Crumb[];
  /** Search params to preserve across breadcrumb navigation. */
  search?: Record<string, string>;
}

export function Breadcrumb({ crumbs, search }: BreadcrumbProps) {
  return (
    <nav
      className="sticky top-0 z-20 flex items-center gap-1.5 border-b border-border bg-bg/80 px-4 py-2 text-sm backdrop-blur"
      aria-label="Breadcrumb"
      data-testid="breadcrumb"
    >
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={`${crumb.label}-${i}`} className="flex items-center gap-1.5">
            {i > 0 && (
              <span className="text-fg-faint" aria-hidden="true">
                ›
              </span>
            )}
            {crumb.to && !isLast ? (
              <Link
                to={crumb.to}
                search={search}
                className="text-fg-muted hover:text-fg"
                data-testid={`breadcrumb-${i}`}
              >
                {crumb.label}
              </Link>
            ) : (
              <span
                className={isLast ? 'font-medium text-fg' : 'text-fg-muted'}
                aria-current={isLast ? 'page' : undefined}
                data-testid={`breadcrumb-${i}`}
              >
                {crumb.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
