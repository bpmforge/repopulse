import type { ResolvedComponent } from './sbom.js';
import { resolveLicense } from './spdx.js';

// Attribution / NOTICE export from the SBOM (W18-39). Pure.
//
// Most licenses ask for the notice to travel with the product; this lists what
// ships, grouped by license, so a team can paste it into a NOTICE file. It is
// an inventory, not a compliance verdict, and it gates nothing (N-3).

export interface AttributionOptions {
  /** Include dev-scope components. Off by default: they are not distributed. */
  includeDev?: boolean;
  /** Heading, e.g. the repository name. */
  title?: string;
}

export function attributionReport(
  components: readonly ResolvedComponent[],
  options: AttributionOptions = {},
): string {
  const byLicense = new Map<string, ResolvedComponent[]>();
  for (const component of components) {
    if (component.scope === 'dev' && !options.includeDev) continue;
    const key = component.license?.trim() || 'License not stated';
    byLicense.set(key, [...(byLicense.get(key) ?? []), component]);
  }
  const lines = [
    `# ${options.title ? `${options.title} — ` : ''}third-party notices`,
    '',
    'Generated from the SBOM by RepoPulse. This is an inventory of what ships and the license each',
    'package states, not a legal opinion; check each upstream license text for its exact terms.',
    '',
  ];
  for (const license of [...byLicense.keys()].sort((a, b) => a.localeCompare(b))) {
    const category = license === 'License not stated' ? 'unknown' : resolveLicense(license).category;
    lines.push(`## ${license} (${category})`, '');
    const members = byLicense.get(license)!.sort((a, b) => a.name.localeCompare(b.name));
    for (const m of members) lines.push(`- ${m.name}${m.version ? ` ${m.version}` : ''} (${m.ecosystem})`);
    lines.push('');
  }
  if (byLicense.size === 0) lines.push('No distributed components were found in the SBOM.', '');
  return lines.join('\n');
}
