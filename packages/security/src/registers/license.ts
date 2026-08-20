import type { ResolvedComponent } from './sbom.js';

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
}

// AGPL and SSPL by default because both carry network-use obligations that a
// team usually wants to have decided on deliberately. This is a POSTURE
// default, not a legal opinion, and the whole list is workspace-tunable.
export const DEFAULT_LICENSE_POLICY: LicensePolicy = {
  allow: [],
  flag: ['AGPL-1.0', 'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'SSPL-1.0'],
  flagUnknown: true,
};

export interface LicenseFinding {
  package: string;
  ecosystem: string;
  license: string | null;
  scope: 'prod-direct' | 'prod-transitive';
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
export function licenseFindings(
  components: readonly ResolvedComponent[],
  policy: LicensePolicy = DEFAULT_LICENSE_POLICY,
): LicenseFinding[] {
  const findings: LicenseFinding[] = [];

  for (const component of components) {
    if (component.scope === 'dev') continue;
    const ids = licenseIds(component.license);
    const where = `${component.ecosystem}:${component.name}@${component.version ?? 'unknown'}`;

    if (ids.length === 0) {
      if (!policy.flagUnknown) continue;
      findings.push({
        package: component.name,
        ecosystem: component.ecosystem,
        license: null,
        scope: component.scope,
        severity: 2,
        title: `Undeclared license: ${component.name}`,
        evidence: `${where} ships in production scope and the SBOM states no license.`,
        recommendation:
          'Check the upstream repository — an unstated license is "all rights reserved" by default, not permissive.',
        ruleId: 'license.unknown',
      });
      continue;
    }

    // An allowed id anywhere in the expression settles it: `MIT OR AGPL-3.0`
    // means the user may choose MIT, and flagging that is a false positive.
    if (ids.some((id) => matches(policy.allow, id))) continue;

    const flagged = ids.filter((id) => matches(policy.flag, id));
    if (flagged.length === 0) continue;

    findings.push({
      package: component.name,
      ecosystem: component.ecosystem,
      license: component.license,
      scope: component.scope,
      severity: component.scope === 'prod-direct' ? 3 : 2,
      title: `${flagged.join(', ')} in production scope: ${component.name}`,
      evidence: `${where} is ${component.scope} and licensed ${component.license}.`,
      recommendation:
        'Confirm the obligation is acceptable for how this is shipped, or replace the dependency. RepoPulse reports this; it does not block anything.',
      ruleId: 'license.policy',
    });
  }

  return findings;
}
