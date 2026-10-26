// The tested ecosystem matrix (W18-47): for each lockfile ecosystem, what syft
// actually read out of a fixture and whether grype matched anything in it.
//
// The matrix is MEASURED, not declared. A support table written from the tools'
// documentation says what they are supposed to do; this one runs them over a
// fixture per ecosystem and records what came out, so a row can say "the lockfile
// was read but nothing matched" (a different problem from "the lockfile was not
// read"), and an ecosystem neither tool reads is listed as unsupported rather
// than left out.

export interface EcosystemSpec {
  /** Directory under fixtures/ecosystems. */
  id: string;
  label: string;
  /** The manifest and lockfile names the fixture holds, shown in the table. */
  files: string[];
  /** The purl type syft reports the packages as, e.g. `npm`, `golang`. */
  purlType: string;
  /** A package the fixture pins, matched against purl names (case-insensitive substring). */
  packageName: string;
  /** What the fixture pins, in words: the known-vulnerable version grype should match. */
  pinned: string;
  /**
   * A MEASURED reason, for a row that is not a clean match: what was run, what
   * it showed, and why the row is not (or no longer) in the state a reader would
   * assume. Required by a test for every row the committed matrix does not mark
   * `matched`, so a non-match cannot land without its cause.
   */
  why?: string;
}

