#!/usr/bin/env node
// Imports permissively licensed third-party Opengrep rule files (W22-07).
//
//   node scripts/import-third-party-rules.mjs            fetch each source at its pinned commit
//   node scripts/import-third-party-rules.mjs --src KEY=DIR ...   use local checkouts instead
//
// Files are copied VERBATIM into packages/security/rulepacks/third-party/<key>/, beside
// the source's own LICENSE, and listed in LEDGER.json with the upstream commit and the
// licence each file was admitted under. Nothing is rewritten: an unmodified file with
// its licence beside it is the cheapest correct way to honour MIT and Apache-2.0, and
// it keeps `git diff` against upstream empty. Lifecycle (every imported rule starts
// shadow) is decided by the ledger in code, not by editing the YAML.
//
// ADMISSION IS DENY-BY-DEFAULT (CODE_HEALTH_SUITE §8.3): a file is copied only when
// its source licence, or for GitLab its own `# License:` header, is on ALLOWED. The
// GitLab tree mixes MIT, Apache-2.0 (gosec-derived), GPL-2.0 (flawfinder-derived C),
// LGPL, Commons Clause and EE-licensed folders; only the first two are taken.
// Research: project files review-2026-10-27/THIRD_PARTY_RULES.md.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'packages/security/rulepacks/third-party');

const ALLOWED = new Set(['MIT', 'Apache-2.0']);

/** GitLab's per-file header → SPDX, or null for anything not admitted. */
function gitlabHeaderLicence(text) {
  const m = /^#\s*License:\s*(?:License:\s*)?(.+)$/m.exec(text);
  if (!m) return null;
  const v = m[1].trim();
  if (/^MIT\b/.test(v)) return 'MIT';
  if (/^Apache 2\.0\b/.test(v)) return 'Apache-2.0';
  return null;
}

export const SOURCES = [
  {
    key: '0xdea',
    upstream: 'https://github.com/0xdea/semgrep-rules',
    commit: 'e0121ac19d9fa259a44f3a24d3e42c95719b17c7',
    licence: 'MIT',
    licenceFile: 'LICENSE',
    // rules/noisy/ is the author's own "high false-positive" folder.
    include: (rel) => /^rules\/(c|cpp|generic)\//.test(rel) && /\.ya?ml$/.test(rel),
    fileLicence: () => 'MIT',
  },
  {
    key: 'elttam',
    upstream: 'https://github.com/elttam/semgrep-rules',
    commit: '244268562cc92d33f54b8a60a187df5520f91b26',
    licence: 'MIT',
    licenceFile: 'LICENSE',
    include: (rel) => /^rules-audit\//.test(rel) && /\.ya?ml$/.test(rel),
    fileLicence: () => 'MIT',
    // Files that fire on the wrong language or framework. Graded on the
    // walkthrough repos (docs/benchmarks/rule-grade-w22-07, 2026-10-28).
    exclude: {
      'rules-audit/java/struts2/security/audit/entrypoints/struts-xml-action-name.yml':
        'matches <action android:name> in every AndroidManifest.xml (4 of 4 nowinandroid hits)',
      'rules-audit/go/orm-leak/beego-orm.yaml':
        'matches fmt.Fprintf in a repository with no Beego ORM (gin recovery.go)',
    },
  },
  {
    key: 'gitlab',
    upstream: 'https://gitlab.com/gitlab-org/security-products/sast-rules',
    commit: '705c08384535914ac5312f4f0f71758241a16e14',
    licence: 'per-file',
    licenceFile: 'LICENSE',
    // Top-level language folders only. c/ is GPL-2.0 (flawfinder); rules/ holds the
    // LGPL, Commons Clause and GitLab EE trees. Both are excluded here AND by the
    // header check, so a relicensed file cannot slip in through either.
    include: (rel) =>
      /^(java|scala|python|csharp|javascript|go)\//.test(rel) && /\.ya?ml$/.test(rel),
    fileLicence: (text) => gitlabHeaderLicence(text),
  },
  {
    // Our own rule packs, opened into Repo Pulse by the owner on 2026-10-28 and
    // relicensed MIT in their own repository (bpm-rulepacks#45). The repository is
    // private until release day (W22-13), so this source is imported with --src only.
    key: 'bpm-rulepacks',
    upstream: 'https://github.com/bpmforge/bpm-rulepacks',
    commit: '84481162a147d68bc7221ef17fd3cce67975e4f8',
    licence: 'MIT',
    licenceFile: 'LICENSE',
    private: true,
    include: (rel) => /^packs\//.test(rel) && /\.ya?ml$/.test(rel),
    fileLicence: () => 'MIT',
  },
];

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/** A YAML file is a rule file only if it declares `rules:`; test configs are not. */
function isRuleFile(text) {
  return /^rules:\s*$/m.test(text);
}

