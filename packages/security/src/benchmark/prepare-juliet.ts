import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORPUS_DIR, cacheDir, suiteSchema, type ArchiveSpec } from './corpus.js';

// Prep step for the Juliet suite (W18-40). Run by hand, never by the benchmark:
//
//   pnpm --filter @repopulse/security bench:prepare-juliet          # fetch + verify
//   pnpm --filter @repopulse/security bench:prepare-juliet --pin    # re-select + re-pin hashes
//
// Juliet is NIST's synthetic test suite (SARD): every test case has a `bad`
// part that contains the weakness and `good` parts that look similar and are
// safe. It is public domain (a US government work), but at ~100 MB it is
// fetched, not vendored; the committed suite.json carries the archive's SHA-256
// and each selected file's, and this script refuses bytes that differ.
//
// LABELS COME FROM THE CODE, not from a separate answer key, because Juliet's
// naming is the key: a `bad()` method is a defect, a `good*()` method is a
// near-miss that must stay quiet, and the `_NN_bad.java` / `_NN_goodXxx.java`
// helper classes of the multi-file flow variants are whole-file defects or
// near-misses. Each label carries the CWE the rules report that weakness as
// (Juliet splits XSS across CWE 80/81/83/84; our rules say 79).

const SUITE_DIR = path.join(CORPUS_DIR, 'juliet-java');

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export interface LabelDraft {
  id: string;
  tree: string;
  file: string;
  lines?: [number, number];
  cwe: number;
  dimension: 'sast';
  expect: 'finding' | 'none';
  note: string;
}

/** Source with comments and string/char literals blanked, same length and line breaks, so braces can be counted. */
export function blankLiterals(source: string): string {
  let out = '';
  let i = 0;
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (source[i] === '"' || source[i] === "'") {
      const quote = source[i]!;
      let j = i + 1;
      while (j < source.length && source[j] !== quote && source[j] !== '\n') {
        j += source[j] === '\\' ? 2 : 1;
      }
      out += blank(source.slice(i, j + 1));
      i = j + 1;
    } else {
      out += source[i];
      i += 1;
    }
  }
  return out;
}

const METHOD = /\b(?:public|private|protected)\s+(?:static\s+)?void\s+(bad|good\w*)\s*\([^)]*\)/g;

/** Inclusive 1-based line ranges of the bad()/good*() methods of a Juliet class. */
export function methodRanges(source: string): { name: string; lines: [number, number] }[] {
  const text = blankLiterals(source);
  const lineOf = (offset: number): number => text.slice(0, offset).split('\n').length;
  const out: { name: string; lines: [number, number] }[] = [];
  for (const m of text.matchAll(METHOD)) {
    const name = m[1]!;
    // `good()` only calls the other good* methods; it is not itself a near-miss.
    if (name === 'good') continue;
    const open = text.indexOf('{', m.index! + m[0].length);
    if (open === -1) continue;
    let depth = 0;
    let close = -1;
    for (let k = open; k < text.length; k++) {
      if (text[k] === '{') depth += 1;
      else if (text[k] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    if (close === -1) continue;
    out.push({ name, lines: [lineOf(m.index!), lineOf(close)] });
  }
  return out;
}

/** The labels for one Juliet source file. `file` is relative to the tree. */
export function julietLabels(
  file: string,
  source: string,
  cwe: number,
  tree: string,
): LabelDraft[] {
  const base = path.posix.basename(file);
  const make = (
    id: string,
    expect: 'finding' | 'none',
    note: string,
    lines?: [number, number],
  ): LabelDraft => ({
    id,
    tree,
    file,
    ...(lines ? { lines } : {}),
    cwe,
    dimension: 'sast',
    expect,
    note,
  });
  // The multi-file flow variants: `_81_bad.java` holds the sink of a defect,
  // `_81_goodG2B.java` the sink of a safe variant, `_81_base.java` neither.
  if (/_\d+_bad\.java$/.test(base)) return [make(base, 'finding', 'Juliet bad class (whole file)')];
  if (/_\d+_good\w*\.java$/.test(base))
    return [make(base, 'none', 'Juliet good class (whole file)')];
  if (/_\d+_base\.java$/.test(base)) return [];
  return methodRanges(source).map((m) =>
    make(
      `${base}#${m.name}`,
      m.name === 'bad' ? 'finding' : 'none',
      m.name === 'bad' ? 'Juliet bad()' : `Juliet ${m.name}()`,
      m.lines,
    ),
  );
}

function listJava(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.java')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** At most `n` items, evenly strided so every flow variant is represented, in a fixed order. */
export function stride<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor((i * items.length) / n)]!);
  return out;
}

