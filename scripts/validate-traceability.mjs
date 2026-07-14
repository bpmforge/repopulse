#!/usr/bin/env node
// validate-traceability.mjs — RepoPulse design-package coverage validator.
// The objective VERIFY step of the wave-gate Ralph Wiggum loop (PLAYBOOK.md):
// replaces "the docs feel complete" with checkable facts. No dependencies.
//
// HARD FAILURES (exit 1) — dangling references:
//   F1  a doc path referenced in plan.json does not exist on disk
//   F2  an FR/NFR id cited by a ticket is not defined in docs/SRS.md
//   F3  an S-x cited in docs/SRS.md is not defined in docs/SCOPE.md
//   F4  a D-x cited in docs/SCOPE.md is not defined in the founding brief
//   F5  a ticket's stories[] entry is not a story defined in docs/USER_STORIES.md
//   F6  a story header cites an FR/NFR id not defined in docs/SRS.md
// COVERAGE REPORT (warnings, exit 0) — feeds the GAP step:
//   W1  FR ids defined in the SRS but cited by zero plan.json tickets
//   W2  design docs under docs/design/ never referenced by any ticket
//   W3  stories covered by zero tickets (stories[] linkage)

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const srs = read('docs/SRS.md');
const scope = read('docs/SCOPE.md');
const brief = read('docs/work/FOUNDING_BRIEF.md');
const plan = JSON.parse(read('plan.json'));
const planText = plan.tickets.map((t) => [t.title, ...t.acceptance, ...(t.notes || [])].join('\n')).join('\n');

const uniq = (arr) => [...new Set(arr)];
const idsIn = (text, re) => uniq([...text.matchAll(re)].map((m) => m[1]));

// Definitions: FR/NFR rows in SRS tables ("| FR-X-n |") or bold prose ("**FR-METRICS-n").
const FR_DEF_RE = /(?:^\| |\*\*)((?:FR|NFR)-[A-Z]+-\d+|NFR-\d+)\b/gm;
const frDefined = idsIn(srs, FR_DEF_RE);
const sDefined = idsIn(scope, /^\| (S-\d+)\b/gm);
const dDefined = idsIn(brief, /^\| (D\d+)\b/gm);

// Citations support slash-compounds: "FR-METRICS-5/6" cites both 5 and 6.
const expandCitations = (text) => {
  const out = [];
  for (const m of text.matchAll(/\b((?:FR|NFR)-[A-Z]+-|NFR-)(\d+(?:\/\d+)*)\b/g)) {
    for (const n of m[2].split('/')) out.push(`${m[1]}${n}`);
  }
  return uniq(out);
};
const frCited = expandCitations(planText);
const sCitedInSrs = idsIn(srs, /\b(S-\d+)\b/g);
const dCitedInScope = idsIn(scope, /\b(D\d+)\b/g).filter((d) => /^D\d+$/.test(d));

const failures = [];
const warnings = [];

// F1 — every docs/ path mentioned in plan.json exists, EXCEPT deliverables a ticket
// itself creates (path appears in some ticket's write_scope).
const deliverables = new Set(plan.tickets.flatMap((t) => t.write_scope));
const docRefs = uniq([...planText.matchAll(/\bdocs\/[A-Za-z0-9_./-]+\.md\b/g)].map((m) => m[0]));
for (const p of docRefs) {
  if (existsSync(path.join(ROOT, p))) continue;
  if ([...deliverables].some((w) => w === p || p.startsWith(w.replace(/\*\*?$/, '')))) continue;
  failures.push(`F1 missing doc referenced by tickets: ${p}`);
}

// F2 — ticket-cited FR/NFR ids are defined.
for (const id of frCited) if (!frDefined.includes(id)) failures.push(`F2 ticket cites undefined requirement id: ${id}`);

// F3 / F4 — S and D chains hold.
for (const s of sCitedInSrs) if (!sDefined.includes(s)) failures.push(`F3 SRS cites undefined scope item: ${s}`);
for (const d of dCitedInScope) if (!dDefined.includes(d)) failures.push(`F4 SCOPE cites undefined brief decision: ${d}`);

// W1 — FR coverage map (the INVENTORY for the GAP step).
const uncovered = frDefined.filter((id) => !frCited.includes(id));
for (const id of uncovered) warnings.push(`W1 requirement defined but cited by no ticket: ${id}`);

// F5/F6/W3 — story linkage (part-2 chain: story ↔ ticket).
const storiesMd = read('docs/USER_STORIES.md');
const storyHeaders = [...storiesMd.matchAll(/^### (E\d+\.\d+) .*?—.*?—\s*(.+)$/gm)];
const storyIds = storyHeaders.map((m) => m[1]);
for (const [id, frText] of storyHeaders.map((m) => [m[1], m[2]])) {
  for (const fr of expandCitations(frText)) {
    if (!frDefined.includes(fr)) failures.push(`F6 story ${id} cites undefined requirement: ${fr}`);
  }
}
const storyCovered = new Set();
for (const t of plan.tickets) {
  for (const s of t.stories || []) {
    if (!storyIds.includes(s)) failures.push(`F5 ticket ${t.id} cites undefined story: ${s}`);
    storyCovered.add(s);
  }
}
for (const s of storyIds) if (!storyCovered.has(s)) warnings.push(`W3 story covered by zero tickets: ${s}`);

// W2 — orphan design docs.
for (const f of readdirSync(path.join(ROOT, 'docs/design'))) {
  const rel = `docs/design/${f}`;
  if (!planText.includes(rel)) warnings.push(`W2 design doc never referenced by a ticket: ${rel}`);
}

console.log(`Inventory: ${frDefined.length} FR/NFR defined · ${frCited.length} cited by tickets · ${sDefined.length} S-items · ${dDefined.length} D-decisions · ${docRefs.length} doc refs · ${storyIds.length} stories (${storyCovered.size} ticket-covered)`);
if (warnings.length) {
  console.log(`\nCoverage gaps (${warnings.length}) — GAP-step input, not failures:`);
  for (const w of warnings) console.log(`  - ${w}`);
}
if (failures.length) {
  console.error(`\nFAIL: ${failures.length} dangling reference(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nOK: traceability chain has no dangling references.');
