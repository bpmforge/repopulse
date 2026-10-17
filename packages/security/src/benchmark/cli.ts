import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from './corpus.js';
import { runAdapterLane, type AdapterRun } from './engines.js';
import { renderMarkdown } from './report.js';
import { runBenchmark } from './run.js';

// Benchmark runner entry point (W18-17). See docs/BENCHMARKS.md.
//
//   pnpm --filter @repopulse/security bench            # writes docs/benchmarks/report.{json,md}
//   pnpm --filter @repopulse/security bench --check    # exits 1 if the committed report is stale
//   ... --no-yaml | --yaml-bin <path> | --out <dir>
//   ... --no-adapters | --adapters-image <ref>   (the tool adapters need the scan image;
//       without one their labels are skipped and reported "not run", never missed)
//   ... --date YYYY-MM-DD --commit <sha>   (recorded in the report; a published number says when)
//
// No network: the corpus is on disk (a fetched suite is fetched by its own
// prep script, never here) and the YAML engine runs with its version check and
// metrics off.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The scan image to run the adapters in: SCAN_IMAGE, else the newest localhost/repopulse/scan:* podman has. */
function detectScanImage(): string | undefined {
  if (process.env['SCAN_IMAGE']) return process.env['SCAN_IMAGE'];
  try {
    return execFileSync('podman', ['images', '--format', '{{.Repository}}:{{.Tag}}'], {
      stdio: 'pipe',
    })
      .toString()
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('localhost/repopulse/scan:'));
  } catch {
    return undefined;
  }
}

async function main(argv: string[]): Promise<number> {
  let out = path.join(REPO_ROOT, 'docs/benchmarks');
  let yaml = true;
  let yamlBin: string | undefined;
  let check = false;
  let date: string | null = null;
  let commit: string | null = null;
  let adapters = true;
  let adaptersImage: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-yaml') yaml = false;
    else if (arg === '--check') check = true;
    else if (arg === '--out') out = path.resolve(argv[++i] ?? out);
    else if (arg === '--yaml-bin') yamlBin = argv[++i];
    else if (arg === '--date') date = argv[++i] ?? null;
    else if (arg === '--commit') commit = argv[++i] ?? null;
    else if (arg === '--no-adapters') adapters = false;
    else if (arg === '--adapters-image') adaptersImage = argv[++i];
    else if (arg === '--') continue;
    else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      return 2;
    }
  }

  let adapterRun: AdapterRun | undefined;
  let adaptersReason: string | undefined;
  if (!adapters) {
    adaptersReason = 'disabled by --no-adapters';
  } else {
    const image = adaptersImage ?? detectScanImage();
    if (!image) {
      adaptersReason = 'no scan image (build Containerfile.scan, or pass --adapters-image)';
    } else {
      const trees = loadCorpus()
        .filter((suite) => suite.prepared && suite.manifest.lane === 'adapters')
        .flatMap((suite) => suite.trees);
      adapterRun = await runAdapterLane(trees, { image });
    }
  }

  const report = runBenchmark({
    yaml,
    ...(adapterRun ? { adapters: adapterRun } : {}),
    ...(adaptersReason ? { adaptersReason } : {}),
    ...(yamlBin ? { yamlBin } : {}),
    ...(date || commit ? { measured: { date, commit } } : {}),
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const md = renderMarkdown(report);
  const jsonPath = path.join(out, 'report.json');
  const mdPath = path.join(out, 'report.md');

  const t = report.totals;
  const summary = `TP ${t.tp} FP ${t.fp} FN ${t.fn} precision ${t.precision ?? '-'} recall ${t.recall ?? '-'}`;

  if (check) {
    const stale =
      !existsSync(jsonPath) ||
      readFileSync(jsonPath, 'utf8') !== json ||
      !existsSync(mdPath) ||
      readFileSync(mdPath, 'utf8') !== md;
    process.stdout.write(`${summary}\n`);
    if (stale) {
      process.stderr.write(
        `benchmark report at ${path.relative(REPO_ROOT, out)} is stale; re-run without --check\n`,
      );
      return 1;
    }
    return 0;
  }

  mkdirSync(out, { recursive: true });
  writeFileSync(jsonPath, json);
  writeFileSync(mdPath, md);
  process.stdout.write(`${summary}\nwrote ${path.relative(REPO_ROOT, jsonPath)} and report.md\n`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
