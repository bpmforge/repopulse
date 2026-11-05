import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRulepack, SEMGREP_RULEPACK_DIR } from '../scanners/semgrep/scanner.js';
import { shippedStatusOf } from './shadow.js';
import { isThirdPartyRule, readThirdPartyPack, THIRD_PARTY_RULEPACK_DIR } from './third-party.js';

// W22-07: the ledger is the only door into the third-party pack, so these tests
// hold it to its word. A file must be listed, unmodified since import, under a
// licence on the allowlist, and beside its source's LICENSE.

interface LedgerFile {
  path: string;
  licence: string;
  ruleIds: string[];
  sha256: string;
}
interface Ledger {
  allowed: string[];
  sources: { key: string; engine?: string; commit: string; files: LedgerFile[] }[];
}

const ledger = JSON.parse(
  readFileSync(path.join(THIRD_PARTY_RULEPACK_DIR, 'LEDGER.json'), 'utf8'),
) as Ledger;
const files = ledger.sources.flatMap((s) => s.files);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(path.relative(THIRD_PARTY_RULEPACK_DIR, full).split(path.sep).join('/'));
  }
  return out;
}

describe('third-party rule ledger (W22-07)', () => {
  it('admits only MIT and Apache-2.0 files', () => {
    expect(ledger.allowed.sort()).toEqual(['Apache-2.0', 'MIT']);
    for (const f of files) expect(ledger.allowed).toContain(f.licence);
  });

  it('every listed file is on disk and unmodified since import', () => {
    for (const f of files) {
      const text = readFileSync(path.join(THIRD_PARTY_RULEPACK_DIR, f.path), 'utf8');
      expect(createHash('sha256').update(text).digest('hex'), f.path).toBe(f.sha256);
    }
  });

  it('no rule file sits beside the ledger without being listed', () => {
    const listed = new Set(files.map((f) => f.path));
    const onDisk = walk(THIRD_PARTY_RULEPACK_DIR).filter((p) => /\.(ya?ml|toml)$/.test(p));
    expect(onDisk.filter((p) => !listed.has(p))).toEqual([]);
  });

  it('carries each source licence text', () => {
    for (const s of ledger.sources) {
      expect(existsSync(path.join(THIRD_PARTY_RULEPACK_DIR, s.key, 'LICENSE')), s.key).toBe(true);
      expect(s.commit).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('refuses copyleft and non-commercial headers even if one slipped into the list', () => {
    for (const f of files) {
      const head = readFileSync(path.join(THIRD_PARTY_RULEPACK_DIR, f.path), 'utf8').slice(0, 400);
      expect(head, f.path).not.toMatch(/License:\s*(L?GPL|AGPL|Commons Clause|GitLab Enterprise)/i);
    }
  });

  it('no third-party rule id collides with one of ours', () => {
    const ours = new Set(readRulepack(SEMGREP_RULEPACK_DIR).ruleIds);
    const theirs = files.flatMap((f) => f.ruleIds);
    expect(new Set(theirs).size).toBe(theirs.length);
    expect(theirs.filter((id) => ours.has(id))).toEqual([]);
  });

  it('reads the pack from the ledger, with a version naming the ledger', () => {
    const pack = readThirdPartyPack();
    // Opengrep gets the rule files; gitleaks' TOML goes to the secrets scanner.
    const secrets = ledger.sources.filter((s) => s.engine === 'gitleaks').flatMap((s) => s.files);
    expect(pack?.files.length).toBe(files.length - secrets.length);
    expect(pack?.secretsFiles).toEqual(secrets.map((f) => f.path));
    expect(pack?.version).toMatch(/^ledger:[0-9a-f]{12}$/);
  });

  it('every imported rule ships shadow whatever its file says', () => {
    const id = files[0]!.ruleIds[0]!;
    expect(isThirdPartyRule(id)).toBe(true);
    expect(shippedStatusOf({}, id)).toBe('candidate');
    expect(shippedStatusOf({ lifecycle: 'active' }, id)).toBe('candidate');
    expect(isThirdPartyRule('bpm-c-gets')).toBe(false);
  });
});
