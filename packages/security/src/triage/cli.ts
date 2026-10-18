import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnalysisGateway } from '@repopulse/analysis';
import {
  candidateOf,
  loadTriageCases,
  renderTriageEval,
  scoreModel,
  upsertRow,
  type TriageEvalFile,
} from './eval.js';
import { runTriage } from './run.js';
import { TRIAGE_CHECKLIST_VERSION, type TriageProposal } from './types.js';

// Scores one model on the labelled cases and updates the published table.
//
//   npx tsx packages/security/src/triage/cli.ts \
//     --base-url http://localhost:1234/v1 --model <model id> [--concurrency 4]
//
// Flags, not environment variables: this is a developer tool, and every
// environment variable the shipped code reads must be in the configuration
// reference (config-doc.test.ts).
//
// Cases are run in `--concurrency` groups (default 4): one call per case
// against a reasoning model takes minutes, and a server that allows parallel
// requests (LM Studio does) turns that into a quarter of the time.

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs');
const JSON_FILE = path.join(DOCS, 'triage-eval.json');
const MD_FILE = path.join(DOCS, 'TRIAGE_EVAL.md');

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const baseUrl = flag('base-url');
const model = flag('model');
if (!baseUrl || !model) {
  console.error('usage: cli.ts --base-url <url> --model <id> [--concurrency N]');
  process.exit(2);
}
const groups = Number(flag('concurrency') ?? 4);

const { note, cases } = loadTriageCases();
const gateway = createAnalysisGateway({
  hosts: [{ baseUrl, modelSlot: model, providerId: 1, name: model }],
  concurrencyCap: groups,
});

const slots = Array.from({ length: groups }, () => [] as typeof cases);
cases.forEach((c, i) => slots[i % groups]!.push(c));

const started = Date.now();
const results = await Promise.all(
  slots.map((slot) =>
    runTriage(
      slot.map((c) => candidateOf(c)),
      {
        gateway,
        limit: 25,
        meta: { repoId: '0', prNumber: 0, initiator: 'triage-eval' },
      },
    ),
  ),
);
const proposals: TriageProposal[] = results.flatMap((r) => r.proposals);
const rejections = results.flatMap((r) => r.rejections);

const row = scoreModel({
  model,
  ranAt: new Date().toISOString(),
  checklistVersion: TRIAGE_CHECKLIST_VERSION,
  cases,
  proposals,
});

const current: TriageEvalFile = existsSync(JSON_FILE)
  ? (JSON.parse(readFileSync(JSON_FILE, 'utf8')) as TriageEvalFile)
  : { schema: 1, rows: [] };
const next = upsertRow(current, row);
writeFileSync(JSON_FILE, `${JSON.stringify(next, null, 2)}\n`);
writeFileSync(MD_FILE, renderTriageEval(next, note));

console.log(
  JSON.stringify(
    { secs: Math.round((Date.now() - started) / 1000), ...row, cases: undefined },
    null,
    1,
  ),
);
for (const r of rejections) console.log('rejected:', r.dedupKey, r.reason, '-', r.detail);
