import path from 'node:path';
import { CORPUS_DIR, loadCorpus, treeFiles, type Suite } from './corpus.js';
import {
  fastLaneRules,
  findYamlTool,
  runFastLane,
  runYamlPacks,
  yamlPacks,
  type AdapterRun,
  type YamlTool,
} from './engines.js';
import { matchFindings, type BenchFinding } from './match.js';
import { buildReport, type BenchmarkReport, type EngineSummary, type RuleInfo } from './report.js';

export interface BenchmarkOptions {
  corpusDir?: string;
  /** false = fast lane only. */
  yaml?: boolean;
  /** Engine binary to use instead of searching PATH for opengrep, then semgrep. */
  yamlBin?: string;
  /** Recorded in the report so a published number says when it was taken. */
  measured?: { date: string | null; commit: string | null };
  /**
   * The tool adapters' findings, already run (they need the scan image, so the
   * caller runs them: engines.ts runAdapterLane). Absent = the lane did not run
   * and its labels are skipped, not missed.
   */
  adapters?: AdapterRun;
  /** Why the adapter lane did not run, for the report. */
  adaptersReason?: string;
}

/**
 * A label pointing at a file that is not there, or past its last line, is a
 * broken answer key, and a broken key scores as a miss. Refuse to score with
 * one rather than publish a recall number it quietly lowered.
 */
export function validateLabels(suites: readonly Suite[]): void {
  for (const suite of suites) {
    if (!suite.prepared) continue;
    const dot = suite.manifest.lane === 'adapters';
    const files = new Map(suite.trees.map((t) => [t.id, new Set(treeFiles(t.dir, dot))]));
    for (const l of suite.labels) {
      if (!files.get(l.tree)?.has(l.file)) {
        throw new Error(
          `${suite.manifest.id}: label ${l.id} names missing file ${l.tree}/${l.file}`,
        );
      }
    }
  }
}

export function runBenchmark(opts: BenchmarkOptions = {}): BenchmarkReport {
  const suites = loadCorpus(opts.corpusDir ?? CORPUS_DIR);
  validateLabels(suites);
  const scored = suites.filter((s) => s.prepared);
  // A suite is read by one lane. The adapters' fixtures are read by the adapters
  // alone: the YAML packs and the fast lane would report on them too, and every
  // such finding would score as an unlabelled false positive of a rule the suite
  // was never written for.
  const trees = scored.filter((s) => s.manifest.lane !== 'adapters').flatMap((s) => s.trees);

  const fast = fastLaneRules();
  const rules: RuleInfo[] = [...fast].map(([rule, dimension]) => ({
    rule,
    engine: 'fast-lane',
    dimension,
  }));
  const findings: BenchFinding[] = trees.flatMap((t) => runFastLane(t));

  const tool: YamlTool | null = opts.yaml === false ? null : findYamlTool(opts.yamlBin);
  let yaml: EngineSummary['yaml'];
  let unparsed: { files: Set<string>; rules: Set<string> } | undefined;
  if (tool) {
    const packs = yamlPacks();
    const result = runYamlPacks(tool, trees, packs);
    findings.push(...result.findings);
    for (const [rule, dimension] of packs.rules) rules.push({ rule, engine: 'yaml', dimension });
    unparsed = { files: new Set(result.errors), rules: new Set(packs.rules.keys()) };
    yaml = {
      status: 'ran',
      tool: tool.name,
      version: tool.version,
      packs: packs.files.map((f) => path.relative(path.resolve(CORPUS_DIR, '../..'), f)).sort(),
      rules: packs.rules.size,
      parseErrors: result.errors,
    };
  } else {
    yaml = {
      status: 'unavailable',
      reason:
        opts.yaml === false ? 'disabled by --no-yaml' : 'neither opengrep nor semgrep is on PATH',
    };
  }

  // The adapter lane's rules: the ones its labels name and the ones it raised.
  // Their universe is the tools' own, not a file this repository owns, so a
  // rule is "known" because a label or a finding says it exists; a label that
  // names something else is a typo and refused.
  const adapterRuleDims = new Map<string, string>();
  for (const suite of scored.filter((x) => x.manifest.lane === 'adapters')) {
    for (const l of suite.labels) {
      for (const r of [l.rule, ...(l.accept ?? [])]) {
        if (r === undefined) continue;
        if (!r.startsWith('tool.')) {
          throw new Error(`${suite.manifest.id}: label ${l.id} names ${r}, not a tool.* rule`);
        }
        if (!adapterRuleDims.has(r)) adapterRuleDims.set(r, l.dimension);
      }
    }
  }
  if (opts.adapters) {
    for (const f of opts.adapters.findings) {
      if (!adapterRuleDims.has(f.ruleId)) adapterRuleDims.set(f.ruleId, f.dimension);
    }
    findings.push(...opts.adapters.findings);
    for (const [rule, dimension] of adapterRuleDims) {
      rules.push({ rule, engine: 'adapter', dimension });
    }
  }

  const known = new Set([...fast.keys(), ...yamlPacks().rules.keys(), ...adapterRuleDims.keys()]);
  for (const suite of suites) {
    for (const l of suite.labels) {
      for (const r of [l.rule, ...(l.accept ?? [])]) {
        // A typo in a rule id would otherwise read as "rule did not run" and
        // the label would be skipped forever without anyone noticing.
        if (r !== undefined && !known.has(r)) {
          throw new Error(`${suite.manifest.id}: label ${l.id} names unknown rule ${r}`);
        }
      }
    }
  }

  const rulesRun = new Set(rules.map((r) => r.rule));
  const outcomes = matchFindings({
    findings,
    labels: scored.flatMap((s) => s.labels),
    rulesRun,
    dimensionsRun: new Set(rules.map((r) => r.dimension)),
    policy: (id) => suites.find((s) => s.manifest.id === id)?.policy ?? 'fp',
    ...(unparsed ? { unparsed } : {}),
  });

  return buildReport({
    engines: {
      fastLane: { rules: fast.size },
      yaml,
      adapters: opts.adapters
        ? { status: 'ran', tools: opts.adapters.tools, trees: opts.adapters.trees }
        : { status: 'unavailable', reason: opts.adaptersReason ?? 'not requested' },
    },
    corpus: suites.map((s) => ({
      id: s.manifest.id,
      title: s.manifest.title,
      source: {
        kind: s.manifest.source.kind,
        repository: s.manifest.source.repository,
        commit: s.manifest.fetch?.commit ?? s.manifest.source.commit,
        path: s.manifest.source.path,
        licence: s.manifest.source.licence,
      },
      status: s.prepared ? 'scored' : 'not-prepared',
      trees: s.trees.length,
      labels: s.labels.length,
    })),
    rules: rules.sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)),
    outcomes,
    ...(opts.measured ? { measured: opts.measured } : {}),
  });
}
