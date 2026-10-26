import path from 'node:path';
import type { Declaration, ManifestRead } from './manifests.js';
import { normalizePackageName, REGISTRY_NAME, type SlopEcosystem } from './names.js';
import type { PopularLists } from './popular.js';
import type { PackageIndex, PackageMeta } from './registry-index.js';
import { nearMiss, type NearMiss } from './similarity.js';

// The slopsquat decision, pure (W21-05, SECURITY_SUITE.md §3.2 step 4).
//
// Two rules, kept apart so an admin can promote one without the other:
//
//   slopsquat            the package is NOT IN THE REGISTRY. This is the
//                        hallucination itself: a name a model invented, which
//                        anyone can register tomorrow (43% of hallucinated
//                        names recur across re-runs — Spracklen et al., USENIX
//                        Security 2025 — so they are worth registering).
//                        Severity 4; confidence 4, or 5 when the name is also
//                        a near miss of a popular package or arrived in the
//                        diff being scanned.
//
//   slopsquat.near-miss  the package EXISTS but is shaped like a typo of a
//                        popular one. Where the index carries registry
//                        metadata (crates.io, Go first-seen), only a YOUNG
//                        (< 90 days) or LOW-DOWNLOAD (< 1,000) package is
//                        flagged — an established near-name is a real library.
//                        Without metadata (npm, PyPI, RubyGems carry none in
//                        their public name lists) it is flagged at severity 3,
//                        confidence 2, and says why it could not be ruled out.
//
// "Appears only in recently added lines" is the diff mode: run on a PR head or
// a push, only declarations on ADDED lines are considered, and each finding
// says so (`added_in_diff`), with one more point of confidence — a dependency
// that arrived in this change has not yet survived anyone's install.
//
// Both start in SHADOW (candidate): stored, visible, out of scores until a
// workspace promotes them on measured precision (CODE_HEALTH_SUITE §8.2).

export const SLOPSQUAT_RULE = 'slopsquat';
export const NEAR_MISS_RULE = 'slopsquat.near-miss';
export type SlopRule = typeof SLOPSQUAT_RULE | typeof NEAR_MISS_RULE;

export const YOUNG_DAYS = 90;
export const LOW_DOWNLOADS = 1000;

export type Existence = 'missing' | 'present' | 'not_checked';
export type LockEvidence = 'resolved' | 'unresolved' | 'no_lockfile';

export interface SlopSignal {
  ruleId: SlopRule;
  ecosystem: SlopEcosystem;
  name: string;
  normalized: string;
  manifest: string;
  line: number;
  text: string;
  section: string;
  existence: Existence;
  /** Why existence was not checked, when it was not. */
  notCheckedReason: string | null;
  nearest: NearMiss | null;
  meta: PackageMeta | null;
  young: boolean;
  lowDownloads: boolean;
  lockfile: LockEvidence;
  addedInDiff: boolean;
  severity: number;
  confidence: number;
  /** Plain sentences, in order — the rationale is built from them. */
  reasons: string[];
}

export interface DetectInput {
  reads: readonly ManifestRead[];
  /** Lockfile evidence: manifest directory -> ecosystem -> normalised names. */
  resolved?: ReadonlyMap<string, ReadonlyMap<SlopEcosystem, ReadonlySet<string>>>;
  index: PackageIndex;
  popular: PopularLists;
  now: Date;
  /** Diff mode: manifest -> its added (new-side) line numbers. */
  addedLines?: ReadonlyMap<string, ReadonlySet<number>>;
  /** npm package names the repository itself defines (workspace members). */
  ownNames?: ReadonlySet<string>;
  /** npm scopes an .npmrc maps to a private registry. */
  privateScopes?: ReadonlySet<string>;
}

export interface DetectResult {
  signals: SlopSignal[];
  /** Declarations looked at (after the diff filter). */
  declarations: number;
  /** Per ecosystem: declarations whose existence could not be checked, and why. */
  notChecked: Partial<Record<SlopEcosystem, { count: number; reason: string }>>;
}

