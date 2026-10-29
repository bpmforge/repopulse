#!/usr/bin/env node
// How often the AI judge's quick first look agrees with the main model (W22-14).
//
// With a triage_fast route, each rule hit goes to a small model first. A
// confident likely false positive stands (ai_triage_verdicts.pass = 'fast');
// anything else escalates to the triage model, whose verdict is stored
// (pass = 'full') with the small model's answer beside it in `fast_pass`
// ({verdict, confidence, reason, model, ms}; migration 0064). This prints, from
// those stored rows:
//
//   - the agreement matrix: fast verdict -> full verdict, on escalated hits
//     where both answered;
//   - why hits escalated (low_confidence / not_false_positive / rejected /
//     provider_error) and the mean time of each pass;
//   - the estimated precision of a fast "likely false positive" by its
//     confidence: of escalated hits where the fast model said likely FP at
//     that confidence (below the current threshold, so the main model judged
//     them), how often the main model agreed. That is the evidence for moving
//     AI_JUDGE_FAST_MIN_CONFIDENCE down. Hits the fast pass cleared at or above
//     the threshold were never checked by the main model, so their precision is
//     NOT measured here (counted as "fast cleared, unchecked").
//
// READ ONLY (a read-only transaction) and WORKSPACE-FILTERED (Law 5):
//
//   node scripts/judge-agreement.mjs --workspace 1 [--repo 7 | --repo org/name] [--json]
//
// DATABASE_URL comes from the environment (or .env when dotenv is present).
// The threshold shown is AI_JUDGE_FAST_MIN_CONFIDENCE (default 0.8 = 4 of 5).

import { createRequire } from 'node:module';

try {
  await import('dotenv/config');
} catch {
  // No dotenv: DATABASE_URL must be in the environment.
}

// `postgres` is a dependency of @repopulse/shared, not of the workspace root.
const shared = createRequire(new URL('../packages/shared/package.json', import.meta.url));
const postgres = shared('postgres');

