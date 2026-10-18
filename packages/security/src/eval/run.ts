import {
  SPECIALIST_IDS,
  runSpecialists,
  specialistById,
  type AnalysisGateway,
  type ReviewInput,
} from '@repopulse/analysis';
import { matchFindings } from './match.js';
import { scoreRole, type CaseTally } from './score.js';
import type { EvalCase, EvalRole, ModelEvalRow } from './types.js';

// The evaluation runner (W19-05).
//
// PROVIDER ERRORS ARE REPORTED, NOT SCORED. A connection that dropped halfway
// would otherwise score as "the model found nothing" and drag its recall to
// zero — a number about the network published as a number about the model. A
// case that throws is recorded in `errors` with the provider's own words, the
// role is marked incomplete, and its precision and recall are withheld.
//
// A model that answers but never in the required format (after the one retry)
// IS scored — as having found nothing — and is also counted separately, because
// "cannot follow the output format" is a property of the model.

export interface EvalDeps {
  gateway: AnalysisGateway;
  model: string;
  engine: string;
  seed: number | null;
  temperature: number;
  roles?: readonly EvalRole[];
  contextWindow?: number | null;
  /** Cases run in this many deterministic groups, each sequential. */
  concurrency?: number;
  now?: () => Date;
}

function inputOf(c: EvalCase): ReviewInput {
  if (c.kind === 'diff') {
    return { kind: 'diff', files: c.files.map((f) => ({ path: f.path, patch: f.patch })) };
  }
  if (c.kind === 'file') return { kind: 'file', path: c.path, content: c.content };
  return { kind: 'module', name: c.id, files: c.files };
}

interface Unit {
  role: EvalRole;
  c: EvalCase;
}

export async function evaluateSpecialists(
  cases: Record<EvalRole, EvalCase[]>,
  deps: EvalDeps,
): Promise<Pick<ModelEvalRow, 'roles' | 'errors' | 'complete' | 'checklistVersions'>> {
  const roles = deps.roles ?? SPECIALIST_IDS;
  const units: Unit[] = roles.flatMap((role) => cases[role].map((c) => ({ role, c })));
  const groups = Math.max(1, deps.concurrency ?? 1);
  const buckets: Unit[][] = Array.from({ length: groups }, () => []);
  units.forEach((u, i) => buckets[i % groups]!.push(u));

  const tallies = new Map<string, CaseTally>();
  const errors: ModelEvalRow['errors'] = [];

  await Promise.all(
    buckets.map(async (bucket) => {
      for (const { role, c } of bucket) {
        const key = `${role}\u0000${c.id}`;
        try {
          const run = await runSpecialists(inputOf(c), {
            gateway: deps.gateway,
            only: [role],
            force: true,
            prTitle: 'evaluation fixture',
            meta: { repoId: '0', prNumber: 0, initiator: 'model-eval' },
            contextWindowFor: () => deps.contextWindow ?? null,
          });
          const m = matchFindings(
            run.findings.map((f) => ({
              file: f.file,
              evidence_quote: f.evidence_quote,
              line_range: f.line_range,
            })),
            c.labels,
          );
          tallies.set(key, { errored: false, formatFailure: run.failures.length > 0, ...m });
        } catch (err) {
          errors.push({
            role,
            caseId: c.id,
            error: err instanceof Error ? err.message : String(err),
          });
          tallies.set(key, {
            errored: true,
            formatFailure: false,
            tp: 0,
            fp: 0,
            fn: 0,
            duplicates: 0,
          });
        }
      }
    }),
  );

  const scored: ModelEvalRow['roles'] = {};
  for (const role of roles) {
    scored[role] = scoreRole(cases[role].map((c) => tallies.get(`${role}\u0000${c.id}`)!));
  }
  errors.sort((a, b) => `${a.role}${a.caseId}`.localeCompare(`${b.role}${b.caseId}`));
  return {
    roles: scored,
    errors,
    complete: errors.length === 0,
    checklistVersions: Object.fromEntries(
      roles.map((r) => [r, specialistById(r).checklistVersion]),
    ),
  };
}
