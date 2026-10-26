import type { ReactNode } from 'react';

// Page and section headings (W17-12).
//
// The product had no heading primitive, so every screen picked its own size.
// `text-lg` (18px) was doing duty as a PAGE title on /admin while also being a
// section title elsewhere, which left the two levels indistinguishable — a
// reader could not tell where they were from the type alone.
//
// The scale is the one in IMPLEMENTATION-PLAN.md §4:
//   page title      28–32px   (text-3xl, 30px)
//   section title   18–20px   (text-lg, 18px)
//   body            14px      (text-sm)
//   supporting      12px      (text-xs)
//
// 10px data text is explicitly out. It is unreadable at arm's length and it is
// how a dashboard ends up needing a zoom to answer a question.

export interface PageHeaderProps {
  title: string;
  /** One sentence. What this screen answers, not what it contains. */
  description?: string;
  /** Buttons or filters, right-aligned on wide screens. */
  actions?: ReactNode;
  /** Window/date-range chips and the like, under the title. */
  meta?: ReactNode;
  testId?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  meta,
  testId,
}: PageHeaderProps): React.JSX.Element {
  return (
    <header
      className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
      data-testid={testId ?? 'page-header'}
    >
      <div className="min-w-0 sm:flex-1">
        {/* One h1 per screen. The shell renders no other, so this is the
            document's real heading and a screen-reader user lands on it. */}
        <h1 className="text-3xl font-semibold tracking-tight text-fg">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-fg-muted">{description}</p> : null}
        {meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {/* Not shrink-0 (W21-01): Findings' five actions could not wrap, and
          pushed the page 106px sideways at 768px. They wrap, right-aligned. */}
      {actions ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>
      ) : null}
    </header>
  );
}

export interface SectionHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  /**
   * Heading level. Defaults to h2, which is right under a PageHeader's h1 —
   * skipping a level breaks the outline screen readers navigate by.
   */
  as?: 'h2' | 'h3';
  testId?: string;
}

export function SectionHeader({
  title,
  description,
  actions,
  as = 'h2',
  testId,
}: SectionHeaderProps): React.JSX.Element {
  const Heading = as;
  return (
    <div
      className="flex items-start justify-between gap-3"
      data-testid={testId ?? 'section-header'}
    >
      <div className="min-w-0 sm:flex-1">
        <Heading className="text-lg font-semibold text-fg">{title}</Heading>
        {description ? <p className="mt-0.5 text-xs text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
