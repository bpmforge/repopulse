import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPECIALIST_IDS } from '@repopulse/analysis';
import type { EvalCase, EvalRole } from './types.js';

export const EVAL_FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/eval',
);

export function loadEvalCases(dir: string = EVAL_FIXTURES_DIR): Record<EvalRole, EvalCase[]> {
  const out = {} as Record<EvalRole, EvalCase[]>;
  for (const role of SPECIALIST_IDS) {
    const file = JSON.parse(readFileSync(path.join(dir, `${role}.json`), 'utf8')) as {
      role: string;
      cases: EvalCase[];
    };
    out[role] = file.cases;
  }
  return out;
}
