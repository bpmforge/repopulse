import {
  runSemgrepScan,
  SEMGREP_RULEPACK_DIR,
  SEMGREP_SCANNER_KEY,
} from '../scanners/semgrep/scanner.js';
import {
  CODE_HEALTH_PACK_DIR,
  DEFAULT_EXCLUDED_GLOBS,
  isExcluded,
  LOGGING_SCANNER_KEY,
} from '../scanners/logging/run.js';
import { PERF_PACK_DIR, PERF_SCANNER_KEY } from '../scanners/perf/run.js';
import { ANTI_SLOP_SCANNER_KEY } from '../scanners/anti-slop/run.js';
import { docstringInflation, ldrFindings, LDR_FLOOR } from '../scanners/anti-slop/ldr.js';
import { unusedExports } from '../scanners/anti-slop/unused-exports.js';
import { phantomRefs } from '../scanners/anti-slop/phantom-refs.js';
import type { FileRuleRunner, RuleHit, RuleRunInput, RuleRunOutput } from './verify.js';

// The rule sets a verified patch is re-checked against (W18-19).
//
// EACH RUNNER MIRRORS ITS SCANNER'S FINDING SHAPE — the same dimension,
// scanner key, rule id and evidence quote the scanner hands the store — so the
// dedup key computed here is the one the stored finding carries. If a scanner
// changes its evidence format and this file is not updated, the target stops
// reproducing in the before-scan and every patch for it is REJECTED. That is
// the failure direction this was built to have: drift costs a verified patch,
// never produces a false one.
//
// WHAT IS NOT HERE, deliberately:
//   - Model judgement findings (slop.judgment, the OWASP checklists): not
//     deterministic, so "it no longer fires" would be a second model's opinion.
//     (Anti-slop PATTERN findings, bpm-ch-*, are here: a model picks which to
//     raise, but the re-check is the Opengrep rule itself.)
//   - secrets: a leaked secret is fixed by rotating it, not by a diff; a patch
//     that deletes the literal leaves it in history and on someone's laptop.
//   - code_health_tools (lizard/jscpd): duplication is a cross-file measure and
//     the tool image runs over a tree; not re-runnable on one file yet.
// A finding from any of these is rejected as `not_rerunnable`, by name.

/** Wall-clock cap per YAML pack run over a one-file directory. */
const PACK_WALL_CLOCK_MS = 2 * 60 * 1000;

interface PackSpec {
  key: string;
  scannerKey: string;
  dimension: string;
  packDir: string;
  /** Rule ids the scanner keeps from the pack (the code-health dir holds two packs). */
  keep?: (ruleId: string) => boolean;
  /** The scanner drops findings in these paths; so must the re-check. */
  excludedGlobs?: readonly string[];
}

function packRunner(spec: PackSpec, image?: string): FileRuleRunner {
  return {
    key: spec.key,
    scannerKeys: [spec.scannerKey],
    async run(input: RuleRunInput): Promise<RuleRunOutput> {
      const scan = await runSemgrepScan({
        targetDir: input.dir,
        rulepackDir: spec.packDir,
        budget: { wallClockMs: PACK_WALL_CLOCK_MS },
        ...(image ? { image } : {}),
      });
      if (scan.status !== 'succeeded') {
        return {
          status: 'failed',
          hits: [],
          reason: scan.error ?? scan.status,
          toolVersions: scan.toolVersions,
        };
      }
      const hits: RuleHit[] = [];
      for (const f of scan.findings) {
        if (spec.keep && !spec.keep(f.ruleId)) continue;
        if (spec.excludedGlobs && isExcluded(f.file, spec.excludedGlobs)) continue;
        hits.push({
          scannerKey: spec.scannerKey,
          ruleId: f.ruleId,
          dimension: spec.dimension,
          file: f.file,
          lineStart: f.lineStart,
          // The evidence quote every pack scanner stores (semgrep/run-modes,
          // logging/run, perf/run).
          evidenceQuote: `${f.file}:${f.lineStart} — ${f.ruleId}`,
          title: f.title,
        });
      }
      return { status: 'succeeded', hits, toolVersions: scan.toolVersions };
    },
  };
}

/**
 * The anti_slop deterministic layer, in process (the fast lane).
 *
 * LDR and docstring inflation read one file. Unused exports and phantom
 * references are whole-tree rules: they run only when the snapshot tree is
 * available, with the patched file substituted into it — a patch that adds an
 * import of a module the repository does not have is exactly the slop a model
 * writes, and it is this runner that catches it.
 */
