// File drill-down contracts (W4-06). Source of truth is
// apps/api/src/routes/files/index.ts — the API declares no response schemas.

export interface FileDetail {
  path: string;
  /** Per non-merge commit, oldest first. */
  churn_series: { sha: string; authored_at: string; additions: number; deletions: number }[];
  /**
   * 52 contiguous weekly buckets from the API, oldest first, INCLUDING empty
   * weeks — and carrying `rework`, which the browser cannot derive: M1 scopes
   * rework to a prior non-bot touch <21d earlier, across the rename chain, and
   * the per-commit series has neither the bot flag nor the old paths (W4-17).
   */
  weekly_churn: { week: string; gross: number; net: number; rework: number }[];
  owners: { login: string; lines_changed: number; share: number }[];
  /** M2 snapshot series, oldest first — the sparkline. */
  hotspot_history: { computed_at: string; score: number }[];
  prs: {
    number: number;
    title: string;
    state: string;
    author: string;
    merged_at: string | null;
    links: { self: string };
  }[];
  /** Newest touch we hold. NOT a claim that the file was deleted. */
  last_seen_at: string | null;
  /** Rename chain, oldest first, from commit_files.previousPath. */
  previous_paths: { path: string; renamed_at: string }[];
  links: { repo: string };
}

/**
 * How stale the newest touch must be before the screen says so. UX_SPEC §4.d
 * asks for a deleted/renamed banner, and the warehouse cannot tell "deleted"
 * from "nobody has touched it lately" — so the banner reports the last-seen
 * date and says exactly that, rather than asserting a deletion we cannot see.
 */
export const STALE_FILE_DAYS = 90;

/** M3: a file whose top author holds >=80% of changed lines is single-owner. */
export const SINGLE_OWNER_THRESHOLD = 0.8;

// W4-17 REMOVED the browser-side weekly bucketing that stood here.
//
// It was correct for what it could see, and it explicitly refused to compute
// rework because M1 defines rework as a touch with a prior non-bot touch <21d
// earlier — history the per-commit series does not carry. Now that the API
// returns the buckets WITH rework (attributed over the whole ordered sequence,
// across the rename chain), keeping a second implementation that produces
// almost-the-same numbers is how the two quietly diverge.
