import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ECOSYSTEMS, classify, renderEcosystems, type MatrixFile } from './matrix.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../fixtures/ecosystems');
const DOCS = path.resolve(HERE, '../../../../docs');

const doc = (...purls: string[]) => ({ components: purls.map((purl) => ({ purl })) });
const lodash = ECOSYSTEMS.find((e) => e.id === 'npm')!;

describe('classify', () => {
  it('is matched when syft read the package and grype matched it', () => {
    const r = classify(lodash, doc('pkg:npm/lodash@4.17.15'), ['pkg:npm/lodash@4.17.15']);
    expect(r).toMatchObject({ status: 'matched', pinnedFound: 1, vulnerabilities: 1 });
  });

  it('is catalogued when syft read it and grype matched nothing', () => {
    const r = classify(lodash, doc('pkg:npm/lodash@4.17.15'), []);
    expect(r.status).toBe('catalogued');
  });

  it('is unsupported when syft reports no such package, and names the purl types it did report', () => {
    const r = classify(lodash, doc('pkg:maven/org.apache/log4j-core@2.14.1'), []);
    expect(r).toMatchObject({ status: 'unsupported', packages: 1, purlTypes: ['maven'] });
  });

  it('does not count a package of the wrong purl type', () => {
    expect(classify(lodash, doc('pkg:pypi/lodash@1.0'), []).status).toBe('unsupported');
  });

  it('is unsupported on an empty or missing document', () => {
    expect(classify(lodash, null, []).status).toBe('unsupported');
    expect(classify(lodash, { components: [] }, []).packages).toBe(0);
  });

  it('matches names through percent-encoding and case', () => {
    const nuget = ECOSYSTEMS.find((e) => e.id === 'nuget')!;
    expect(
      classify(nuget, doc('pkg:nuget/Newtonsoft.Json@9.0.1'), ['pkg:nuget/Newtonsoft.Json@9.0.1'])
        .status,
    ).toBe('matched');
  });
});

describe('the fixture inventory', () => {
  it('has a directory per ecosystem and no directory without one', () => {
    const dirs = readdirSync(FIXTURES).filter((d) => !d.startsWith('.')).sort();
    expect(dirs).toEqual(ECOSYSTEMS.map((e) => e.id).sort());
  });

  it('holds every file each spec names', () => {
    for (const spec of ECOSYSTEMS) {
      for (const f of spec.files) {
        expect(existsSync(path.join(FIXTURES, spec.id, f)), `${spec.id}/${f}`).toBe(true);
      }
    }
  });

  it('pins the package each spec says it pins, in a fixture file', () => {
    for (const spec of ECOSYSTEMS) {
      if (spec.id === 'vcpkg') continue;
      const name = spec.packageName.split('/').pop()!.toLowerCase();
      const text = spec.files
        .map((f) => readFileSync(path.join(FIXTURES, spec.id, f), 'utf8'))
        .join('\n')
        .toLowerCase();
      expect(text, spec.id).toContain(name);
    }
  });

  it('has unique ids', () => {
    expect(new Set(ECOSYSTEMS.map((e) => e.id)).size).toBe(ECOSYSTEMS.length);
  });
});

describe('the committed matrix', () => {
  const jsonPath = path.join(DOCS, 'ecosystems.json');
  const file: MatrixFile = existsSync(jsonPath)
    ? (JSON.parse(readFileSync(jsonPath, 'utf8')) as MatrixFile)
    : { schema: 1, meta: null, results: [] };

  it('only names ecosystems the matrix knows', () => {
    const known = new Set(ECOSYSTEMS.map((e) => e.id));
    for (const r of file.results) expect(known.has(r.id), r.id).toBe(true);
  });

  it('renders every ecosystem, and says so when nothing has been measured', () => {
    const md = renderEcosystems({ schema: 1, meta: null, results: [] });
    expect(md).toContain('has not been run yet');
    for (const spec of ECOSYSTEMS) expect(md).toContain(spec.label);
    expect(md).not.toContain('Supported: read and matched');
  });

  it('keeps docs/ECOSYSTEMS.md equal to its rendering', () => {
    const md = readFileSync(path.join(DOCS, 'ECOSYSTEMS.md'), 'utf8');
    expect(md).toBe(renderEcosystems(file));
  });
});
