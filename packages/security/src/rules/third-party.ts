import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Permissively licensed third-party rule files (W22-07), copied verbatim by
 * scripts/import-third-party-rules.mjs and listed in LEDGER.json with the
 * upstream commit and the licence each was admitted under. Every rule in it
 * ships shadow (rules/shadow.ts) until it earns its place like ours do.
 */
export const THIRD_PARTY_RULEPACK_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../rulepacks/third-party',
);

/** Mount point of the third-party pack, apart from ours so neither shadows the other. */
export const THIRD_PARTY_MOUNT_PATH = '/rules-tp';

export interface ThirdPartyPack {
  dir: string;
  /** Ledger paths, relative to `dir`. */
  files: string[];
  ruleIds: string[];
  /** The ledger's own hash: which upstream commits produced a finding. */
  version: string;
}

interface LedgerShape {
  sources?: { files?: { path?: unknown; ruleIds?: unknown }[] }[];
}

/**
 * Reads the ledger, never the directory: a file someone dropped beside the
 * ledger was not admitted by anyone and must not run. Null when there is no
 * ledger at all (an older bundle).
 */
export function readThirdPartyPack(dir: string = THIRD_PARTY_RULEPACK_DIR): ThirdPartyPack | null {
  const ledgerPath = path.join(dir, 'LEDGER.json');
  if (!existsSync(ledgerPath)) return null;
  const raw = readFileSync(ledgerPath, 'utf8');
  const ledger = JSON.parse(raw) as LedgerShape;
  const files: string[] = [];
  const ruleIds: string[] = [];
  for (const source of ledger.sources ?? []) {
    for (const file of source.files ?? []) {
      if (typeof file.path !== 'string') continue;
      files.push(file.path);
      if (Array.isArray(file.ruleIds)) {
        for (const id of file.ruleIds) if (typeof id === 'string') ruleIds.push(id);
      }
    }
  }
  const version = `ledger:${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
  return { dir, files: files.sort(), ruleIds, version };
}

let shippedIds: Set<string> | undefined;

/**
 * True for a rule that came in through the ledger. Such a rule ships shadow:
 * an upstream author's confidence is not a measurement on our customers'
 * code, so it earns `active` the way ours do (D11, the hand-checked bar).
 */
export function isThirdPartyRule(ruleId: string): boolean {
  shippedIds ??= new Set(readThirdPartyPack()?.ruleIds ?? []);
  return shippedIds.has(ruleId);
}

/**
 * Test, fixture, example and rule-test paths. Our own rule files exclude
 * these in each rule's `paths:`; a third-party file mostly does not, and we
 * cannot edit it. Graded on the walkthrough repos (docs/benchmarks/
 * rule-grade-w22-07): 41 third-party hits sat in test paths and 23 more in
 * saleor's `.semgrep/` rule fixtures, and `.claude/` holds a repo's agent
 * tooling scripts. None of them is a finding about the product.
 */
const THIRD_PARTY_SKIP_PATH =
  /(^|\/)(tests?|__tests__|__mocks__|specs?|e2e|fixtures?|__fixtures__|testdata|examples?|samples?|mocks?|\.semgrep|\.claude)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|(^|\/)test_[^/]*\.py$|Tests?\.(swift|kt|java)$/i;

/** True for a path a third-party rule's finding is dropped on. */
export function isThirdPartySkipPath(file: string): boolean {
  return THIRD_PARTY_SKIP_PATH.test(file);
}
