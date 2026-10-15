import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  readDeclaredDependencies,
  readManifest,
  requirementsShape,
  type DeclaredDependency,
} from '../../validation/declared.js';
import { readResolvedSet } from '../../validation/scope.js';
import { readSnapshotSources } from '../../snapshot/sources.js';
import {
  DEP_CATEGORIES,
  DEP_CATEGORY_TABLE_VERSION,
  EXCLUDED,
  categoryOf,
} from './dep-categories.js';
import { duplicatePurposeDeps } from './duplicate-deps.js';
import { libraryReimplementations, maskPython } from './library-reimpl.js';

// Dependency hygiene (W18-06). Both rules are only worth shipping if they are
// quiet on projects that chose well, so the clean fixture is the larger one:
// every near-miss we could think of lives there and must stay silent.

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/dep-hygiene',
);

const run = (dir: string) => {
  const declared = readDeclaredDependencies(dir);
  return {
    declared,
    duplicates: duplicatePurposeDeps(declared.dependencies),
    reimpl: libraryReimplementations(readSnapshotSources(dir).files, declared.dependencies),
  };
};

const dep = (
  name: string,
  ecosystem: DeclaredDependency['ecosystem'] = 'npm',
  scope: DeclaredDependency['scope'] = 'direct',
  unit = '',
): DeclaredDependency => ({ ecosystem, name, scope, unit, manifest: `${unit}/x` });

