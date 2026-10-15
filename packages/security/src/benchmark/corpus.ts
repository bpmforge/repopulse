import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Label, UnlabelledPolicy } from './match.js';

// The benchmark corpus (W18-17): one directory per suite under
// fixtures/benchmark, each with a suite.json that says where the code came
// from, under what licence, and what a correct scanner reports on it.
//
// Labels live NEXT TO the code they grade and are committed with it. A label
// file generated at run time would let the corpus and its answers drift apart
// without a diff showing it; the one exception is a fetched suite (OWASP
// Benchmark), whose labels are derived at prep time from the upstream answer
// key and pinned by that key's hash.

export const CORPUS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/benchmark',
);

const lineRange = z
  .tuple([z.number().int().positive(), z.number().int().positive()])
  .refine(([a, b]) => a <= b, 'line range must be ascending');

const labelSchema = z
  .object({
    id: z.string().min(1),
    tree: z.string().min(1),
    file: z.string().min(1),
    lines: lineRange.optional(),
    rule: z.string().min(1).optional(),
    accept: z.array(z.string().min(1)).optional(),
    cwe: z.number().int().positive().optional(),
    dimension: z.string().min(1),
    expect: z.enum(['finding', 'none']),
    note: z.string().optional(),
  })
  .strict();

const sourceSchema = z
  .object({
    kind: z.enum(['vendored', 'in-repo', 'authored', 'fetched']),
    repository: z.string().optional(),
    commit: z.string().optional(),
    path: z.string().optional(),
    licence: z.string().min(1),
    notes: z.string().optional(),
  })
  .strict();

const fetchSchema = z
  .object({
    /** Raw-file URL template; `{commit}` and `{path}` are substituted. */
    rawUrl: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    answerKey: z.object({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
    sourceDir: z.string(),
    selection: z.object({
      categories: z.array(z.string()).min(1),
      perVerdict: z.number().int().positive(),
    }),
    files: z.array(
      z.object({ test: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    ),
  })
  .strict();

export const suiteSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1),
    description: z.string().min(1),
    source: sourceSchema,
    unlabelled: z.enum(['fp', 'ignore']),
    trees: z.array(z.object({ id: z.string().min(1), path: z.string().min(1) }).strict()).min(1),
    labels: z.array(labelSchema),
    fetch: fetchSchema.optional(),
  })
  .strict();

export type SuiteManifest = z.infer<typeof suiteSchema>;
export type FetchSpec = z.infer<typeof fetchSchema>;

export interface Tree {
  suite: string;
  id: string;
  /** Absolute directory. */
  dir: string;
}

export interface Suite {
  manifest: SuiteManifest;
  dir: string;
  /** False for a fetched suite whose prep step has not been run. */
  prepared: boolean;
  trees: Tree[];
  labels: Label[];
  policy: UnlabelledPolicy;
}

/** Where a fetched suite's prep step puts its files. Gitignored. */
export function cacheDir(suiteDir: string): string {
  return path.join(suiteDir, '.cache');
}

const fetchedLabelsSchema = z.array(labelSchema);

export function loadSuite(dir: string): Suite {
  const manifest = suiteSchema.parse(
    JSON.parse(readFileSync(path.join(dir, 'suite.json'), 'utf8')),
  );
  let rawLabels = manifest.labels;
  let prepared = true;
  if (manifest.fetch) {
    const generated = path.join(cacheDir(dir), 'labels.json');
    prepared = existsSync(generated);
    rawLabels = prepared
      ? [...rawLabels, ...fetchedLabelsSchema.parse(JSON.parse(readFileSync(generated, 'utf8')))]
      : rawLabels;
  }
  const trees = manifest.trees.map((t) => ({
    suite: manifest.id,
    id: t.id,
    dir: path.resolve(dir, t.path),
  }));
  const treeIds = new Set(trees.map((t) => t.id));
  const labels: Label[] = rawLabels.map((l) => {
    if (!treeIds.has(l.tree)) {
      throw new Error(`${manifest.id}: label ${l.id} names unknown tree ${l.tree}`);
    }
    const label: Label = {
      suite: manifest.id,
      tree: l.tree,
      id: l.id,
      file: l.file,
      dimension: l.dimension,
      expect: l.expect,
    };
    if (l.lines) label.lines = l.lines;
    if (l.rule) label.rule = l.rule;
    if (l.accept) label.accept = l.accept;
    if (l.cwe !== undefined) label.cwe = l.cwe;
    if (l.note) label.note = l.note;
    return label;
  });
  const ids = new Set<string>();
  for (const l of labels) {
    if (ids.has(l.id)) throw new Error(`${manifest.id}: duplicate label id ${l.id}`);
    ids.add(l.id);
  }
  return { manifest, dir, prepared, trees, labels, policy: manifest.unlabelled };
}

export function loadCorpus(root: string = CORPUS_DIR): Suite[] {
  return readdirSync(root)
    .filter((name) => existsSync(path.join(root, name, 'suite.json')))
    .sort()
    .map((name) => loadSuite(path.join(root, name)));
}

/** Files under a tree, relative and sorted. Dot-directories are not corpus. */
export function treeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, rel: string): void => {
    for (const entry of readdirSync(current).sort()) {
      if (entry.startsWith('.')) continue;
      const full = path.join(current, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (statSync(full).isDirectory()) walk(full, relPath);
      else out.push(relPath);
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}
