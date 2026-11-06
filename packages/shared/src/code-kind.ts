// W25-16 / W27-01: one answer to "is this test code?" and "is this code we
// ship?" for every step that reads a repository. The first look (W25-09), the
// judge, a folder review and the code-quality scanners (code health,
// anti-slop) all use it, so they agree on what a test is and on what is not
// pertinent code.
//
// The patterns are plain strings so the judge can apply them in Postgres
// (`~` / `!~`) as well as here: they use only syntax both engines read the
// same way (groups, alternation, `[^/]`, `\.`, `?`, anchors), and are
// case-sensitive in both, so `latest.go`, `contest.py` and `Testimonial.tsx`
// are not tests, and `src/builder/x.ts` is not build output.

/** Test code by directory or file name, across the languages a pass reads. */
export const TEST_PATH_PATTERN =
  '(^|/)(tests?|__tests__|__mocks__|mocks?|specs?|e2e|testutils?|testing|testdata|fixtures?)/' +
  '|(_test\\.(go|py|rs|exs|dart|c|cc|cpp)|\\.(test|spec)\\.[cm]?[jt]sx?|_spec\\.rb|Tests?\\.(java|kt|kts|cs|swift|scala)|Spec\\.(kt|scala|swift))$' +
  '|(^|/)(test_[^/]*\\.py|conftest\\.py|test_?helpers?\\.[a-z]+|testutils?\\.[a-z]+)$';

/**
 * Code nobody in the repository wrote by hand, or that is not shipped from
 * this source: vendored and installed dependencies, build output, generated
 * code, snapshots and lockfiles (W27-01). Same dialect as TEST_PATH_PATTERN.
 */
export const GENERATED_OR_VENDORED_PATH_PATTERN =
  '(^|/)(node_modules|bower_components|vendor|third_party|dist|build|out|target|__snapshots__)/' +
  '|(\\.min\\.(js|css)|\\.pb(\\.gw)?\\.go|_pb2(_grpc)?\\.pyi?|\\.pb\\.(cc|h)|_gen\\.go|_generated\\.[a-z]+|\\.generated\\.[^/]+|\\.d\\.[cm]?ts|\\.snap)$' +
  '|(^|/)(zz_generated[^/]*|package-lock\\.json|npm-shrinkwrap\\.json|yarn\\.lock|pnpm-lock\\.yaml|bun\\.lockb?|' +
  'Cargo\\.lock|go\\.sum|poetry\\.lock|Pipfile\\.lock|uv\\.lock|Gemfile\\.lock|composer\\.lock|' +
  'Podfile\\.lock|mix\\.lock|pubspec\\.lock|packages\\.lock\\.json|gradle\\.lockfile)$';

/** Everything that is not production code: tests, plus generated/vendored/built. */
export const NON_PRODUCTION_PATH_PATTERN = `${TEST_PATH_PATTERN}|${GENERATED_OR_VENDORED_PATH_PATTERN}`;

const TEST_PATH = new RegExp(TEST_PATH_PATTERN);
const GENERATED_OR_VENDORED_PATH = new RegExp(GENERATED_OR_VENDORED_PATH_PATTERN);

function relative(path: string): string {
  return path.replace(/^\.?\/+/, '');
}

/** True for a repository-relative path that is test code (a leading "./" is ignored). */
export function isTestPath(path: string): boolean {
  return TEST_PATH.test(relative(path));
}

/** True for vendored, installed, built or generated code, snapshots and lockfiles. */
export function isGeneratedOrVendoredPath(path: string): boolean {
  return GENERATED_OR_VENDORED_PATH.test(relative(path));
}

/**
 * True for any path that is not pertinent production code (W27-01): tests,
 * fixtures and test data, and generated, vendored or built code. Code-quality
 * scanners neither report on these paths nor spend model time on them. The
 * secrets and dependency scanners do not use it: a key in a fixture is still a
 * key, and a lockfile is where dependencies are declared.
 */
export function isNonProductionPath(path: string): boolean {
  return isTestPath(path) || isGeneratedOrVendoredPath(path);
}

/**
 * The same exclusion, as globs a tool can apply before it reads anything
 * (lizard `-x`, jscpd `--ignore`). A SUBSET of isNonProductionPath, never a
 * superset: only shapes a glob states exactly (a whole directory segment, or a
 * file-name suffix) are here, so a tool never skips a file the regex would keep.
 * Name-prefix shapes (`test_*.py`) are left to the regex, applied to the
 * results, because a glob star crosses `/` in fnmatch and would over-match.
 *
 * `dirs` are directory names (any depth); `suffixes` are file-name endings,
 * each to be read as `*<suffix>`; `names` are exact file names (any depth).
 */
export const NON_PRODUCTION_GLOB_PARTS: {
  readonly dirs: readonly string[];
  readonly suffixes: readonly string[];
  readonly names: readonly string[];
} = {
  dirs: [
    'test',
    'tests',
    '__tests__',
    '__mocks__',
    'mock',
    'mocks',
    'spec',
    'specs',
    'e2e',
    'testutil',
    'testutils',
    'testing',
    'testdata',
    'fixture',
    'fixtures',
    'node_modules',
    'bower_components',
    'vendor',
    'third_party',
    'dist',
    'build',
    'out',
    'target',
    '__snapshots__',
  ],
  suffixes: [
    ...['go', 'py', 'rs', 'exs', 'dart', 'c', 'cc', 'cpp'].map((ext) => `_test.${ext}`),
    ...['test', 'spec'].flatMap((kind) =>
      ['js', 'jsx', 'ts', 'tsx', 'mjs', 'mts', 'cjs', 'cts'].map((ext) => `.${kind}.${ext}`),
    ),
    '_spec.rb',
    ...['Test', 'Tests'].flatMap((kind) =>
      ['java', 'kt', 'kts', 'cs', 'swift', 'scala'].map((ext) => `${kind}.${ext}`),
    ),
    'Spec.kt',
    'Spec.scala',
    'Spec.swift',
    '.min.js',
    '.min.css',
    '.pb.go',
    '_pb2.py',
    '.pb.cc',
    '.pb.h',
    '_gen.go',
    '.d.ts',
  ],
  names: ['conftest.py'],
};

/** fnmatch globs for lizard's `-x` (it matches the whole path, `*` crossing `/`). */
export function nonProductionFnmatchGlobs(): string[] {
  const { dirs, suffixes, names } = NON_PRODUCTION_GLOB_PARTS;
  return [
    ...dirs.map((d) => `*/${d}/*`),
    ...suffixes.map((s) => `*${s}`),
    ...names.map((n) => `*/${n}`),
  ];
}

/** micromatch globs for jscpd's `--ignore` (no braces: jscpd splits the list on commas). */
export function nonProductionGlobstarGlobs(): string[] {
  const { dirs, suffixes, names } = NON_PRODUCTION_GLOB_PARTS;
  return [
    ...dirs.map((d) => `**/${d}/**`),
    ...suffixes.map((s) => `**/*${s}`),
    ...names.map((n) => `**/${n}`),
  ];
}
