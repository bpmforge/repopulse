import type { DeclaredDependency } from '../../validation/declared.js';
import {
  DEP_CATEGORY_TABLE_VERSION,
  categoryOf,
  devScopeKnown,
  type DepCategory,
} from './dep-categories.js';

// Duplicate-purpose dependencies (W18-06, mechanical-checks plan R-20).
//
// Two date libraries, two HTTP clients, two ORMs in ONE project. Each is
// defensible on its own; together they are the signature of code written in
// separate sessions by an author who never looked at what was already there.
//
// ONLY DIRECT RUNTIME DECLARATIONS COUNT. A transitive package is somebody
// else's choice. A dev-only pair is the normal shape of a migration (jest
// beside vitest for the months it takes to move the suites), and flagging it
// would punish the team for migrating carefully. A manifest that cannot say
// which entries were chosen (a `pip freeze` dump) contributes nothing.
//
// ONE PROJECT IS ONE MANIFEST DIRECTORY. A repository with frontend/ and
// backend/ each choosing an HTTP client has two projects with one client each.

export const DUPLICATE_PURPOSE_RULE_ID = 'slop.duplicate_purpose_deps';

export interface DuplicatePurpose {
  ruleId: typeof DUPLICATE_PURPOSE_RULE_ID;
  /** The manifest that declares the later member (as walked). */
  manifest: string;
  unit: string;
  ecosystem: DeclaredEcosystem;
  purpose: DepCategory['purpose'];
  /** Member ids, in table order. */
  members: string[];
  /** The declared package names, in the same order. */
  packages: string[];
  message: string;
}

type DeclaredEcosystem = DeclaredDependency['ecosystem'];

/**
 * Path segments whose manifests are not the project's own: fixtures, examples,
 * docs sites and test harnesses each declare dependencies for a demonstration.
 */
export const NOT_A_PROJECT =
  /(^|\/)(fixtures?|examples?|samples?|demos?|docs?|testdata|tests?|__tests__|e2e|benchmarks?|templates?)(\/|$)/i;

export function duplicatePurposeDeps(
  dependencies: readonly DeclaredDependency[],
): DuplicatePurpose[] {
  // unit+ecosystem+purpose -> member id -> first declaration seen
  const groups = new Map<
    string,
    { category: DepCategory; byMember: Map<string, DeclaredDependency> }
  >();
  for (const dep of dependencies) {
    if (dep.scope !== 'direct' || NOT_A_PROJECT.test(dep.unit)) continue;
    const hit = categoryOf(dep.ecosystem, dep.name);
    if (!hit) continue;
    if (hit.category.purpose === 'test-runner' && !devScopeKnown(dep.ecosystem)) continue;
    const key = `${dep.unit}\0${dep.ecosystem}\0${hit.category.purpose}`;
    const group = groups.get(key) ?? { category: hit.category, byMember: new Map() };
    if (!group.byMember.has(hit.member.id)) group.byMember.set(hit.member.id, dep);
    groups.set(key, group);
  }

  const out: DuplicatePurpose[] = [];
  for (const { category, byMember } of groups.values()) {
    if (byMember.size < 2) continue;
    const ordered = category.members.filter((member) => byMember.has(member.id));
    const declarations = ordered.map((member) => byMember.get(member.id)!);
    const last = declarations[declarations.length - 1]!;
    const packages = declarations.map((d) => d.name);
    out.push({
      ruleId: DUPLICATE_PURPOSE_RULE_ID,
      manifest: last.manifest,
      unit: last.unit,
      ecosystem: last.ecosystem,
      purpose: category.purpose,
      members: ordered.map((member) => member.id),
      packages,
      message:
        `${packages.join(' and ')} are ${packages.length === 2 ? 'both' : 'all'} direct ` +
        `runtime dependencies for the same job ` +
        `(${category.purpose}): ${category.why}. Pick one and migrate the call sites ` +
        `(category table ${DEP_CATEGORY_TABLE_VERSION}).`,
    });
  }
  return out.sort(
    (a, b) => a.manifest.localeCompare(b.manifest) || a.purpose.localeCompare(b.purpose),
  );
}
