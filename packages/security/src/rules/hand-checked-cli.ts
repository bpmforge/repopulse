import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveHandChecked, type HandCheckedManifest } from './hand-checked.js';

// Regenerates the hand-checked manifest (W21-20) from the marked sheet:
//
//   pnpm --filter @repopulse/security hand-checked           # writes hand-checked.data.ts
//   pnpm --filter @repopulse/security hand-checked --check   # exits 1 if it is stale
//
// The manifest is code, not configuration: a rule goes live on new installs
// because of what is in it, so a change to it is reviewed like any other.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHEET = path.resolve(HERE, '../../../../docs/benchmarks/perf-hand-check/sheet.csv');
const OUT = path.join(HERE, 'hand-checked.data.ts');

export function renderHandCheckedData(manifest: HandCheckedManifest): string {
  return [
    '// GENERATED from docs/benchmarks/perf-hand-check/sheet.csv (the `brad` column) by',
    '// `pnpm --filter @repopulse/security hand-checked` (hand-checked-cli.ts).',
    '// Do not edit by hand: hand-checked.test.ts fails when this file and the',
    '// marked sheet disagree, or when an entry falls below the bar.',
    "import type { HandCheckedManifest } from './hand-checked.js';",
    '',
    `export const HAND_CHECKED_MANIFEST: HandCheckedManifest = ${JSON.stringify(manifest, null, 2)};`,
    '',
  ].join('\n');
}

function main(): void {
  const text = renderHandCheckedData(deriveHandChecked(readFileSync(SHEET, 'utf8')));
  if (process.argv.includes('--check')) {
    if (readFileSync(OUT, 'utf8') !== text) {
      console.error(
        'hand-checked.data.ts is stale; run pnpm --filter @repopulse/security hand-checked',
      );
      process.exit(1);
    }
    return;
  }
  writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