export function antiSlopRunner(): FileRuleRunner {
  return {
    key: 'anti_slop_fast_lane',
    scannerKeys: [ANTI_SLOP_SCANNER_KEY],
    async run(input: RuleRunInput): Promise<RuleRunOutput> {
      const hits: RuleHit[] = [];
      const base = { scannerKey: ANTI_SLOP_SCANNER_KEY, dimension: 'slop' } as const;
      const self = [{ path: input.file, source: input.source }];

      for (const ldr of ldrFindings(self)) {
        hits.push({
          ...base,
          ruleId: ldr.ruleId,
          file: ldr.file,
          lineStart: 1,
          evidenceQuote: `LDR ${ldr.ratio} < ${LDR_FLOOR} (logic ${ldr.breakdown.logic}, overhead ${ldr.breakdown.overhead})`,
          title: `Low logic density: ${ldr.file}`,
        });
      }
      for (const inflation of docstringInflation(input.file, input.source)) {
        hits.push({
          ...base,
          ruleId: inflation.ruleId,
          file: inflation.file,
          lineStart: 1,
          evidenceQuote: `${inflation.docLines} doc lines over ${inflation.implLines} implementation lines`,
          title: `Docstring inflation: ${inflation.symbol}`,
        });
      }

      if (input.tree) {
        for (const unused of unusedExports(input.tree)) {
          if (unused.file !== input.file) continue;
          hits.push({
            ...base,
            ruleId: unused.ruleId,
            file: unused.file,
            lineStart: unused.line,
            evidenceQuote: unused.declaration,
            title: `Unused export: ${unused.name}`,
          });
        }
        for (const ref of phantomRefs(input.tree, { complete: input.treeComplete })) {
          if (ref.file !== input.file) continue;
          hits.push({
            ...base,
            ruleId: ref.ruleId,
            file: ref.file,
            lineStart: ref.line,
            evidenceQuote: ref.statement,
            title:
              ref.name === null
                ? `Import of a missing module: ${ref.specifier}`
                : `Import of a name that does not exist: ${ref.name} from ${ref.specifier}`,
          });
        }
      }

      return {
        status: 'succeeded',
        hits,
        ...(input.tree ? {} : { reason: 'no snapshot tree: whole-tree rules not run' }),
      };
    },
  };
}

/** Every rule set a patched file is re-checked against, in production. */
export function productionRunners(opts: { image?: string } = {}): FileRuleRunner[] {
  return [
    packRunner(
      {
        key: 'semgrep_pack',
        scannerKey: SEMGREP_SCANNER_KEY,
        dimension: 'sast',
        packDir: SEMGREP_RULEPACK_DIR,
      },
      opts.image,
    ),
    packRunner(
      {
        key: 'logging_pack',
        scannerKey: LOGGING_SCANNER_KEY,
        dimension: 'logging',
        packDir: CODE_HEALTH_PACK_DIR,
        keep: (id) => id.startsWith('bpm-log-'),
        excludedGlobs: DEFAULT_EXCLUDED_GLOBS,
      },
      opts.image,
    ),
    packRunner(
      {
        key: 'perf_pack',
        scannerKey: PERF_SCANNER_KEY,
        dimension: 'performance',
        packDir: PERF_PACK_DIR,
        keep: (id) => id.startsWith('bpm-perf-'),
        excludedGlobs: DEFAULT_EXCLUDED_GLOBS,
      },
      opts.image,
    ),
    // The anti-slop PATTERN rules (bpm-ch-*), 2026-10-28. A model helps judge
    // which of these candidates to raise, but the pattern itself is an
    // Opengrep rule: the patched file is re-scanned with it exactly as the
    // logging pack's bpm-log-* rules are, and "the pattern no longer matches"
    // is a deterministic verdict, not the model's opinion.
    packRunner(
      {
        key: 'anti_slop_pack',
        scannerKey: ANTI_SLOP_SCANNER_KEY,
        dimension: 'slop',
        packDir: CODE_HEALTH_PACK_DIR,
        keep: (id) => id.startsWith('bpm-ch-'),
        excludedGlobs: DEFAULT_EXCLUDED_GLOBS,
      },
      opts.image,
    ),
    antiSlopRunner(),
  ];
}