export const ECOSYSTEMS: readonly EcosystemSpec[] = [
  {
    id: 'npm',
    label: 'npm',
    files: ['package-lock.json'],
    purlType: 'npm',
    packageName: 'lodash',
    pinned: 'lodash 4.17.15',
  },
  {
    id: 'pnpm',
    label: 'pnpm',
    files: ['pnpm-lock.yaml'],
    purlType: 'npm',
    packageName: 'lodash',
    pinned: 'lodash 4.17.15',
  },
  {
    id: 'yarn',
    label: 'Yarn (v1)',
    files: ['yarn.lock'],
    purlType: 'npm',
    packageName: 'lodash',
    pinned: 'lodash 4.17.15',
  },
  {
    id: 'pip',
    label: 'pip',
    files: ['requirements.txt'],
    purlType: 'pypi',
    packageName: 'django',
    pinned: 'django 2.2.0',
  },
  {
    id: 'poetry',
    label: 'Poetry',
    files: ['poetry.lock'],
    purlType: 'pypi',
    packageName: 'django',
    pinned: 'django 2.2.0',
  },
  {
    id: 'uv',
    label: 'uv',
    files: ['uv.lock'],
    purlType: 'pypi',
    packageName: 'django',
    pinned: 'django 2.2.0',
  },
  {
    id: 'go',
    label: 'Go modules',
    files: ['go.mod', 'go.sum'],
    purlType: 'golang',
    packageName: 'golang.org/x/text',
    pinned: 'golang.org/x/text v0.3.0',
  },
  {
    id: 'cargo',
    label: 'Cargo',
    files: ['Cargo.lock'],
    purlType: 'cargo',
    packageName: 'time',
    pinned: 'time 0.1.43',
  },
  {
    id: 'maven',
    label: 'Maven',
    files: ['pom.xml'],
    purlType: 'maven',
    packageName: 'log4j-core',
    pinned: 'log4j-core 2.14.1',
  },
  {
    id: 'gradle',
    label: 'Gradle',
    files: ['gradle.lockfile'],
    purlType: 'maven',
    packageName: 'jackson-databind',
    pinned: 'jackson-databind 2.9.8',
  },
  {
    id: 'nuget',
    label: 'NuGet',
    files: ['packages.lock.json'],
    purlType: 'nuget',
    packageName: 'newtonsoft.json',
    pinned: 'Newtonsoft.Json 9.0.1',
  },
  {
    id: 'composer',
    label: 'Composer',
    files: ['composer.lock'],
    purlType: 'composer',
    packageName: 'guzzle',
    pinned: 'guzzlehttp/guzzle 6.5.4',
  },
  {
    id: 'bundler',
    label: 'Bundler',
    files: ['Gemfile.lock'],
    purlType: 'gem',
    packageName: 'rack',
    pinned: 'rack 2.0.8',
  },
  {
    id: 'swiftpm',
    label: 'Swift Package Manager',
    files: ['Package.resolved'],
    purlType: 'swift',
    packageName: 'swift-nio',
    pinned: 'swift-nio 2.40.0',
    why:
      'Matched since W18-51. Before it, grype matched nothing although the database holds three active swift-nio advisories whose ranges include 2.40.0: ' +
      'syft catalogues the package as `swift-nio` and keeps the repository path only in the purl (`pkg:swift/github.com/apple/swift-nio@2.40.0`), while grype looks a package up by the name it is given and the database indexes it as `github.com/apple/swift-nio`. ' +
      "Measured on the real tools: the same package matched nothing as catalogued and three advisories once its name was the purl path. The scanner now gives grype a copy of the SBOM in which a namespaced Swift package is named by its purl path (`deploy/scan-tools/sbom-normalise.mjs`); the SBOM it returns is syft's own.",
  },
  {
    id: 'cocoapods',
    label: 'CocoaPods',
    files: ['Podfile.lock'],
    purlType: 'cocoapods',
    packageName: 'afnetworking',
    pinned: 'AFNetworking 2.5.0',
    why:
      'The database DOES hold an advisory for this exact version (CVE-2015-3996, AFNetworking <= 2.5.2), so this is not missing data. It is an NVD record keyed by the CPE vendor `afnetworking_project`; syft generates the vendor `AFNetworking`; grype joins on vendor and product, so nothing matches. ' +
      "A CPE with the real vendor, or with a wildcard vendor, does match it (measured). The wildcard is not safe: it matches on the product name alone. On the 103,421-pod CocoaPods index, 1,152 NVD products share a pod's name and 771 of those exist only under unrelated vendors (the `nimble` pod would collect Apache NimBLE's 15 advisories, `toast` Roxio Toast's, `sentry` 33 from other vendors, `stripe` and `paypal` WordPress and e-commerce plugin advisories). " +
      "The NVD's `<name>_project` vendor pattern covers 217 of them but includes plain words (`async`, `cache`, `console`, `date`, `diff`) that are other ecosystems' projects. So no join is applied and the row stays unmatched. " +
      "A sound join exists: accept an NVD candidate only if one of its CVEs references the pod's own source repository, taken from its podspec (which a Podfile.lock does not carry). Measured in W18-54 on a seeded 200-pod sample: it verified 5 pods (2.5%, about 29 of the 1,152 candidates, every one correct, including vendors no name rule could guess), while a wildcard vendor was 98% wrong and a name or name_project vendor rule 94% wrong. It needs the CocoaPods Specs as a new data source and a maintained table for roughly 29 pods, so it is not built: the owner chose to leave CocoaPods unmatched for now (W18-54, option A, 2026-10-25), and to revisit with a reviewed alias table if iOS customers appear.",
  },
  {
    id: 'conan',
    label: 'Conan',
    files: ['conan.lock', 'conanfile.txt'],
    purlType: 'conan',
    packageName: 'openssl',
    pinned: 'openssl 1.1.1k',
  },
  {
    id: 'vcpkg',
    label: 'vcpkg',
    files: ['vcpkg.json'],
    purlType: 'vcpkg',
    packageName: 'openssl',
    pinned: 'openssl 1.1.1k (an exact override)',
    why:
      "syft has a vcpkg-manifest-cataloger, but it reads the manifest's OWN name and version only (measured: one package, the project itself), never its dependencies, with or without an exact `overrides` pin. " +
      "A vcpkg manifest's dependencies carry no resolved version unless overridden (vcpkg resolves them from its registry baseline at install time), so there is nothing to match offline apart from `overrides`. A reader for those would also have to guess each C/C++ library's NVD vendor, the same join problem as CocoaPods. Investigated in W18-52 and not built.",
  },
];

/**
 * - `matched`: syft read the lockfile and grype reported a vulnerability for the pinned package.
 * - `catalogued`: syft read the pinned package but grype matched nothing (no advisory in the database, or the purl form did not match).
 * - `unsupported`: syft reported no package for the pinned name: the ecosystem is not read.
 * - `untested`: the matrix has not been run for this row.
 */
export type EcosystemStatus = 'matched' | 'catalogued' | 'unsupported' | 'untested';

export interface EcosystemResult {
  id: string;
  status: EcosystemStatus;
  /** Packages syft reported for the fixture, of any type. */
  packages: number;
  /** Packages of the expected purl type naming the pinned package. */
  pinnedFound: number;
  /** Matches grype reported for the pinned package. */
  vulnerabilities: number;
  /** Purl types syft did report, so a row can say "read as maven, expected cargo". */
  purlTypes: string[];
}

export interface MatrixMeta {
  syft: string;
  grype: string;
  date: string | null;
  image: string | null;
}

export interface MatrixFile {
  schema: 1;
  meta: MatrixMeta | null;
  results: EcosystemResult[];
}

