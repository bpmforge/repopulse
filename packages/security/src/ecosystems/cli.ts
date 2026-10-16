import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDependencyTools } from '../scanners/dependency/tools.js';
import { ECOSYSTEMS, classify, renderEcosystems, type MatrixFile } from './matrix.js';

// Runs the tested ecosystem matrix (W18-47):
//
//   pnpm --filter @repopulse/security ecosystems [--date YYYY-MM-DD]
//
// Needs the scan image and the vulnerability database, like a dependency scan
// does, so it is run by hand on a machine that has them (SCAN_IMAGE selects the
// image). It writes docs/ecosystems.json and docs/ECOSYSTEMS.md.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../fixtures/ecosystems');
const DOCS = path.resolve(HERE, '../../../../docs');
const IMAGE = process.env.SCAN_IMAGE ?? 'localhost/repopulse/scan:dev';

async function main(argv: string[]): Promise<number> {
  let date: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date') date = argv[++i] ?? null;
  }
  const results: MatrixFile['results'] = [];
  const versions = { syft: 'unknown', grype: 'unknown' };
  for (const spec of ECOSYSTEMS) {
    const dir = path.join(FIXTURES, spec.id);
    if (!existsSync(dir)) throw new Error(`no fixture for ${spec.id}`);
    const run = await runDependencyTools({
      targetDir: dir,
      image: IMAGE,
      budget: { wallClockMs: 120_000 },
    });
    if (run.status !== 'succeeded') {
      process.stderr.write(`${spec.id}: tools failed: ${run.error ?? 'unknown'}\n`);
      return 1;
    }
    versions.syft = run.toolVersions['syft'] ?? versions.syft;
    versions.grype = run.toolVersions['grype'] ?? versions.grype;
    const row = classify(spec, run.document, run.matches.map((m) => m.purl));
    results.push(row);
    process.stdout.write(`${spec.id}: ${row.status} (${row.pinnedFound} read, ${row.vulnerabilities} matched)\n`);
  }
  const file: MatrixFile = {
    schema: 1,
    meta: { ...versions, date, image: IMAGE },
    results,
  };
  mkdirSync(DOCS, { recursive: true });
  writeFileSync(path.join(DOCS, 'ecosystems.json'), `${JSON.stringify(file, null, 2)}\n`);
  writeFileSync(path.join(DOCS, 'ECOSYSTEMS.md'), renderEcosystems(file));
  process.stdout.write(`wrote docs/ecosystems.json and docs/ECOSYSTEMS.md\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);

