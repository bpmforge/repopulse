// My Focus contracts (W4-07). Source: apps/api/src/routes/me/index.ts.

import type { RepoRef } from '../org/contracts.js';

// Every list on this screen is cross-repo, so `repo` is part of a row's
// identity, not decoration: PR numbers and file paths both repeat across
// repositories, and two rows reading "#5 feature 5" are two different PRs.

export interface MyPr {
  number: number;
  title: string;
  repo_id: number;
  repo: RepoRef;
  state: string;
  size_bucket: string;
  opened_at: string;
  merged_at: string | null;
  /** W20-12 (UX_TODO DSH-42): the stage chip's inputs. Optional: older API. */
  is_draft?: boolean;
  first_review_at?: string | null;
  first_approval_at?: string | null;
  links: { self: string };
}

export interface MyPrs {
  items: MyPr[];
}

export interface ReviewQueueItem {
  number: number;
  title: string;
  repo_id: number;
  repo: RepoRef;
  author: string;
  opened_at: string;
  /**
   * W20-16 (UX_TODO DSH-85). true: the forge says you were asked to review.
   * null: this PR's request list is not captured yet (ingested before the
   * reviewers were), so it is listed by the older rule — open, by someone
   * else, not reviewed by you.
   */
  requested?: boolean | null;
  /**
   * W20-24 (UX_TODO DSH-41): what the wait is measured from. Older API: absent,
   * and `opened_at` is the measure.
   */
  waiting_since?: string;
  waiting_basis?: 'review_request' | 'opened';
  /** 'observed': the request was first seen on a sync, so it is no later than this. */
  request_source?: 'timeline' | 'observed' | null;
  links: { self: string };
}

/** Where a queue row's wait starts, and whether that is the request (W20-24). */
export function waitingOf(row: ReviewQueueItem): {
  since: string;
  fromRequest: boolean;
  approximate: boolean;
} {
  const fromRequest = row.waiting_basis === 'review_request' && !!row.waiting_since;
  return {
    since: fromRequest ? row.waiting_since! : row.opened_at,
    fromRequest,
    approximate: fromRequest && row.request_source === 'observed',
  };
}

export interface ReviewQueue {
  items: ReviewQueueItem[];
}

export interface MyHotspot {
  repo_id: number;
  repo: RepoRef;
  path: string;
  my_lines: number;
  /** W20-12 (UX_TODO DSH-88): the trailing window my_lines is summed over. */
  window_days?: number;
  links: { file: string };
}

export interface MyHotspots {
  items: MyHotspot[];
}

export interface MyStats {
  merged_prs: number;
  median_size: number | null;
  /** W20-12 (UX_TODO DSH-40): the period the counts cover. */
  period?: 'all_time';
}

/**
 * Where an open PR of mine is, and since when (W20-12, UX_TODO DSH-42) —
 * the spec's stage chip. Null for a PR that is no longer open: merged and
 * closed PRs are history, not a stage.
 */
export function prStage(pr: MyPr): { label: string; since: string } | null {
  if (pr.state !== 'open') return null;
  if (pr.is_draft) return { label: 'Draft', since: pr.opened_at };
  if (pr.first_approval_at) return { label: 'Approved — not merged', since: pr.first_approval_at };
  if (pr.first_review_at) return { label: 'In review', since: pr.first_review_at };
  return { label: 'Waiting for first review', since: pr.opened_at };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Review-queue SLA (UX_SPEC §4.f). Anything waiting longer than this is amber.
 * Two days is the default stale threshold the metrics catalog uses for PRs
 * (M8), so the screen and the metric agree rather than inventing a second
 * definition of "too long".
 */
export const REVIEW_SLA_DAYS = 2;

export function ageDays(openedAt: string, now: number): number {
  return (now - Date.parse(openedAt)) / DAY_MS;
}

export function isOverSla(openedAt: string, now: number): boolean {
  return ageDays(openedAt, now) > REVIEW_SLA_DAYS;
}

/** Age as a short human string; never "0d", which reads as brand new when it is hours old. */
export function formatAge(openedAt: string, now: number): string {
  const days = ageDays(openedAt, now);
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  return `${Math.round(days)}d`;
}