export function ruleIdsOf(text) {
  const ids = [];
  for (const line of text.split('\n')) {
    const m = /^\s*-?\s*id:\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

function fetchSource(src) {
  const dir = mkdtempSync(path.join(tmpdir(), `tp-${src.key}-`));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'fetch', '-q', '--depth', '1', src.upstream, src.commit]);
  execFileSync('git', ['-C', dir, 'checkout', '-q', 'FETCH_HEAD']);
  return dir;
}

function main() {
  const local = new Map();
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--src') {
      const [k, v] = args[++i].split('=');
      local.set(k, path.resolve(v));
    }
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const ledger = { generatedBy: 'scripts/import-third-party-rules.mjs', allowed: [...ALLOWED], sources: [] };
  const seen = new Map();

  for (const src of SOURCES) {
    if (src.private && !local.has(src.key)) throw new Error(`${src.key}: private source, pass --src ${src.key}=DIR`);
    const dir = local.get(src.key) ?? fetchSource(src);
    if (local.has(src.key)) {
      const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
      if (head !== src.commit) throw new Error(`${src.key}: local checkout is ${head}, pinned ${src.commit}`);
    }
    const files = [];
    const refused = [];
    const excluded = [];
    for (const rel of walk(dir).filter(src.include)) {
      if (src.exclude?.[rel]) {
        excluded.push({ path: `${src.key}/${rel}`, reason: src.exclude[rel] });
        continue;
      }
      const text = readFileSync(path.join(dir, rel), 'utf8');
      if (!isRuleFile(text)) continue;
      const licence = src.fileLicence(text);
      if (!licence || !ALLOWED.has(licence)) {
        refused.push(rel);
        continue;
      }
      const ids = ruleIdsOf(text);
      for (const id of ids) {
        if (seen.has(id)) throw new Error(`rule id ${id} in ${src.key}/${rel} also in ${seen.get(id)}`);
        seen.set(id, `${src.key}/${rel}`);
      }
      const dest = path.join(OUT, src.key, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(path.join(dir, rel), dest);
      files.push({
        path: `${src.key}/${rel}`,
        licence,
        ruleIds: ids,
        sha256: createHash('sha256').update(text).digest('hex'),
      });
    }
    copyFileSync(path.join(dir, src.licenceFile), path.join(OUT, src.key, 'LICENSE'));
    ledger.sources.push({
      key: src.key,
      upstream: src.upstream,
      commit: src.commit,
      licence: src.licence,
      files,
      refusedCount: refused.length,
      ...(excluded.length ? { excluded } : {}),
    });
    console.log(
      `${src.key}: ${files.length} files, ${files.reduce((n, f) => n + f.ruleIds.length, 0)} rules, ${refused.length} refused, ${excluded.length} excluded`,
    );
    if (!local.has(src.key)) rmSync(dir, { recursive: true, force: true });
  }

  writeFileSync(path.join(OUT, 'LEDGER.json'), JSON.stringify(ledger, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