const DAY_MS = 86_400_000;

export function detectSlopsquats(input: DetectInput): DetectResult {
  const signals: SlopSignal[] = [];
  const notChecked: DetectResult['notChecked'] = {};
  let declarations = 0;
  const seen = new Set<string>();

  for (const read of input.reads) {
    const added = input.addedLines?.get(read.manifest);
    if (input.addedLines && !added) continue;
    const unit = path.dirname(read.manifest);
    for (const decl of read.declarations) {
      if (added && !added.has(decl.line)) continue;
      // One verdict per (manifest, package): a name in two tables is one problem.
      const normalized = normalizePackageName(decl.ecosystem, decl.name);
      const key = `${read.manifest}\0${decl.ecosystem}\0${normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      declarations += 1;
      const signal = judge(input, read, decl, normalized, unit, added !== undefined);
      if (signal.notCheckedReason) {
        const entry = (notChecked[decl.ecosystem] ??= {
          count: 0,
          reason: signal.notCheckedReason,
        });
        entry.count += 1;
      }
      if (signal.ruleId) signals.push(signal as SlopSignal);
    }
  }
  return { signals, declarations, notChecked };
}

function judge(
  input: DetectInput,
  read: ManifestRead,
  decl: Declaration,
  normalized: string,
  unit: string,
  addedInDiff: boolean,
): Omit<SlopSignal, 'ruleId'> & { ruleId: SlopRule | null } {
  const eco = decl.ecosystem;
  const registry = REGISTRY_NAME[eco];
  const popular = input.popular[eco];
  const base = {
    ecosystem: eco,
    name: decl.name,
    normalized,
    manifest: read.manifest,
    line: decl.line,
    text: decl.text,
    section: decl.section,
    addedInDiff,
  };
  const none = {
    ...base,
    ruleId: null,
    existence: 'present' as Existence,
    notCheckedReason: null,
    nearest: null,
    meta: null,
    young: false,
    lowDownloads: false,
    lockfile: 'no_lockfile' as LockEvidence,
    severity: 0,
    confidence: 0,
    reasons: [],
  };

  // A popular package, or one this repository defines itself, is real.
  if (popular.rank.has(normalized)) return none;
  if (eco === 'npm' && input.ownNames?.has(normalized)) return none;

  const scope = eco === 'npm' && decl.name.startsWith('@') ? decl.name.split('/')[0]! : null;
  const idx = input.index.ecosystems[eco];
  let existence: Existence;
  let notCheckedReason: string | null = null;
  if (read.privateIndex) {
    existence = 'not_checked';
    notCheckedReason = `${read.manifest} installs from a private index, so absence from ${registry} proves nothing`;
  } else if (scope && input.privateScopes?.has(scope)) {
    existence = 'not_checked';
    notCheckedReason = `${scope} is mapped to a private registry in .npmrc`;
  } else if (!idx) {
    existence = 'not_checked';
    notCheckedReason = input.index.missing[eco] ?? `no ${registry} name list`;
  } else if (idx.has(decl.name)) {
    existence = 'present';
  } else if (scope && !idx.hasPrefix(`${scope}/`)) {
    // No public package at all under this scope: an organisation's private
    // scope, not a hallucination. Dependency confusion is a different finding.
    existence = 'not_checked';
    notCheckedReason = `no public package exists under ${scope}, so it is treated as a private scope`;
  } else {
    existence = 'missing';
  }

  const unitLock = input.resolved?.get(unit)?.get(eco);
  const lockfile: LockEvidence = !unitLock
    ? 'no_lockfile'
    : unitLock.has(normalized)
      ? 'resolved'
      : 'unresolved';
  const nearest = nearMiss(eco, decl.name, popular);
  const meta = existence === 'present' && idx?.metadata ? idx.meta(decl.name) : null;
  const ageDays = meta?.created ? (input.now.getTime() - Date.parse(meta.created)) / DAY_MS : null;
  const young = ageDays !== null && Number.isFinite(ageDays) && ageDays < YOUNG_DAYS;
  const lowDownloads =
    meta?.downloads !== null && meta?.downloads !== undefined && meta.downloads < LOW_DOWNLOADS;

  const reasons: string[] = [];
  const nearText = nearest
    ? `The name is a ${describe(nearest)} of "${nearest.target}", one of the most-used ${registry} packages (rank ${nearest.rank + 1}).`
    : null;
  const diffText = addedInDiff
    ? 'It was added in this change, on a line nobody has installed from yet.'
    : null;
  let ruleId: SlopRule | null = null;
  let severity = 0;
  let confidence = 0;

  if (existence === 'missing') {
    ruleId = SLOPSQUAT_RULE;
    severity = 4;
    confidence = Math.min(5, 4 + (nearest || addedInDiff ? 1 : 0));
    reasons.push(
      `"${decl.name}" is not in the ${registry} name index (${idx!.source}, generated ${idx!.generated}).`,
    );
    if (lockfile === 'resolved') {
      reasons.push(
        'The lockfile beside it records it resolving, so it existed when it was locked and has since been removed — registries remove malware and spam, so treat the installed copy as suspect.',
      );
    } else if (lockfile === 'unresolved') {
      reasons.push(
        'The lockfile beside it has no entry for it: it was declared but never installed.',
      );
    }
    if (nearText) reasons.push(nearText);
    reasons.push(
      'A dependency that does not exist is how a hallucinated package looks: until someone registers the name, the install fails; after, it installs whatever they published.',
    );
  } else if (nearest) {
    if (meta && (young || lowDownloads)) {
      ruleId = NEAR_MISS_RULE;
      severity = 4;
      confidence = Math.min(5, 4 + (addedInDiff ? 1 : 0));
      reasons.push(nearText!);
      const facts = [
        young && meta.created ? `first published ${meta.created.slice(0, 10)}` : null,
        lowDownloads ? `${meta.downloads} downloads in total` : null,
      ].filter(Boolean);
      reasons.push(
        `It exists, but is young or little used (${facts.join(', ')}) — the profile of a typosquat.`,
      );
    } else if (!(meta && meta.downloads !== null && !lowDownloads)) {
      // Not shown to be established. Age alone does not clear a name: the Go
      // boltdb-go/bolt typosquat sat in the module proxy for three years.
      ruleId = NEAR_MISS_RULE;
      severity = 3;
      confidence = Math.min(5, 2 + (addedInDiff ? 1 : 0));
      reasons.push(nearText!);
      reasons.push(
        existence === 'not_checked'
          ? `Whether it exists was not checked (${notCheckedReason}).`
          : meta?.created
            ? `It exists in ${registry} (first seen ${meta.created.slice(0, 10)}), but the index has no download data for it, so an established package with a similar name cannot be ruled out.`
            : `It exists in ${registry}, but the index holds no age or download data for ${registry}, so an established package with a similar name cannot be ruled out.`,
      );
    }
    // Otherwise the metadata says established (not young, downloaded): a real
    // library with a similar name. Not a finding.
  }
  if (ruleId && diffText) reasons.push(diffText);

  return {
    ...base,
    ruleId,
    existence,
    notCheckedReason,
    nearest,
    meta,
    young,
    lowDownloads,
    lockfile,
    severity,
    confidence,
    reasons,
  };
}

function describe(near: NearMiss): string {
  switch (near.pattern) {
    case 'homoglyph':
      return 'look-alike-character spelling';
    case 'separator':
      return 'separator variant';
    case 'affix':
      return 'prefixed/suffixed copy';
    case 'owner':
      return 'look-alike-owner copy';
    case 'edit':
      return `${near.distance}-edit misspelling`;
  }
}