function main(pin: boolean): void {
  const manifestPath = path.join(SUITE_DIR, 'suite.json');
  const manifest = suiteSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const spec: ArchiveSpec | undefined = manifest.archive;
  if (!spec) throw new Error('juliet-java suite.json has no archive spec');

  const work = mkdtempSync(path.join(tmpdir(), 'juliet-bench-'));
  try {
    const zip = path.join(work, 'juliet.zip');
    execFileSync('curl', ['-sSfL', '--retry', '3', '-o', zip, spec.url]);
    const archiveDigest = sha256(readFileSync(zip));
    if (pin) spec.sha256 = archiveDigest;
    else if (archiveDigest !== spec.sha256) throw new Error('juliet archive hash mismatch');
    const extracted = path.join(work, 'x');
    mkdirSync(extracted);
    execFileSync('unzip', ['-q', zip, '-d', extracted], { maxBuffer: 64 * 1024 * 1024 });
    const root = path.join(extracted, spec.root);

    let chosen: { rel: string; cwe: number }[];
    if (pin) {
      const all = listJava(root).map((f) => path.relative(root, f).split(path.sep).join('/'));
      chosen = spec.cwes.flatMap(({ dir, cwe }) =>
        stride(
          all.filter((rel) => new RegExp(`^CWE${dir}_[^/]+/`).test(rel)),
          spec.perCwe,
        ).map((rel) => ({ rel, cwe })),
      );
    } else {
      const cweOf = (rel: string): number => {
        const dir = Number(/^CWE(\d+)_/.exec(rel)?.[1]);
        const hit = spec.cwes.find((c) => c.dir === dir);
        if (!hit) throw new Error(`${rel}: directory CWE ${dir} is not in the pinned selection`);
        return hit.cwe;
      };
      chosen = spec.files.map((f) => ({ rel: f.path, cwe: cweOf(f.path) }));
    }

    const cache = cacheDir(SUITE_DIR);
    rmSync(cache, { recursive: true, force: true });
    const treeDir = path.join(cache, 'testcases');
    const pinned: ArchiveSpec['files'] = [];
    const labels: LabelDraft[] = [];
    for (const { rel, cwe } of chosen) {
      const bytes = readFileSync(path.join(root, rel));
      const digest = sha256(bytes);
      const expected = spec.files.find((f) => f.path === rel)?.sha256;
      if (!pin && digest !== expected) throw new Error(`hash mismatch for ${rel}`);
      pinned.push({ path: rel, sha256: digest });
      mkdirSync(path.dirname(path.join(treeDir, rel)), { recursive: true });
      copyFileSync(path.join(root, rel), path.join(treeDir, rel));
      labels.push(...julietLabels(rel, bytes.toString('utf8'), cwe, 'testcases'));
    }
    writeFileSync(path.join(cache, 'labels.json'), `${JSON.stringify(labels, null, 2)}\n`);
    if (pin) {
      spec.files = pinned;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    process.stdout.write(
      `juliet-java: ${pinned.length} files, ${labels.length} labels in ${path.relative(process.cwd(), cache)}\n`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.includes('--pin'));
}
