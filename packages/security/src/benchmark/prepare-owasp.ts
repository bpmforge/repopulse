import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORPUS_DIR, cacheDir, suiteSchema, type FetchSpec } from './corpus.js';

// Prep step for the OWASP Benchmark suite (W18-17). Run by hand, never by the
// benchmark itself:
//
//   pnpm --filter @repopulse/security bench:prepare-owasp          # fetch + verify
//   pnpm --filter @repopulse/security bench:prepare-owasp --pin    # re-select + re-pin hashes
//
// WHY FETCHED, NOT VENDORED. OWASP Benchmark is GPL-2.0 and this repository is
// proprietary; copying its test cases in would put GPL code in our tree. The
// committed suite.json carries only the pinned commit, which tests were picked,
// and the SHA-256 of each file and of the answer key. This script downloads
// exactly those bytes into the suite's gitignored .cache and refuses anything
// whose hash differs, so the corpus is as pinned as a vendored one.
//
// curl rather than fetch(): it honours the proxy environment out of the box,
// and this is a developer tool, not product code that talks to a forge.

const SUITE_DIR = path.join(CORPUS_DIR, 'owasp-benchmark');

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** The repository at the pinned commit, extracted once, so ~2,700 files are one download. */
function extractArchive(spec: FetchSpec): string | null {
  if (!spec.archiveUrl) return null;
  const dir = mkdtempSync(path.join(tmpdir(), 'owasp-bench-'));
  const tarball = path.join(dir, 'repo.tar.gz');
  execFileSync('curl', [
    '-sSfL',
    '--retry',
    '3',
    '-o',
    tarball,
    spec.archiveUrl.replace('{commit}', spec.commit),
  ]);
  execFileSync('tar', ['-xzf', tarball, '-C', dir, '--strip-components=1']);
  return dir;
}

function download(spec: FetchSpec, file: string, extracted: string | null): Buffer {
  if (extracted && !file.endsWith('.csv')) return readFileSync(path.join(extracted, file));
  const url = spec.rawUrl.replace('{commit}', spec.commit).replace('{path}', file);
  return execFileSync('curl', ['-sSfL', '--retry', '3', url], { maxBuffer: 64 * 1024 * 1024 });
}

interface Row {
  test: string;
  category: string;
  real: boolean;
  cwe: number;
}

export function parseAnswerKey(csv: string): Row[] {
  return csv
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => {
      const [test, category, real, cwe] = line.split(',').map((c) => c.trim());
      return { test: test!, category: category!, real: real === 'true', cwe: Number(cwe) };
    });
}

/** The first N real and N false cases of each category, in answer-key order. */
export function selectTests(rows: readonly Row[], spec: FetchSpec['selection']): Row[] {
  const picked: Row[] = [];
  for (const category of spec.categories) {
    for (const real of [true, false]) {
      picked.push(
        ...rows
          .filter((r) => r.category === category && r.real === real)
          .slice(0, spec.perVerdict ?? Number.POSITIVE_INFINITY),
      );
    }
  }
  return picked;
}

function main(pin: boolean): void {
  const manifestPath = path.join(SUITE_DIR, 'suite.json');
  const manifest = suiteSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const spec = manifest.fetch;
  if (!spec) throw new Error('owasp-benchmark suite.json has no fetch spec');

  const extracted = extractArchive(spec);
  const keyBytes = download(spec, spec.answerKey.path, null);
  if (pin) spec.answerKey.sha256 = sha256(keyBytes);
  else if (sha256(keyBytes) !== spec.answerKey.sha256) {
    throw new Error(`answer key hash mismatch for ${spec.answerKey.path}`);
  }
  const rows = parseAnswerKey(keyBytes.toString('utf8'));
  const byTest = new Map(rows.map((r) => [r.test, r]));
  const tests = pin
    ? selectTests(rows, spec.selection).map((r) => r.test)
    : spec.files.map((f) => f.test);

  const cache = cacheDir(SUITE_DIR);
  rmSync(cache, { recursive: true, force: true });
  const treeDir = path.join(cache, 'testcode');
  mkdirSync(treeDir, { recursive: true });

  const pinned: FetchSpec['files'] = [];
  for (const test of tests) {
    const bytes = download(spec, `${spec.sourceDir}/${test}.java`, extracted);
    const digest = sha256(bytes);
    const expected = spec.files.find((f) => f.test === test)?.sha256;
    if (!pin && digest !== expected) throw new Error(`hash mismatch for ${test}`);
    pinned.push({ test, sha256: digest });
    writeFileSync(path.join(treeDir, `${test}.java`), bytes);
  }

  const labels = tests.map((test) => {
    const row = byTest.get(test);
    if (!row) throw new Error(`${test} is not in the answer key`);
    return {
      id: test,
      tree: 'testcode',
      file: `${test}.java`,
      cwe: row.cwe,
      dimension: 'sast',
      expect: row.real ? 'finding' : 'none',
      note: `${row.category} (CWE-${row.cwe}), ${row.real ? 'real vulnerability' : 'false-positive trap'} per expectedresults`,
    };
  });
  writeFileSync(path.join(cache, 'labels.json'), `${JSON.stringify(labels, null, 2)}\n`);

  if (pin) {
    spec.files = pinned;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (extracted) rmSync(extracted, { recursive: true, force: true });
  process.stdout.write(
    `owasp-benchmark: ${tests.length} test cases in ${path.relative(process.cwd(), cache)}\n`,
  );
}

// Imported by its test for the pure helpers; only a direct run fetches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.includes('--pin'));
}
