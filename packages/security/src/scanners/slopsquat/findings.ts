import type { IncomingFinding } from '@repopulse/insights';
import { NEAR_MISS_RULE, type SlopSignal } from './detect.js';
import { REGISTRY_NAME } from './names.js';

export const SLOPSQUAT_SCANNER_KEY = 'slopsquat';
export const SLOPSQUAT_VERSION = 'slopsquat.v1';

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * One signal as a stored finding.
 *
 * KEYED BY PACKAGE, NOT BY LINE. The fingerprint is `<ecosystem>:<name>` (plus
 * the rule, scanner and file the store adds), so the weekly snapshot run and
 * the PR-push diff run of the same declaration fold into ONE row, and a
 * dependency that moves down the file when someone adds a line above it keeps
 * its triage. The ten-line bucket the store uses otherwise would mint a new
 * finding for each.
 */
export function slopFinding(signal: SlopSignal, experimental: boolean): IncomingFinding {
  const registry = REGISTRY_NAME[signal.ecosystem];
  const title =
    signal.ruleId === NEAR_MISS_RULE
      ? `Possible typosquat: "${signal.name}" looks like "${signal.nearest?.target ?? '?'}" (${registry})`
      : `Hallucinated package? "${signal.name}" is not in ${registry}`;
  const fix =
    signal.ruleId === NEAR_MISS_RULE
      ? `If you meant "${signal.nearest?.target}", fix the name in ${signal.manifest}; if "${signal.name}" is intended, check who publishes it before installing, then dismiss with a reason.`
      : signal.nearest
        ? `Check the name: "${signal.nearest.target}" is the popular package it resembles. Remove "${signal.name}" from ${signal.manifest} or replace it with the package you meant; do not install it until you know who owns the name.`
        : `Remove "${signal.name}" from ${signal.manifest}, or replace it with the real package that provides what the code needs. Do not register or install the name to make the error go away.`;
  return {
    dimension: 'dependency',
    severity: signal.severity,
    confidence: signal.confidence,
    file: signal.manifest,
    lineStart: signal.line,
    lineEnd: signal.line,
    title: clip(title, 200),
    evidenceQuote: clip(`${signal.manifest}:${signal.line}: ${signal.text}`, 300),
    rationale: signal.reasons.join(' '),
    suggestedFix: fix,
    scannerKey: SLOPSQUAT_SCANNER_KEY,
    ruleId: signal.ruleId,
    fingerprint: `${signal.ecosystem}:${signal.normalized}`,
    experimental,
    yields: {
      slopsquat: signal.ruleId === NEAR_MISS_RULE ? 'near_miss' : 'not_in_registry',
      ecosystem: signal.ecosystem,
      package: signal.name,
      registry: signal.existence,
      ...(signal.notCheckedReason ? { not_checked: signal.notCheckedReason } : {}),
      nearest: signal.nearest?.target ?? null,
      pattern: signal.nearest?.pattern ?? null,
      distance: signal.nearest?.distance ?? null,
      lockfile: signal.lockfile,
      added_in_diff: signal.addedInDiff,
      ...(signal.meta?.created ? { first_published: signal.meta.created } : {}),
      ...(signal.meta?.downloads !== null && signal.meta?.downloads !== undefined
        ? { downloads: signal.meta.downloads }
        : {}),
      section: signal.section,
    },
  };
}
