// PR screen contracts (W4-05). Hand-written for the same reason as the org and
// repo contracts: the API declares zod querystrings but no response schemas.
// Source of truth is apps/api/src/routes/prs/index.ts.

export interface PrListItem {
  number: number;
  title: string;
  state: string;
  size_bucket: string;
  review_covered: boolean;
  links: { self: string };
}

export interface PrList {
  items: PrListItem[];
}

export interface PrDetail {
  number: number;
  title: string;
  state: string;
  size_bucket: string;
  opened_at: string;
  merged_at: string | null;
  stage_durations: {
    first_review_at: string | null;
    first_approval_at: string | null;
  };
  reviews: { reviewer: string; state: string; submitted_at: string }[];
  checks: { name: string; conclusion: string | null; status: string }[];
  files: {
    path: string;
    additions: number;
    deletions: number;
    change_type: string;
    links: { file: string };
  }[];
}

/** A stage of the PR timeline, with the duration that produced it. */
export interface Stage {
  label: string;
  /** Hours from the previous milestone; null when the milestone never happened. */
  hours: number | null;
  /** True when the stage is still running (open PR) — drives the pulse. */
  elapsed: boolean;
}

const HOUR = 1000 * 60 * 60;

function hoursBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / HOUR;
}

/**
 * Build the stage timeline (UX_SPEC §4.c).
 *
 * A missing milestone is null, never zero: a PR merged with no review has an
 * absent review stage, and rendering that as "0h to first review" would read as
 * an instantaneous review rather than none at all — the opposite conclusion.
 * The final stage of an unmerged PR is `elapsed`, measured against now.
 */
export function toStages(pr: PrDetail, now: number): Stage[] {
  const { first_review_at, first_approval_at } = pr.stage_durations;
  const stages: Stage[] = [
    {
      label: 'Opened → first review',
      hours: first_review_at ? hoursBetween(pr.opened_at, first_review_at) : null,
      elapsed: false,
    },
    {
      label: 'First review → approved',
      hours:
        first_review_at && first_approval_at
          ? hoursBetween(first_review_at, first_approval_at)
          : null,
      elapsed: false,
    },
    {
      label: 'Approved → merged',
      hours:
        first_approval_at && pr.merged_at ? hoursBetween(first_approval_at, pr.merged_at) : null,
      elapsed: false,
    },
  ];

  if (pr.merged_at === null) {
    // Still open: the last milestone reached is where the clock is running.
    const since = first_approval_at ?? first_review_at ?? pr.opened_at;
    stages.push({
      label: 'Open for',
      hours: (now - Date.parse(since)) / HOUR,
      elapsed: true,
    });
  }
  return stages;
}

/** Total churn of a PR — the number the size bucket is derived from. */
export function totalChurn(files: PrDetail['files']): number {
  return files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
}

export function formatHours(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}
