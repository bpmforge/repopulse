#!/usr/bin/env node
// Initial-JS budget gate (W7-09, DASHBOARD.md §9).
//
// Measures what the BROWSER actually downloads before it can render: the
// scripts and modulepreloads in dist/index.html, gzipped. Lazily-imported
// chunks (echarts, route chunks) are deliberately excluded — they are the
// point of code splitting, and counting them would punish the fix.
//
// Deliberately dependency-free. size-limit and Lighthouse are not in
// docs/TECH_STACK.md, and adding a tool to weigh a file is not worth a
// stop-and-ask when `gzipSync` is in Node's standard library.

import { gzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'apps/web/dist';
const BUDGET_KB = 200;

const indexHtml = join(DIST, 'index.html');
if (!existsSync(indexHtml)) {
  console.error(
    `\nNo build found at ${DIST}. Run \`pnpm --filter @repopulse/web build\` first.\n` +
      `  (This gate measures the built output — there is nothing to weigh without it.)\n`,
  );
  process.exit(1);
}

const html = readFileSync(indexHtml, 'utf8');
// Both <script src> and <link rel=modulepreload href>: a preloaded module is
// fetched before first paint, so leaving it out would understate the budget.
const assets = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);

if (assets.length === 0) {
  console.error('\nNo entry scripts found in index.html — the build looks wrong.\n');
  process.exit(1);
}

let total = 0;
const rows = assets.map((name) => {
  const bytes = gzipSync(readFileSync(join(DIST, 'assets', name))).byteLength;
  total += bytes;
  return { name, kb: bytes / 1024 };
});

const totalKb = total / 1024;
console.log('\nInitial JS (gzipped, from dist/index.html):');
for (const row of rows) console.log(`  ${row.name.padEnd(42)} ${row.kb.toFixed(1)} KB`);
console.log(`  ${'TOTAL'.padEnd(42)} ${totalKb.toFixed(1)} KB  (budget ${BUDGET_KB} KB)\n`);

if (totalKb > BUDGET_KB) {
  console.error(
    `Initial JS is ${totalKb.toFixed(1)} KB gz, over the ${BUDGET_KB} KB budget (DASHBOARD.md §9).\n\n` +
      `  The usual cause is a module imported as a VALUE where a dynamic import\n` +
      `  would do — that pulls it into the entry chunk and every screen pays for\n` +
      `  it. This is exactly how echarts cost 175 KB on screens with no charts.\n`,
  );
  process.exit(1);
}