interface Component {
  purl?: unknown;
  name?: unknown;
}

function purlOf(c: Component): string {
  return typeof c.purl === 'string' ? c.purl : '';
}

const purlType = (purl: string): string => /^pkg:([^/]+)\//.exec(purl)?.[1] ?? '';

/** Pure: a CycloneDX document and grype's matches in, one row out. */
export function classify(
  spec: EcosystemSpec,
  document: Record<string, unknown> | null,
  matchPurls: readonly (string | null)[],
): EcosystemResult {
  const components = ((document?.components as Component[] | undefined) ?? []).filter(
    (c) => purlOf(c) !== '',
  );
  const name = spec.packageName.toLowerCase();
  const pinned = components.filter(
    (c) =>
      purlType(purlOf(c)) === spec.purlType &&
      decodeURIComponent(purlOf(c)).toLowerCase().includes(name),
  );
  const vulnerabilities = matchPurls.filter(
    (p) => p !== null && decodeURIComponent(p).toLowerCase().includes(name),
  ).length;
  const status: EcosystemStatus =
    pinned.length === 0 ? 'unsupported' : vulnerabilities > 0 ? 'matched' : 'catalogued';
  return {
    id: spec.id,
    status,
    packages: components.length,
    pinnedFound: pinned.length,
    vulnerabilities,
    purlTypes: [...new Set(components.map((c) => purlType(purlOf(c))))].sort(),
  };
}

const LABEL: Record<EcosystemStatus, string> = {
  matched: 'Supported: read and matched',
  catalogued: 'Read, not matched',
  unsupported: 'Unsupported: not read',
  untested: 'Not yet run',
};

/** The ECOSYSTEMS.md body, from the stored results. Pure, so a test can hold the committed copy to it. */
export function renderEcosystems(file: MatrixFile): string {
  const byId = new Map(file.results.map((r) => [r.id, r]));
  const out: string[] = [];
  out.push('# Dependency ecosystems', '');
  out.push(
    'Which lockfile ecosystems the dependency scanner reads and matches, **measured**: each row is a',
    'fixture under `packages/security/fixtures/ecosystems/<id>` run through the same syft and grype',
    'the scanner uses. Generated by `pnpm --filter @repopulse/security ecosystems`; do not edit by hand.',
    '',
  );
  if (file.meta) {
    out.push(
      `Run ${file.meta.date ?? '(date not recorded)'} with syft ${file.meta.syft} and grype ${file.meta.grype}` +
        (file.meta.image ? ` in \`${file.meta.image}\`.` : '.'),
      '',
    );
  } else {
    out.push('**The matrix has not been run yet**, so no row below is a measurement.', '');
  }
  out.push(
    '| Ecosystem | Fixture files | Pinned | Result | Packages read | Vulnerabilities matched |',
    '|---|---|---|---|--:|--:|',
  );
  for (const spec of ECOSYSTEMS) {
    const r = byId.get(spec.id);
    const status = r?.status ?? 'untested';
    out.push(
      `| ${spec.label} | ${spec.files.map((f) => `\`${f}\``).join(', ')} | ${spec.pinned} | ${LABEL[status]} | ${r ? r.pinnedFound : '—'} | ${r ? r.vulnerabilities : '—'} |`,
    );
  }
  out.push('');
  const noted = ECOSYSTEMS.filter((spec) => spec.why !== undefined);
  if (noted.length > 0) {
    out.push('Notes on individual rows:', '');
    for (const spec of noted) {
      const status = byId.get(spec.id)?.status ?? 'untested';
      out.push(`- **${spec.label}** (${LABEL[status]}): ${spec.why}`);
    }
    out.push('');
  }
  out.push('How to read a row:', '');
  out.push(
    '- **Supported** means syft read the pinned package from the lockfile *and* grype reported a vulnerability for it. Both halves matter: a lockfile that is read but never matched finds nothing.',
    '- **Read, not matched** means syft read it and grype matched nothing. That is never proof the package is safe: the cause is stated under the table for each such row (the database holds no advisory for that version, or it does and no key joins it to the package). A row here is not safe to rely on until a known-vulnerable package matches.',
    '- **Unsupported** means syft reported no such package from the fixture. Dependencies in that ecosystem are invisible to the scanner, and the coverage map should say so.',
    '- A repository can still hold a lockfile the fixture does not exercise (a newer lockfile version, a monorepo layout). The fixture proves the format is read, not every variant of it.',
    '',
  );
  return `${out.join('\n')}\n`;
}