describe('the category table', () => {
  it('is versioned and covers npm, PyPI, Go, Maven and Cargo', () => {
    expect(DEP_CATEGORY_TABLE_VERSION).toMatch(/^dep-categories\.v\d+$/);
    const ecosystems = new Set(DEP_CATEGORIES.map((c) => c.ecosystem));
    expect([...ecosystems].sort()).toEqual(['cargo', 'go', 'maven', 'npm', 'pypi']);
    for (const purpose of ['dates', 'http-client', 'logger', 'test-runner', 'validation', 'orm']) {
      expect(DEP_CATEGORIES.some((c) => c.ecosystem === 'npm' && c.purpose === purpose)).toBe(true);
    }
  });

  it('cites why for every row, and every row can actually pair', () => {
    for (const category of DEP_CATEGORIES) {
      expect(category.why.length, `${category.ecosystem}/${category.purpose}`).toBeGreaterThan(40);
      expect(category.members.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('puts no package in two rows, and none of the deliberately excluded ones anywhere', () => {
    const seen = new Map<string, string>();
    for (const category of DEP_CATEGORIES) {
      for (const member of category.members) {
        for (const name of member.names) {
          const key = `${category.ecosystem}:${name}`;
          expect(seen.get(key), key).toBeUndefined();
          seen.set(key, category.purpose);
        }
      }
    }
    for (const excluded of EXCLUDED) {
      expect(categoryOf(excluded.ecosystem, excluded.name), excluded.name).toBeNull();
      expect(excluded.why.length).toBeGreaterThan(10);
    }
  });

  it('matches under each ecosystem’s own name rules', () => {
    expect(categoryOf('pypi', 'SQLAlchemy')?.member.id).toBe('sqlalchemy');
    expect(categoryOf('cargo', 'env-logger')?.member.id).toBe('env_logger');
    expect(categoryOf('go', 'github.com/go-resty/resty/v2')?.member.id).toBe('resty');
    expect(categoryOf('maven', 'org.hibernate.orm:hibernate-core')?.member.id).toBe('hibernate');
  });
});

describe('slop.duplicate_purpose_deps', () => {
  it('fires on the triggering fixture: one finding per project and purpose, every ecosystem', () => {
    const { duplicates } = run(path.join(FIXTURES, 'triggering'));
    expect(duplicates.map((d) => `${d.manifest} ${d.purpose} ${d.packages.join(',')}`)).toEqual([
      'api/pyproject.toml http-client requests,httpx',
      'api/pyproject.toml logger loguru,structlog',
      'jvm/pom.xml http-client org.apache.httpcomponents.client5:httpclient5,com.squareup.okhttp3:okhttp',
      'jvm/pom.xml logger ch.qos.logback:logback-classic,org.apache.logging.log4j:log4j-core',
      'oldlock/package.json http-client axios,superagent',
      'py-req/requirements.txt dates arrow,pendulum',
      'rs/Cargo.toml http-client reqwest,ureq',
      'rs/Cargo.toml orm diesel,sea-orm',
      'svc/go.mod logger github.com/sirupsen/logrus,go.uber.org/zap',
      'web/package.json dates moment,dayjs',
      'web/package.json http-client axios,got',
      'web/package.json validation zod,yup',
    ]);
    expect(duplicates[0]!.message).toContain(DEP_CATEGORY_TABLE_VERSION);
  });

  it('stays silent on every near-miss in the clean fixture', () => {
    // dev-only jest+vitest (a migration), knex beside objection, a transitive
    // moment under a direct dayjs, axios and got in two separate projects,
    // pip-compile and pip-freeze files, extras, Go `// indirect` and test
    // libraries, Maven test scope / dependencyManagement / plugin deps, Cargo
    // dev- and build-dependencies and [workspace.dependencies].
    const { declared, duplicates } = run(path.join(FIXTURES, 'clean'));
    expect(declared.unreadable).toEqual([]);
    expect(duplicates).toEqual([]);
  });

  it('a pair across two projects, or with one side dev or transitive, is not a pair', () => {
    expect(
      duplicatePurposeDeps([dep('axios', 'npm', 'direct', 'a'), dep('got', 'npm', 'direct', 'b')]),
    ).toEqual([]);
    expect(duplicatePurposeDeps([dep('axios'), dep('got', 'npm', 'dev')])).toEqual([]);
    expect(duplicatePurposeDeps([dep('axios'), dep('got', 'npm', 'transitive')])).toEqual([]);
    expect(
      duplicatePurposeDeps([dep('requests', 'pypi'), dep('httpx', 'pypi', 'unknown')]),
    ).toEqual([]);
    expect(duplicatePurposeDeps([dep('axios'), dep('got')])).toHaveLength(1);
  });

  it('one library under two names is one member, not a duplicate', () => {
    expect(
      duplicatePurposeDeps([
        dep('org.hibernate:hibernate-core', 'maven'),
        dep('org.hibernate.orm:hibernate-core', 'maven'),
      ]),
    ).toEqual([]);
    expect(
      duplicatePurposeDeps([dep('gorm.io/gorm', 'go'), dep('github.com/jinzhu/gorm', 'go')]),
    ).toEqual([]);
  });

  it('never evaluates a test-runner pair where the manifest has no dev scope (Go)', () => {
    expect(
      duplicatePurposeDeps([
        dep('github.com/onsi/ginkgo/v2', 'go'),
        dep('gopkg.in/check.v1', 'go'),
      ]),
    ).toEqual([]);
    expect(duplicatePurposeDeps([dep('jest'), dep('mocha')])).toHaveLength(1);
  });

  it('skips manifests under fixtures, examples and docs', () => {
    expect(
      duplicatePurposeDeps([
        dep('axios', 'npm', 'direct', 'examples/basic'),
        dep('got', 'npm', 'direct', 'examples/basic'),
      ]),
    ).toEqual([]);
  });
});

describe('the declared-dependency reader', () => {
  it('reuses V1’s lockfile parse and leaves V1’s resolved set untouched', () => {
    const clean = path.join(FIXTURES, 'clean');
    const declared = readDeclaredDependencies(clean).dependencies.filter(
      (d) => d.unit === 'locked',
    );
    expect(declared.map((d) => `${d.name}:${d.scope}`)).toEqual([
      'dayjs:direct',
      'chart-lib:direct',
      'moment:transitive',
    ]);
    // V1 still reads only its own three manifest kinds.
    expect(
      readResolvedSet(clean).manifests.every((m) => !/pom\.xml|Cargo\.toml|pyproject/.test(m)),
    ).toBe(true);
  });

  it('reads pip-compile annotations as the graph and treats a freeze dump as unknown', () => {
    const compiled = requirementsShape(
      ['httpx==0.27.0', '    # via openai', 'openai==1.0', '    # via -r requirements.in'].join(
        '\n',
      ),
    );
    expect([...compiled.transitive]).toEqual(['httpx']);
    expect(compiled.frozen).toBe(false);
    // A constraints file pins; it does not ask.
    const constrained = requirementsShape(
      ['httpx==0.28.1', '    # via', '    #   -c constraints.txt', '    #   openai'].join('\n'),
    );
    expect([...constrained.transitive]).toEqual(['httpx']);
    expect(requirementsShape('certifi==1\nidna==3\nrequests==2\n').frozen).toBe(true);
    expect(requirementsShape('certifi==1\nidna==3\nrequests>=2\n').frozen).toBe(false);
    expect(requirementsShape('requests==2.32\nhttpx==0.27\n').frozen).toBe(false);
  });

  it('reads Cargo renames, cfg-targeted tables and the sub-table form', () => {
    const found = readManifest(
      'Cargo.toml',
      [
        '[dependencies]',
        'http = { package = "reqwest", version = "0.12" }',
        '[target.\'cfg(target_os = "linux")\'.dependencies]',
        'ureq = "2"',
        '[dependencies.chrono]',
        'version = "0.4"',
      ].join('\n'),
      'Cargo.toml',
    );
    expect(found?.map((d) => `${d.name}:${d.scope}`)).toEqual([
      'reqwest:direct',
      'ureq:direct',
      'chrono:direct',
    ]);
  });

  it('reads PEP 621 and Poetry, but not extras', () => {
    const found = readManifest(
      'pyproject.toml',
      [
        '[project]',
        'dependencies = [',
        '  "requests[socks]>=2",  # a comment',
        "  'pydantic>=2',",
        ']',
        '[project.optional-dependencies]',
        'fast = ["httpx"]',
        '[tool.poetry.dependencies]',
        'python = "^3.11"',
        'loguru = "^0.7"',
      ].join('\n'),
      'pyproject.toml',
    );
    expect(found?.map((d) => `${d.name}:${d.scope}`)).toEqual([
      'requests:direct',
      'pydantic:direct',
      'loguru:direct',
    ]);
  });
});

describe('slop.library_reimplementation', () => {
  it('fires on real implementations in every supported language', () => {
    const { reimpl } = run(path.join(FIXTURES, 'triggering'));
    expect(reimpl.map((r) => `${r.file}:${r.line} ${r.name} ${r.dependency}`).sort()).toEqual(
      [
        'api/app/text.py:6 slugify python-slugify',
        'api/app/text.py:13 retry tenacity',
        'jvm/src/main/java/com/acme/Text.java:6 isBlank org.apache.commons:commons-lang3',
        'svc/text.go:12 Slugify github.com/gosimple/slug',
        'svc/text.go:16 Retry github.com/avast/retry-go/v4',
        'web/src/util.ts:3 debounce lodash',
        'web/src/util.ts:11 deepClone lodash',
        'web/src/util.ts:20 generateUuid uuid',
      ].sort(),
    );
  });

  it('stays silent on wrappers, missing or dev-only libraries, tests and same-name strangers', () => {
    expect(run(path.join(FIXTURES, 'clean')).reimpl).toEqual([]);
  });

  const lodash = [dep('lodash')];
  const fire = (source: string, deps = lodash, file = 'src/a.ts') =>
    libraryReimplementations([{ path: file, source }], deps).map((r) => r.name);

  it('a call that carries the API’s name is delegation, even without an import', () => {
    expect(
      fire(
        [
          "import { debounceImpl } from './vendor';",
          'export function debounce(fn: () => void, ms: number) {',
          '  const wait = Math.max(ms, 0);',
          '  setTimeout(() => undefined, 0);',
          '  return debounceImpl(fn, wait);',
          '}',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('a recursive deep clone is its own implementation, not delegation', () => {
    expect(
      fire(
        'function deepClone(v) {\n  if (typeof v !== "object") return v;\n  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepClone(x)]));\n}',
        lodash,
        'src/a.js',
      ),
    ).toEqual(['deepClone']);
  });

  it('needs the library to be a direct runtime dependency of a project above the file', () => {
    const impl =
      'export function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }';
    expect(fire(impl, [dep('lodash', 'npm', 'direct', 'web')], 'web/src/a.js')).toEqual([
      'debounce',
    ]);
    expect(fire(impl, [dep('lodash', 'npm', 'direct', 'api')], 'web/src/a.js')).toEqual([]);
    expect(fire(impl, [dep('lodash', 'npm', 'transitive')], 'src/a.js')).toEqual([]);
    expect(fire(impl, [dep('lodash', 'npm', 'dev')], 'src/a.js')).toEqual([]);
  });

  it('reads a docstring or comment as text, never as the mechanism', () => {
    const source = [
      'def slugify(value):',
      '    """Uses re.sub(...) and normalize(...) under the hood."""',
      '    # re.sub(r"x", "", value)',
      '    return helper(value)',
    ].join('\n');
    expect(maskPython(source)).not.toContain('re.sub');
    expect(fire(source, [dep('python-slugify', 'pypi')], 'app/text.py')).toEqual([]);
  });

  // Found on the measurement corpus (W18-06 note): each was a false positive
  // before the guard that this test pins.
  it('skips helpers nested inside a function or IIFE, and nested Python defs', () => {
    const nested = [
      '(async function () {',
      '  const debounce = function (fn, ms) {',
      '    let t;',
      '    return () => { clearTimeout(t); t = setTimeout(fn, ms); };',
      '  };',
      '})();',
    ].join('\n');
    expect(fire(nested, lodash, 'src/snippet.js')).toEqual([]);
    const py = [
      'def render(text):',
      '    def slugify(v):',
      '        return re.sub("x", "-", v)',
      '    return slugify(text)',
    ].join('\n');
    expect(fire(py, [dep('django', 'pypi')], 'app/md.py')).toEqual([]);
  });

  it('skips minified or bundled files', () => {
    const bundle = `function cX(a){var t;return function(){clearTimeout(t);t=setTimeout(a,9)}}${';'.repeat(600)}`;
    expect(fire(bundle.replace('cX', 'debounce'), lodash, 'static/assets/a.chunk.js')).toEqual([]);
  });

  it('treats any retry/backoff import as delegation in Go', () => {
    const go = [
      'package retry',
      'import (',
      '\t"time"',
      '\t"github.com/jpillora/backoff"',
      ')',
      'func Retry(f func() error) error {',
      '\tb := &backoff.Backoff{}',
      '\tfor { if err := f(); err == nil { return nil }; time.Sleep(b.Duration()) }',
      '}',
    ].join('\n');
    expect(fire(go, [dep('github.com/cenkalti/backoff/v4', 'go')], 'lib/retry.go')).toEqual([]);
    expect(
      fire(
        go.replace('\t"github.com/jpillora/backoff"\n', ''),
        [dep('github.com/cenkalti/backoff/v4', 'go')],
        'lib/retry.go',
      ),
    ).toEqual(['Retry']);
  });
});

describe('a lockfile V1 cannot read', () => {
  it('falls back to the package.json beside it, and still reports the lockfile', () => {
    const { declared, duplicates } = run(path.join(FIXTURES, 'triggering'));
    expect(declared.unreadable.map((u) => u.manifest)).toEqual(['oldlock/package-lock.json']);
    expect(duplicates.find((d) => d.unit === 'oldlock')?.packages).toEqual(['axios', 'superagent']);
  });
});
