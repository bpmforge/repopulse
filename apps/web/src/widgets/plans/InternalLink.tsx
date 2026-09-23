import type { ReactNode } from 'react';
import { Link, useRouter } from '@tanstack/react-router';

// An in-app link that still renders where there is no router (W17-24).
//
// The plan widgets are mounted inside the finding detail panel, which other
// screens (the triage queue, the performance review) render on their own and
// which its tests render with no RouterProvider at all. TanStack's Link needs
// the router to build its href; without one it throws. Here the router is
// asked for without the warning, and when there is none the link degrades to
// a plain anchor with the same href — a full navigation instead of a client
// one, which is a slower path to the same screen rather than a crash.

export interface InternalLinkProps {
  to: string;
  search?: Record<string, string>;
  className?: string;
  testId?: string;
  children: ReactNode;
}

export function InternalLink({ to, search, className, testId, children }: InternalLinkProps) {
  const router = useRouter({ warn: false }) as unknown;
  if (!router) {
    const qs = new URLSearchParams(search ?? {}).toString();
    return (
      <a href={qs ? `${to}?${qs}` : to} className={className} data-testid={testId}>
        {children}
      </a>
    );
  }
  return (
    <Link to={to} search={search} className={className} data-testid={testId}>
      {children}
    </Link>
  );
}
