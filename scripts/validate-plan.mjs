#!/usr/bin/env node
// validate-plan.mjs — RepoPulse ticket-board validator (no dependencies).
// Validates plan.json schema, dependency graph and wave gating; prints
// per-wave/status counts and the current claimable set. Exit 1 on violation.
//
// Gate rule (PLAYBOOK.md): a wave-N ticket (N>0) is claimable only when every
// non-infra ticket in earlier waves is done. Exception: W0 is always claimable.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLAN_PATH = path.join(ROOT, 'plan.json');

const MODULES = ['infra', 'forge', 'ingest', 'metrics', 'analysis', 'insights', 'reports', 'auth', 'api', 'web', 'deploy', 'security'];
const STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
const POINTS = [1, 2, 3, 5, 8];
const TICKET_KEYS = ['id', 'title', 'phase', 'module', 'write_scope', 'depends_on', 'acceptance', 'points', 'status', 'notes'];
// Documented gate exceptions for forward-wave depends_on entries: none yet.
const FORWARD_DEP_EXCEPTIONS = new Set();

const errors = [];
const err = (msg) => errors.push(msg);

let plan;
try {
  plan = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
} catch (e) {
  console.error(`FATAL: cannot read/parse ${PLAN_PATH}: ${e.message}`);
  process.exit(1);
}

if (plan.version !== 1) err(`plan.version must be 1 (got ${plan.version})`);
if (!Array.isArray(plan.tickets) || plan.tickets.length === 0) {
  console.error('FATAL: plan.tickets must be a non-empty array');
  process.exit(1);
}

const byId = new Map();

for (const t of plan.tickets) {
  const label = t && typeof t.id === 'string' ? t.id : JSON.stringify(t).slice(0, 60);

  for (const k of TICKET_KEYS) if (!(k in t)) err(`${label}: missing required field "${k}"`);
  for (const k of Object.keys(t)) if (!TICKET_KEYS.includes(k)) err(`${label}: unknown field "${k}" (schema allows exactly: ${TICKET_KEYS.join(', ')})`);

  const m = typeof t.id === 'string' && t.id.match(/^W([0-8])-(\d{2})$/);
  if (!m) { err(`${label}: id must match W<0-8>-<nn>`); continue; }
  if (byId.has(t.id)) err(`${t.id}: duplicate id`);
  byId.set(t.id, t);

  if (t.phase !== Number(m[1])) err(`${t.id}: phase ${t.phase} does not match id wave prefix W${m[1]}`);
  if (typeof t.title !== 'string' || !t.title.trim()) err(`${t.id}: title must be a non-empty string`);
  if (!MODULES.includes(t.module)) err(`${t.id}: module "${t.module}" not in {${MODULES.join('|')}}`);
  if (!STATUSES.includes(t.status)) err(`${t.id}: status "${t.status}" not in {${STATUSES.join('|')}}`);
  if (!POINTS.includes(t.points)) err(`${t.id}: points ${t.points} not in {${POINTS.join(',')}}`);
  if (!Array.isArray(t.write_scope) || t.write_scope.length === 0 || t.write_scope.some((s) => typeof s !== 'string' || !s.trim())) {
    err(`${t.id}: write_scope must be a non-empty array of non-empty glob strings`);
  }
  if (!Array.isArray(t.acceptance) || t.acceptance.length < 2 || t.acceptance.length > 5 || t.acceptance.some((s) => typeof s !== 'string' || !s.trim())) {
    err(`${t.id}: acceptance must be 2-5 non-empty criterion strings`);
  }
  if (!Array.isArray(t.depends_on) || t.depends_on.some((d) => typeof d !== 'string')) err(`${t.id}: depends_on must be an array of ticket ids`);
  if (!Array.isArray(t.notes) || t.notes.some((n) => typeof n !== 'string')) err(`${t.id}: notes must be an array of strings`);
}

// Dependency graph: existence, self-deps, forward-wave deps, cycles.
for (const t of plan.tickets) {
  if (!byId.has(t.id) || !Array.isArray(t.depends_on)) continue;
  for (const d of t.depends_on) {
    if (d === t.id) { err(`${t.id}: depends on itself`); continue; }
    const dep = byId.get(d);
    if (!dep) { err(`${t.id}: depends_on "${d}" does not exist`); continue; }
    if (dep.phase > t.phase && !FORWARD_DEP_EXCEPTIONS.has(`${t.id}->${d}`)) {
      err(`${t.id} (W${t.phase}): forward-wave dependency on ${d} (W${dep.phase}) with no documented gate exception`);
    }
  }
}

// Cycle detection (iterative DFS, 3-color).
const color = new Map(); // 0 white, 1 gray, 2 black
for (const start of byId.keys()) {
  if (color.get(start)) continue;
  const stack = [[start, 0]];
  while (stack.length) {
    const [id, i] = stack[stack.length - 1];
    if (i === 0) color.set(id, 1);
    const deps = (byId.get(id).depends_on || []).filter((d) => byId.has(d));
    if (i < deps.length) {
      stack[stack.length - 1][1]++;
      const next = deps[i];
      if (color.get(next) === 1) {
        err(`dependency cycle detected: ${next} <- ... <- ${id}`);
      } else if (!color.get(next)) {
        stack.push([next, 0]);
      }
    } else {
      color.set(id, 2);
      stack.pop();
    }
  }
}

// ---- Reporting -------------------------------------------------------------
const isDone = (id) => byId.get(id)?.status === 'done';
const waveGateOpen = (t) =>
  t.phase === 0 ||
  plan.tickets.every((o) => o.phase >= t.phase || o.module === 'infra' || o.status === 'done');
const claimable = plan.tickets
  .filter((t) => t.status === 'todo' && (t.depends_on || []).every(isDone) && waveGateOpen(t))
  .map((t) => t.id)
  .sort();

const waves = [...new Set(plan.tickets.map((t) => t.phase))].sort((a, b) => a - b);
console.log('Tickets per wave/status:');
let totalPoints = 0;
for (const w of waves) {
  const ts = plan.tickets.filter((t) => t.phase === w);
  const pts = ts.reduce((s, t) => s + (t.points || 0), 0);
  totalPoints += pts;
  const byStatus = STATUSES.map((s) => `${s}:${ts.filter((t) => t.status === s).length}`).join(' ');
  console.log(`  W${w}: ${String(ts.length).padStart(2)} tickets, ${String(pts).padStart(3)} pts  (${byStatus})`);
}
console.log(`  total: ${plan.tickets.length} tickets, ${totalPoints} pts`);
console.log(`Claimable now (${claimable.length}): ${claimable.join(', ') || '(none)'}`);

if (errors.length) {
  console.error(`\nFAIL: ${errors.length} violation(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('\nOK: plan.json is valid.');
