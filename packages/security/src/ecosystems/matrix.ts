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
}

export const ECOSYSTEMS: readonly EcosystemSpec[] = [
  { id: 'npm', label: 'npm', files: ['package-lock.json'], purlType: 'npm', packageName: 'lodash', pinned: 'lodash 4.17.15' },
  { id: 'pnpm', label: 'pnpm', files: ['pnpm-lock.yaml'], purlType: 'npm', packageName: 'lodash', pinned: 'lodash 4.17.15' },
  { id: 'yarn', label: 'Yarn (v1)', files: ['yarn.lock'], purlType: 'npm', packageName: 'lodash', pinned: 'lodash 4.17.15' },
  { id: 'pip', label: 'pip', files: ['requirements.txt'], purlType: 'pypi', packageName: 'django', pinned: 'django 2.2.0' },
  { id: 'poetry', label: 'Poetry', files: ['poetry.lock'], purlType: 'pypi', packageName: 'django', pinned: 'django 2.2.0' },
  { id: 'uv', label: 'uv', files: ['uv.lock'], purlType: 'pypi', packageName: 'django', pinned: 'django 2.2.0' },
  { id: 'go', label: 'Go modules', files: ['go.mod', 'go.sum'], purlType: 'golang', packageName: 'golang.org/x/text', pinned: 'golang.org/x/text v0.3.0' },
  { id: 'cargo', label: 'Cargo', files: ['Cargo.lock'], purlType: 'cargo', packageName: 'time', pinned: 'time 0.1.43' },
  { id: 'maven', label: 'Maven', files: ['pom.xml'], purlType: 'maven', packageName: 'log4j-core', pinned: 'log4j-core 2.14.1' },
  { id: 'gradle', label: 'Gradle', files: ['gradle.lockfile'], purlType: 'maven', packageName: 'jackson-databind', pinned: 'jackson-databind 2.9.8' },
  { id: 'nuget', label: 'NuGet', files: ['packages.lock.json'], purlType: 'nuget', packageName: 'newtonsoft.json', pinned: 'Newtonsoft.Json 9.0.1' },
  { id: 'composer', label: 'Composer', files: ['composer.lock'], purlType: 'composer', packageName: 'guzzle', pinned: 'guzzlehttp/guzzle 6.5.4' },
  { id: 'bundler', label: 'Bundler', files: ['Gemfile.lock'], purlType: 'gem', packageName: 'rack', pinned: 'rack 2.0.8' },
  { id: 'swiftpm', label: 'Swift Package Manager', files: ['Package.resolved'], purlType: 'swift', packageName: 'swift-nio', pinned: 'swift-nio 2.40.0' },
  { id: 'cocoapods', label: 'CocoaPods', files: ['Podfile.lock'], purlType: 'cocoapods', packageName: 'afnetworking', pinned: 'AFNetworking 2.5.0' },
  { id: 'conan', label: 'Conan', files: ['conan.lock', 'conanfile.txt'], purlType: 'conan', packageName: 'openssl', pinned: 'openssl 1.1.1k' },
  { id: 'vcpkg', label: 'vcpkg', files: ['vcpkg.json'], purlType: 'generic', packageName: 'openssl', pinned: 'openssl (unpinned manifest)' },
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
  catalogued: 'Read, no match in the database',
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
  out.push('How to read a row:', '');
  out.push(
    '- **Supported** means syft read the pinned package from the lockfile *and* grype reported a vulnerability for it. Both halves matter: a lockfile that is read but never matched finds nothing.',
    '- **Read, no match in the database** means syft read it and grype matched nothing. Either the database holds no advisory for that package version, or grype does not match this ecosystem. A row here is not safe to rely on until a known-vulnerable package matches.',
    '- **Unsupported** means syft reported no such package from the fixture. Dependencies in that ecosystem are invisible to the scanner, and the coverage map should say so.',
    '- A repository can still hold a lockfile the fixture does not exercise (a newer lockfile version, a monorepo layout). The fixture proves the format is read, not every variant of it.',
    '',
  );
  return `${out.join('\n')}\n`;
}
