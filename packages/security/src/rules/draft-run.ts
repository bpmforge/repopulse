import { and, eq, gte } from 'drizzle-orm';
import { read, security, type Database, safeErrorText } from '@repopulse/shared';
import type { AnalysisGateway } from '@repopulse/analysis';
import { acceptDraft, buildDraftPrompt, clusterDismissals } from './intake.js';

// The scheduled rule-drafting pass (W9-07 carry-forward, FR-CH-9).
//
// The pieces existed — clustering, the prompt, the validator that stamps
// `proposed` and `llm_draft` — and nothing called them, because nothing built
// an analysis gateway anywhere in the product. This is the runner.
//
// WHAT IT DOES NOT DO: promote anything. A drafted rule lands `proposed` and
// stays there until an admin reads it. A model drafting a rule from a cluster
// of dismissals is pattern-matching on what people already called wrong, so its
// output is a suggestion about a suggestion — and the one thing worse than no
// rule is a rule nobody chose.

export const DRAFT_PASS_KEY = 'rule_draft_pass';
export const DRAFT_WINDOW_DAYS = 30;

export interface DraftPassDeps {
  db: Database;
  workspaceId: number;
  /** Absent = no Tier-2 host configured. Reported by name, never as success. */
  gateway?: AnalysisGateway | undefined;
  now?: Date;
  /** Cap per pass: a hundred drafts nobody reads is not a hundred rules. */
  maxDrafts?: number;
  minClusterSize?: number;
}

export interface DraftPassResult {
  status: 'succeeded' | 'skipped' | 'failed';
  skippedReason?: 'no_gateway' | 'no_clusters';
  clusters: number;
  drafted: number;
  /** Drafts the validator threw out — counted, because silence would flatter. */
  rejected: number;
  error?: string;
}

export async function runRuleDraftPass(deps: DraftPassDeps): Promise<DraftPassResult> {
  const now = deps.now ?? new Date();
  const empty = { clusters: 0, drafted: 0, rejected: 0 };

  // NAMED, not silent. "No gateway" and "nothing worth drafting" are different
  // answers, and only one of them says anything about the repository.
  if (!deps.gateway) {
    return { status: 'skipped', skippedReason: 'no_gateway', ...empty };
  }

  const since = new Date(now.getTime() - DRAFT_WINDOW_DAYS * 86_400_000);
  const dismissals = await deps.db
    .select({
      ruleId: read.findings.ruleId,
      file: read.findings.file,
      evidence: read.findings.evidence,
    })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, deps.workspaceId),
        eq(read.findings.status, 'dismissed'),
        eq(read.findings.dismissReason, 'false_positive'),
        gte(read.findings.lastSeenAt, since),
      ),
    )
    .limit(500);

  const clusters = clusterDismissals(dismissals, deps.minClusterSize ?? 3);
  if (clusters.length === 0) {
    return { status: 'skipped', skippedReason: 'no_clusters', ...empty, clusters: 0 };
  }

  let drafted = 0;
  let rejected = 0;
  const cap = deps.maxDrafts ?? 3;

  try {
    for (const cluster of clusters.slice(0, cap)) {
      const result = await deps.gateway.complete(buildDraftPrompt(cluster), {
        tier: 'T2',
        maxTokens: 45_000,
        expectJson: true,
        meta: {
          repoId: '0',
          prNumber: 0,
          dimension: 'code_health',
          checklistVersion: 'rule_draft.v1',
          initiator: `scheduler:${DRAFT_PASS_KEY}`,
        },
      });

      let raw: unknown;
      try {
        raw = JSON.parse(result.text);
      } catch {
        rejected += 1;
        continue;
      }

      const draft = acceptDraft(raw, now);
      if (!draft.ok || !draft.rule) {
        rejected += 1;
        continue;
      }
      const rule = draft.rule;

      // PROPOSED, and the status is set by acceptDraft rather than taken from
      // the model. Stored per workspace so two tenants' drafts never merge.
      await deps.db
        .insert(security.ruleRegistry)
        .values({
          workspaceId: deps.workspaceId,
          ruleId: rule.id,
          status: 'proposed',
          provenance: rule.provenance as unknown as Record<string, unknown>,
        })
        .onConflictDoNothing();
      drafted += 1;
    }
  } catch (error) {
    // A gateway failure mid-pass keeps the drafts already stored and reports
    // the error: throwing away three good drafts because the fourth call timed
    // out would be losing work to tidiness.
    return {
      status: 'failed',
      clusters: clusters.length,
      drafted,
      rejected,
      error: safeErrorText(error),
    };
  }

  return { status: 'succeeded', clusters: clusters.length, drafted, rejected };
}
