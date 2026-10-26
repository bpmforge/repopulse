// Package-name identity per ecosystem (W21-05).
//
// Two spellings are the same package when the REGISTRY says they are, and each
// registry says it differently. Getting this wrong in one direction reports a
// real package as missing (`Flask` vs `flask`); in the other it hides a
// typosquat behind a normalisation that folded it into its target. So the rule
// here is each registry's own published one and nothing looser:
//
//   npm       lowercase (new names must be lowercase; legacy mixed-case names
//             are matched case-insensitively here, which can only hide a miss)
//   PyPI      PEP 503: lowercase, runs of `-`, `_`, `.` collapse to one `-`
//   crates.io lowercase, `-` and `_` are the same name (crates.io refuses a
//             crate that differs from an existing one only by them)
//   RubyGems  lowercase (rubygems.org refuses case-only duplicates)
//   Go        the module path as written: proxy paths are case-sensitive
//   Maven     groupId:artifactId as written
//
// deploy/build-package-index.py applies the SAME rules when it writes the
// index, and slopsquat.test.ts pins the two against each other.

export const SLOPSQUAT_ECOSYSTEMS = ['npm', 'pypi', 'go', 'cargo', 'rubygems', 'maven'] as const;
export type SlopEcosystem = (typeof SLOPSQUAT_ECOSYSTEMS)[number];

/** How the finding names the registry it looked in. */
export const REGISTRY_NAME: Record<SlopEcosystem, string> = {
  npm: 'npm',
  pypi: 'PyPI',
  go: 'Go module proxy',
  cargo: 'crates.io',
  rubygems: 'RubyGems',
  maven: 'Maven Central',
};

export function normalizePackageName(ecosystem: SlopEcosystem, name: string): string {
  const trimmed = name.trim();
  switch (ecosystem) {
    case 'npm':
    case 'rubygems':
      return trimmed.toLowerCase();
    case 'pypi':
      return trimmed.toLowerCase().replace(/[-_.]+/g, '-');
    case 'cargo':
      return trimmed.toLowerCase().replace(/_/g, '-');
    case 'go':
    case 'maven':
      return trimmed;
  }
}
