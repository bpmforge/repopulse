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
      // One line (W21-01). W20-17 (ADM-68) let it wrap so a long org/repo
      // crumb could not push the current page off a phone, but then "› #4"
      // wrapped onto a line of its own. Now the trail stays on one line: the
      // ancestors shrink and truncate first (each keeps its full name in
      // `title`), and the current page shrinks only past 70% of the width.
      className="sticky top-0 z-20 flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden border-b border-border bg-bg/85 px-4 pt-1.5 pb-2.5 text-[13px] backdrop-blur"
      aria-label="Breadcrumb"
      data-testid="breadcrumb"
    >
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span
            key={`${crumb.label}-${i}`}
            className={`flex items-center gap-1.5 ${
              isLast ? 'min-w-0 max-w-[70%] shrink-0' : 'min-w-[2.75rem] shrink'
            }`}
            data-testid={isLast ? 'breadcrumb-current' : undefined}
          >
            {i > 0 && (
              <span className="text-fg-faint" aria-hidden="true">
                ›
              </span>
            )}
            {crumb.to && !isLast ? (
              <Link
                to={crumb.to}
                search={search}
                className="truncate text-fg-muted hover:text-fg"
                title={crumb.label}
                data-testid={`breadcrumb-${i}`}
              >
                {crumb.label}
              </Link>
            ) : (
              <span
                className={`truncate ${isLast ? 'font-medium text-fg' : 'text-fg-muted'}`}
                aria-current={isLast ? 'page' : undefined}
                title={crumb.label}
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
