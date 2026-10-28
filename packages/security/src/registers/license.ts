import type { ResolvedComponent } from './sbom.js';
import { resolveLicense, type LicenseCategory } from './spdx.js';

// License posture register (W10-02, FR-REG-4).
//
// FINDINGS ONLY. RepoPulse has no CI check, no PR gate and no merge block, so
// a license result cannot stop anything — and writing it as if it could would
// promise a control that does not exist. What it does is tell a team which
// obligations they have taken on, in the scope where those obligations bite.

export interface LicensePolicy {
  /** SPDX ids that never produce a finding. */
  allow: string[];
  /** SPDX ids that produce a finding in prod scope. */
  flag: string[];
  /** Flag components whose license the SBOM does not state. */
  flagUnknown: boolean;
  /**
   * License categories that produce a finding in prod scope (W18-39). An
   * expression is resolved first (`MIT OR GPL-3.0` is MIT), then categorised.
   */
  flagCategories: LicenseCategory[];
}

// AGPL and SSPL by default because both carry network-use obligations that a
// team usually wants to have decided on deliberately. This is a POSTURE
// default, not a legal opinion, and the whole list is workspace-tunable.
export const DEFAULT_LICENSE_POLICY: LicensePolicy = {
  allow: [],
  flag: ['AGPL-1.0', 'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'SSPL-1.0'],
  flagUnknown: true,
  // Network copyleft (AGPL, SSPL, OSL) and strong copyleft (GPL) bind a product
  // that ships or serves the code; weak copyleft (LGPL, MPL, EPL) is the usual
  // "fine if you link it" case and is left to the team to opt into.
  flagCategories: ['network-copyleft', 'strong-copyleft'],
};

export interface LicenseFinding {
  package: string;
  ecosystem: string;
  license: string | null;
  scope: 'prod-direct' | 'prod-transitive';
  category: LicenseCategory;
  severity: number;
  title: string;
  evidence: string;
  recommendation: string;
  ruleId: string;
}

/** Splits an expression so `MIT OR AGPL-3.0` is checked id by id. */
export function licenseIds(expression: string | null): string[] {
  if (!expression) return [];
  return expression
    .split(/\s+(?:OR|AND|WITH)\s+|[()]/i)
    .map((id) => id.trim().replace(/\+$/, ''))
    .filter((id) => id !== '');
}

const matches = (list: readonly string[], id: string): boolean =>
  list.some((entry) => entry.toLowerCase() === id.toLowerCase());

/**
 * License findings for prod-scope components.
 *
 * DEV SCOPE IS SILENT, deliberately: a copyleft build tool is not distributed
 * with the product and flagging it trains people to ignore the whole category.
 */
/**
 * Ecosystems where the SBOM states a license for NO production component.
 *
 * There the absence says nothing about any one package: the SBOM was built
 * from a lockfile that carries no license data (yarn.lock, poetry.lock,
 * Cargo.lock …) and the snapshot has no installed packages to read it from.
 * Flagging each package as "undeclared" there accused every dependency of
 * something nobody had checked — 1,287 findings on outline, including
 * Apache-2.0 @aws-sdk packages (2026-10-27 walkthrough).
 */
export function ecosystemsWithoutLicenseData(
  components: readonly ResolvedComponent[],
): Set<string> {
  const seen = new Set<string>();
  const stated = new Set<string>();
  for (const c of components) {
    if (c.scope === 'dev') continue;
    seen.add(c.ecosystem);
    if (licenseIds(c.license).length > 0) stated.add(c.ecosystem);
  }
  return new Set([...seen].filter((e) => !stated.has(e)));
}

/** Prod-scope components whose license could not be checked at all. */
export function uncheckedLicenseCount(components: readonly ResolvedComponent[]): number {
  const blind = ecosystemsWithoutLicenseData(components);
  return components.filter((c) => c.scope !== 'dev' && blind.has(c.ecosystem)).length;
}

export function licenseFindings(
  components: readonly ResolvedComponent[],
  policy: LicensePolicy = DEFAULT_LICENSE_POLICY,
): LicenseFinding[] {
  const findings: LicenseFinding[] = [];
  const blind = ecosystemsWithoutLicenseData(components);

  for (const component of components) {
    if (component.scope === 'dev') continue;
    const ids = licenseIds(component.license);
    const where = `${component.ecosystem}:${component.name}@${component.version ?? 'unknown'}`;

    if (ids.length === 0) {
      if (!policy.flagUnknown) continue;
      // Not checked is not undeclared: counted by uncheckedLicenseCount instead.
      if (blind.has(component.ecosystem)) continue;
      findings.push({
        package: component.name,
        ecosystem: component.ecosystem,
        license: null,
        scope: component.scope,
        category: 'unknown',
        severity: 2,
        title: `Undeclared license: ${component.name}`,
        evidence: `${where} ships in production scope and the SBOM states no license.`,
        recommendation:
          'Check the upstream repository — an unstated license is "all rights reserved" by default, not permissive.',
        ruleId: 'license.unknown',
      });
      continue;
    }

    const resolved = resolveLicense(component.license);
    // An allowed id that settles the choice ends it: `MIT OR AGPL-3.0` with MIT
    // allowed is MIT, and flagging it would be a false positive.
    if (resolved.ids.length > 0 && resolved.ids.every((id) => matches(policy.allow, id))) continue;

    if (resolved.category === 'unknown') {
      // An expression we cannot read is not permissive; it is reported as
      // unreadable, with the text as written, under the unknown-license rule.
      if (!policy.flagUnknown) continue;
      findings.push({
        package: component.name,
        ecosystem: component.ecosystem,
        license: component.license,
        scope: component.scope,
        category: 'unknown',
        severity: 2,
        title: `Unrecognised license: ${component.name}`,
        evidence: `${where} is ${component.scope} and its license "${component.license}" is not a recognised SPDX id or expression.`,
        recommendation:
          'Read the upstream license text. An unrecognised license may be proprietary or custom; treat it as not permissive until you have.',
        ruleId: 'license.unknown',
      });
      continue;
    }

    const flaggedIds = resolved.ids.filter((id) => matches(policy.flag, id));
    const flaggedByCategory = policy.flagCategories.includes(resolved.category);
    if (flaggedIds.length === 0 && !flaggedByCategory) continue;

    findings.push({
      package: component.name,
      ecosystem: component.ecosystem,
      license: component.license,
      scope: component.scope,
      category: resolved.category,
      severity: component.scope === 'prod-direct' ? 3 : 2,
      title: `${(flaggedIds.length > 0 ? flaggedIds : resolved.ids).join(', ')} (${resolved.category}) in production scope: ${component.name}`,
      evidence: `${where} is ${component.scope} and licensed ${component.license}; resolved as ${resolved.category}.`,
      recommendation:
        'Confirm the obligation is acceptable for how this is shipped, or replace the dependency. RepoPulse reports this; it does not block anything.',
      ruleId: 'license.policy',
    });
  }

  return findings;
}