function usage(msg) {
  if (msg) console.error(msg);
  console.error(
    'usage: node scripts/judge-agreement.mjs --workspace <id> [--repo <id|org/name>] [--json]',
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const workspace = Number(opt('--workspace'));
if (!Number.isInteger(workspace) || workspace <= 0) usage('--workspace <id> is required');
const repoArg = opt('--repo');
const asJson = args.includes('--json');
const share = Number(process.env.AI_JUDGE_FAST_MIN_CONFIDENCE);
const threshold = Number.isFinite(share) && share > 0 && share <= 1 ? share : 0.8;
const url = process.env.DATABASE_URL;
if (!url) usage('DATABASE_URL is not set');

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const out = await sql.begin('read only', async (tx) => {
    let repoId = null;
    if (repoArg !== undefined) {
      const [r] = /^\d+$/.test(repoArg)
        ? await tx`select id from repos where workspace_id = ${workspace} and id = ${Number(repoArg)}`
        : await tx`select id from repos where workspace_id = ${workspace}
                   and org || '/' || name = ${repoArg}`;
      if (!r) usage(`no repo ${repoArg} in workspace ${workspace}`);
      repoId = Number(r.id);
    }
    // Judge verdict rows of this workspace (and repo), newest-first irrelevant.
    const scope = tx`
      v.workspace_id = ${workspace}
      and r.workspace_id = ${workspace}
      and r.mode = 'judge'
      and v.pass is not null
      ${repoId === null ? tx`` : tx`and r.repo_id = ${repoId}`}`;
    const passes = await tx`
      select v.pass, count(*)::int as n,
             count(*) filter (where v.fast_pass is not null)::int as with_fast
      from ai_triage_verdicts v join ai_pass_runs r on r.id = v.ai_pass_run_id
      where ${scope}
      group by v.pass order by v.pass`;
    const matrix = await tx`
      select v.fast_pass->>'verdict' as fast, v.verdict as full, count(*)::int as n
      from ai_triage_verdicts v join ai_pass_runs r on r.id = v.ai_pass_run_id
      where ${scope} and v.pass = 'full' and v.fast_pass->>'verdict' is not null
      group by 1, 2 order by 1, 2`;
    const reasons = await tx`
      select v.fast_pass->>'reason' as reason, count(*)::int as n,
             round(avg((v.fast_pass->>'ms')::numeric))::int as fast_ms_avg
      from ai_triage_verdicts v join ai_pass_runs r on r.id = v.ai_pass_run_id
      where ${scope} and v.pass = 'full' and v.fast_pass is not null
      group by 1 order by 1`;
    const byConfidence = await tx`
      select (v.fast_pass->>'confidence')::int as confidence, count(*)::int as n,
             count(*) filter (where v.verdict = 'likely_false_positive')::int as agreed
      from ai_triage_verdicts v join ai_pass_runs r on r.id = v.ai_pass_run_id
      where ${scope} and v.pass = 'full'
        and v.fast_pass->>'verdict' = 'likely_false_positive'
      group by 1 order by 1 desc`;
    return { repoId, passes, matrix, reasons, byConfidence };
  });

  const answered = out.matrix.reduce((s, r) => s + r.n, 0);
  const agreed = out.matrix.filter((r) => r.fast === r.full).reduce((s, r) => s + r.n, 0);
  const lowFp = out.byConfidence.filter((r) => r.confidence / 5 < threshold);
  const lowN = lowFp.reduce((s, r) => s + r.n, 0);
  const lowAgreed = lowFp.reduce((s, r) => s + r.agreed, 0);
  const pct = (a, b) => (b === 0 ? null : Math.round((1000 * a) / b) / 10);
  const report = {
    workspace,
    repo: out.repoId,
    threshold,
    passes: Object.fromEntries(out.passes.map((p) => [p.pass, p.n])),
    escalated_with_fast_record: out.passes.find((p) => p.pass === 'full')?.with_fast ?? 0,
    fast_vs_full: Object.fromEntries(out.matrix.map((r) => [`${r.fast}->${r.full}`, r.n])),
    agreement: { both_answered: answered, agreed, pct: pct(agreed, answered) },
    escalation_reasons: out.reasons,
    fp_precision_by_confidence: out.byConfidence.map((r) => ({
      ...r,
      pct: pct(r.agreed, r.n),
    })),
    fp_clear_precision_below_threshold: { n: lowN, agreed: lowAgreed, pct: pct(lowAgreed, lowN) },
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const p = (s) => console.log(s);
    p(
      `Judge fast-vs-full agreement - workspace ${workspace}${out.repoId === null ? '' : `, repo ${out.repoId}`}`,
    );
    p(
      `Stored judge verdicts: fast cleared (unchecked by the main model) ${report.passes.fast ?? 0}, full ${report.passes.full ?? 0} (${report.escalated_with_fast_record} with a fast answer kept)`,
    );
    p('');
    p('Agreement matrix (fast -> full), escalated hits where both answered:');
    if (out.matrix.length === 0) p('  (none yet)');
    for (const r of out.matrix) p(`  ${`${r.fast} -> ${r.full}`.padEnd(48)} ${r.n}`);
    p(
      `  agreed ${agreed} of ${answered}${answered ? ` (${report.agreement.pct}%)` : ''}`,
    );
    p('');
    p('Why hits escalated (mean fast-pass ms):');
    if (out.reasons.length === 0) p('  (none yet)');
    for (const r of out.reasons) p(`  ${String(r.reason).padEnd(20)} ${r.n}  (${r.fast_ms_avg} ms)`);
    p('');
    p(`Fast "likely false positive" precision by confidence (threshold ${threshold} = ${threshold * 5} of 5):`);
    if (out.byConfidence.length === 0) p('  (none yet)');
    for (const r of out.byConfidence)
      p(`  confidence ${r.confidence}: full agreed ${r.agreed} of ${r.n} (${pct(r.agreed, r.n)}%)`);
    p(
      `Estimated FP-clear precision below the threshold: ${lowAgreed} of ${lowN}${lowN ? ` (${report.fp_clear_precision_below_threshold.pct}%)` : ''}`,
    );
  }
} finally {
  await sql.end({ timeout: 5 });
}
