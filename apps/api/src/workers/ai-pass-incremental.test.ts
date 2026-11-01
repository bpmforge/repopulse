import { describe, expect, it } from 'vitest';
import {
  planReviewScope,
  quoteStillPresent,
  restrictDiff,
  reviewPromptVersion,
  runSpecialists,
  type AnalysisGateway,
  type CompleteResult,
} from '@repopulse/analysis';
import { planReviewCarry, type PriorReviewFinding } from '@repopulse/insights';

// W23-07, the ticket's scenario with no database: a pull request of 10 files
// reviewed at head A; a push touching ONE file. Exactly that file's chunks reach
// the gateway, the other 9 files' findings are carried, and a finding whose
// quoted line vanished is closed. (The worker wires the same functions to the
// tables; this pins the decisions and what the model is sent.)

const N = 10;
const path = (i: number) => `src/m${i}.ts`;
const quote = (i: number) => `return db.query("SELECT " + id${i});`;
const patchOf = (i: number, extra = '') =>
  `@@ -0,0 +1,3 @@\n+export function f${i}(id${i}) {\n+  ${quote(i)}\n+}${extra}`;

const headA = Array.from({ length: N }, (_, i) => ({ path: path(i), patch: patchOf(i) }));

function countingGateway() {
  const prompts: string[] = [];
  const gateway: AnalysisGateway = {
    async complete(prompt): Promise<CompleteResult> {
      prompts.push(prompt);
      const found = [...prompt.matchAll(/^\+ {2}return db\.query\("SELECT " \+ id(\d+)\);$/gm)].map(
        (m) => ({
          dimension: 'security',
          severity: 4,
          confidence: 4,
          file: path(Number(m[1])),
          line_range: [2, 2],
          title: 'SQL built from a parameter',
          evidence_quote: `+  return db.query("SELECT " + id${m[1]});`,
          rationale: 'concatenated',
          suggested_fix: null,
        }),
      );
      return {
        text: JSON.stringify({ findings: found }),
        model: 'fake',
        tokensIn: 1,
        tokensOut: 1,
        costUsd: null,
        durationMs: 1,
      };
    },
    async health() {
      return { ok: true };
    },
  };
  return { gateway, prompts };
}

const review = (files: { path: string; patch: string }[], gateway: AnalysisGateway) =>
  runSpecialists(
    { kind: 'diff', files },
    {
      gateway,
      only: ['security'],
      force: true,
      prTitle: 'Pull request #7: demo',
      meta: { repoId: '1', prNumber: 7, initiator: 'test' },
    },
  );

const filesIn = (prompts: string[]) =>
  new Set(prompts.flatMap((p) => [...p.matchAll(/src\/m(\d+)\.ts/g)].map((m) => Number(m[1]))));

describe('incremental re-review of a pushed pull request (W23-07)', () => {
  const promptVersion = reviewPromptVersion();
  const prior = { runId: 7, headSha: 'aaaaaaa1', promptVersion, completeAndClean: true };
  const compare = (paths: string[], truncated = false) => ({
    files: paths.map((p) => ({ path: p, status: 'modified' })),
    truncated,
  });

  it('sends only the changed file to the model, carries 9, closes the vanished quote', async () => {
    // Head A: the full review raised one finding per file.
    const a = countingGateway();
    const full = await review(headA, a.gateway);
    expect(full.findings).toHaveLength(N);
    expect(filesIn(a.prompts).size).toBe(N);

    // The push fixes the query in src/m3.ts and nothing else.
    const fixed = `@@ -0,0 +1,3 @@\n+export function f3(id3) {\n+  return db.query("SELECT ?", [id3]);\n+}`;
    const headB = headA.map((f) => (f.path === path(3) ? { ...f, patch: fixed } : f));

    const plan = planReviewScope({
      prior,
      newHeadSha: 'bbbbbbb2',
      promptVersion,
      comparison: compare([path(3)]),
      prFiles: headB.map((f) => f.path),
    });
    if (plan.scope !== 'incremental') throw new Error(`expected incremental, got ${plan.reason}`);
    expect(plan.baseRunId).toBe(7);

    const b = countingGateway();
    const incremental = await review(restrictDiff(headB, plan.changed), b.gateway);
    expect(b.prompts.length).toBeGreaterThan(0);
    // Exactly that file's chunks reach the gateway.
    expect([...filesIn(b.prompts)]).toEqual([3]);
    expect(incremental.findings).toHaveLength(0);

    // The other findings are decided from the NEW full diff.
    const prefix = (id: number): PriorReviewFinding => ({
      id,
      file: path(id),
      evidence: quote(id),
      status: 'open',
    });
    const priorFindings = Array.from({ length: N }, (_, i) => prefix(i));
    const patches = new Map(headB.map((f) => [f.path, f.patch]));
    const carry = planReviewCarry(priorFindings, new Set(), (file, q) =>
      quoteStillPresent(q, patches.get(file)),
    );
    expect(carry.carry).toEqual([0, 1, 2, 4, 5, 6, 7, 8, 9]);
    expect(carry.close).toEqual([3]);
  });

  it('carries a changed file\'s finding whose quote is still in the new diff', () => {
    const headB = headA.map((f) => (f.path === path(3) ? { ...f, patch: patchOf(3, '\n+// note') } : f));
    const patches = new Map(headB.map((f) => [f.path, f.patch]));
    const plan = planReviewCarry(
      [{ id: 3, file: path(3), evidence: quote(3), status: 'open' }],
      new Set(),
      (file, q) => quoteStillPresent(q, patches.get(file)),
    );
    expect(plan).toEqual({ carry: [3], close: [] });
  });

  it('reviews in full when the prompt version changed', () => {
    const plan = planReviewScope({
      prior: { ...prior, promptVersion: 'security@v0' },
      newHeadSha: 'bbbbbbb2',
      promptVersion,
      comparison: compare([path(3)]),
      prFiles: headA.map((f) => f.path),
    });
    expect(plan).toEqual({ scope: 'full', reason: 'prompt_version_changed' });
  });

  it('reviews in full when the compare is truncated or unavailable', () => {
    const args = {
      prior,
      newHeadSha: 'bbbbbbb2',
      promptVersion,
      prFiles: headA.map((f) => f.path),
    };
    expect(planReviewScope({ ...args, comparison: compare([path(3)], true) })).toEqual({
      scope: 'full',
      reason: 'compare_truncated',
    });
    expect(planReviewScope({ ...args, comparison: null })).toEqual({
      scope: 'full',
      reason: 'compare_unavailable',
    });
  });
});
