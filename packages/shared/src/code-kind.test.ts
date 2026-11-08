import { describe, expect, it } from 'vitest';
import {
  GENERATED_OR_VENDORED_PATH_PATTERN,
  NON_PRODUCTION_PATH_PATTERN,
  TEST_PATH_PATTERN,
  isGeneratedOrVendoredPath,
  isNonProductionPath,
  isTestPath,
  nonProductionFnmatchGlobs,
  nonProductionGlobstarGlobs,
} from './index.js';

const TESTS = [
  'context_test.go',
  'src/a.test.ts',
  'web/a.spec.tsx',
  'tests/test_api.py',
  'conftest.py',
  'src/test/java/FooTest.java',
  'spec/models/user_spec.rb',
  'test_helpers.go',
  'internal/testdata/x.go',
  './gin_test.go',
  'packages/x/__tests__/a.ts',
  'app/src/fixtures/user.json',
  'lib/e2e/login.ts',
];

const GENERATED_OR_VENDORED = [
  'node_modules/lodash/index.js',
  'vendor/github.com/x/y/z.go',
  'third_party/zlib/inflate.c',
  'web/dist/app.js',
  'build/classes/Main.class',
  'out/main.js',
  'target/debug/build.rs',
  'public/jquery.min.js',
  'static/site.min.css',
  'api/v1/service.pb.go',
  'api/v1/service.pb.gw.go',
  'proto/thing_pb2.py',
  'internal/bindata_gen.go',
  'pkg/apis/zz_generated.deepcopy.go',
  'src/graphql.generated.ts',
  'types/index.d.ts',
  'src/__snapshots__/a.test.ts.snap',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'go.sum',
  'Cargo.lock',
  'sub/poetry.lock',
];

// Names that look close to a test or a build dir and are not.
const PRODUCTION = [
  'context.go',
  'latest.go',
  'contest.py',
  'src/Testimonial.tsx',
  'src/builder/x.ts',
  'src/distance.ts',
  'cmd/outline/main.go',
  'targets/arm.go',
  'src/vendors/list.ts',
  'src/testament.rs',
  'saleor/order/models.py',
  'src/generated_report.ts',
  'src/gen.go',
  'README.md',
  'go.mod',
  'package.json',
  'src/Attest.java',
  'docs/testing-guide.md',
];

describe('code-kind (W27-01)', () => {
  it('isTestPath: same answers as the worker-side helper had', () => {
    for (const p of TESTS) expect(isTestPath(p), p).toBe(true);
    for (const p of [...PRODUCTION, 'vendor/x/y.go', 'yarn.lock']) {
      expect(isTestPath(p), p).toBe(false);
    }
  });

  it('semgrep rule test cases are test code (W27-12)', () => {
    expect(isTestPath('.semgrep/correctness/django/no-raw.py')).toBe(true);
    expect(isTestPath('src/semgrep/rules.py')).toBe(false);
  });

  it('isGeneratedOrVendoredPath: vendored, built, generated, lockfiles', () => {
    for (const p of GENERATED_OR_VENDORED) expect(isGeneratedOrVendoredPath(p), p).toBe(true);
    for (const p of [...PRODUCTION, 'context_test.go']) {
      expect(isGeneratedOrVendoredPath(p), p).toBe(false);
    }
  });

  it('isNonProductionPath: tests plus generated/vendored, and nothing else', () => {
    for (const p of [...TESTS, ...GENERATED_OR_VENDORED]) {
      expect(isNonProductionPath(p), p).toBe(true);
    }
    for (const p of PRODUCTION) expect(isNonProductionPath(p), p).toBe(false);
  });

  it('the patterns are plain strings whose union is the non-production pattern', () => {
    expect(NON_PRODUCTION_PATH_PATTERN).toBe(
      `${TEST_PATH_PATTERN}|${GENERATED_OR_VENDORED_PATH_PATTERN}`,
    );
    const re = new RegExp(NON_PRODUCTION_PATH_PATTERN);
    for (const p of [...TESTS, ...GENERATED_OR_VENDORED, ...PRODUCTION]) {
      expect(re.test(p.replace(/^\.?\/+/, '')), p).toBe(isNonProductionPath(p));
    }
  });

  it('tool globs never exclude a file the regex would keep', () => {
    // fnmatch semantics: `*` crosses `/`. Lizard sees absolute paths under /scan.
    const fnmatch = (glob: string): RegExp =>
      new RegExp(
        `^${glob
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.')}$`,
      );
    const lizard = nonProductionFnmatchGlobs().map(fnmatch);
    const corpus = [...TESTS, ...GENERATED_OR_VENDORED, ...PRODUCTION, 'a/test_dir/x.py'];
    for (const p of corpus) {
      const path = `/scan/${p.replace(/^\.?\/+/, '')}`;
      if (lizard.some((re) => re.test(path))) expect(isNonProductionPath(p), p).toBe(true);
    }
    // ...and they do catch the common shapes before the tool reads them.
    for (const p of ['vendor/a/b.go', 'x/y_test.go', 'src/a.test.ts', 'tests/t.py']) {
      expect(
        lizard.some((re) => re.test(`/scan/${p}`)),
        p,
      ).toBe(true);
    }
    // jscpd: no braces (it splits --ignore on commas), every glob rooted at **/.
    for (const g of nonProductionGlobstarGlobs()) {
      expect(g).toMatch(/^\*\*\//);
      expect(g).not.toMatch(/[{},]/);
    }
  });
});
