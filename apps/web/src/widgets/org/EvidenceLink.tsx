import type { ReactNode } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import type { EvidenceLink as Evidence } from './metricLinks.js';

// A metric's evidence link (W20-20, UX_TODO DSH-18/74) that still renders
// where there is no router, as InternalLink does: the KPI row is mounted inside
// the repository Pulse tab, which tests (and any screen rendered on its own)
// mount with no RouterProvider, where TanStack's Link throws.

export function EvidenceLink({
  evidence,
  className,
  testId,
  children,
}: {
  evidence: Evidence;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  const router = useRouter({ warn: false }) as unknown;
  if (!router) {
    let path = evidence.to;
    for (const [k, v] of Object.entries(evidence.params ?? {})) {
      path = path.replace(`$${k}`, encodeURIComponent(v));
    }
    const qs = new URLSearchParams(
      Object.entries(evidence.search ?? {})
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    return (
      <a href={qs ? `${path}?${qs}` : path} className={className} data-testid={testId}>
        {children}
      </a>
    );
  }
  return (
    <Link
      to={evidence.to as never}
      {...(evidence.params ? { params: evidence.params as never } : {})}
      search={(evidence.search ?? {}) as never}
      className={className}
      data-testid={testId}
    >
      {children}
    </Link>
  );
}
