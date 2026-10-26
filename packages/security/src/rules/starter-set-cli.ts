import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveStarterSet,
  type StarterSetManifest,
  type StarterSetReportInput,
} from './starter-set.js';

// Regenerates the starter-set manifest (W21-04) from the committed benchmark
// report. Run after a new benchmark run:
//
//   pnpm --filter @repopulse/security starter-set           # writes starter-set.data.ts
//   pnpm --filter @repopulse/security starter-set --check   # exits 1 if it is stale
//
// The manifest is code, not configuration: a rule goes live on new installs
// because of what is in it, so a change to it is reviewed like any other.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.resolve(HERE, '../../../../docs/benchmarks/report.json');
const OUT = path.join(HERE, 'starter-set.data.ts');

export function renderStarterSetData(manifest: StarterSetManifest): string {
  return [
    '// GENERATED from docs/benchmarks/report.json by',
    '// `pnpm --filter @repopulse/security starter-set` (starter-set-cli.ts).',
    '// Do not edit by hand: starter-set.test.ts fails when this file and the',
    '// committed report disagree, or when an entry falls below the bar.',
    "import type { StarterSetManifest } from './starter-set.js';",
    '',
    `export const STARTER_SET_MANIFEST: StarterSetManifest = ${JSON.stringify(manifest, null, 2)};`,
    '',
  ].join('\n');
}

function main(): void {
  const report = JSON.parse(readFileSync(REPORT, 'utf8')) as StarterSetReportInput;
  const text = renderStarterSetData(deriveStarterSet(report));
  if (process.argv.includes('--check')) {
    if (readFileSync(OUT, 'utf8') !== text) {
      console.error(
        'starter-set.data.ts is stale; run pnpm --filter @repopulse/security starter-set',
      );
      process.exit(1);
    }
    return;
  }
  writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
