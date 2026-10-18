import { isGenerated, type DiffFile } from '../chunker/index.js';
import { SPECIALISTS, type Specialist, type SpecialistId } from './registry.js';

// The conditional-wave planner (W19-03).
//
// attest's pattern, kept: a specialist runs only if its trigger is present.
// "Present" is decided from the change itself — what kinds of files it touches
// and, for performance, whether the code has anything performance can say about
// — never from a model call. Every specialist that does NOT run is reported
// with the reason, because a quiet skip reads as "reviewed and clean".

export type FileKind = 'source' | 'test' | 'docs' | 'config' | 'generated' | 'other';

const SOURCE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|swift|rb|php|cs|c|h|cc|cpp|hpp|scala|sh|bash|sql|vue|svelte)$/i;
const CONFIG_EXT = /\.(ya?ml|json|toml|tf|tfvars|hcl|ini|cfg|conf|properties)$/i;
const CONFIG_NAME = /(^|\/)(Dockerfile|Makefile|\.env[^/]*|docker-compose[^/]*)$/i;
const DOC_EXT = /\.(md|mdx|rst|txt|adoc)$/i;
const TEST_PATH = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$/i;

export function classifyPath(path: string): FileKind {
  if (isGenerated(path)) return 'generated';
  if (DOC_EXT.test(path)) return 'docs';
  if (TEST_PATH.test(path) && SOURCE_EXT.test(path)) return 'test';
  if (SOURCE_EXT.test(path)) return 'source';
  if (CONFIG_EXT.test(path) || CONFIG_NAME.test(path)) return 'config';
  return 'other';
}

// Things the performance checklist can actually speak to. A change with none of
// these has nothing for it to review, and a model asked anyway will invent.
const PERF_SIGNAL =
  /\b(for|while)\s*\(|\.(map|filter|reduce|forEach|flatMap)\(|\bawait\b|\bPromise\.|\bselect\b[\s\S]{0,40}\bfrom\b|\.query\(|\.find(Many|All)?\(|readFileSync|execSync|\bJOIN\b|\bSELECT\b|\bfor\s+\w+\s+in\b|\bgo\s+func\b|\.stream\(\)/i;

export interface PlanFile {
  path: string;
  /** The patch, or the content for file/module mode. */
  text?: string | null;
}

export interface PlannedSpecialist {
  specialist: Specialist;
  reason: string;
}

export interface Plan {
  /** Waves in run order; each holds the specialists that apply. Empty waves are dropped. */
  waves: { wave: number; specialists: PlannedSpecialist[] }[];
  /** Everything that will NOT run, with why. */
  skipped: { id: SpecialistId; reason: string }[];
  counts: Record<FileKind, number>;
}

export interface PlanOptions {
  /** Restrict to these specialists (still subject to relevance unless `force`). */
  only?: readonly SpecialistId[];
  /**
   * Run the `only` specialists whether or not the change looks relevant to
   * them (W19-05). For evaluating a specialist's judgement, which must not be
   * confounded with the planner's decision — the planner has its own tests.
   */
  force?: boolean;
}

export function planWaves(files: readonly PlanFile[], options: PlanOptions = {}): Plan {
  const counts: Record<FileKind, number> = {
    source: 0,
    test: 0,
    docs: 0,
    config: 0,
    generated: 0,
    other: 0,
  };
  let perfSignal = false;
  for (const f of files) {
    const kind = classifyPath(f.path);
    counts[kind] += 1;
    if (kind === 'source' && f.text && PERF_SIGNAL.test(f.text)) perfSignal = true;
  }

  const relevance = (id: SpecialistId): string | null => {
    const code = counts.source;
    switch (id) {
      case 'security':
        // Config and infrastructure files carry security-relevant mistakes
        // (open ports, wildcard IAM, credentials) that source-only logic misses.
        return counts.source + counts.config > 0 ? 'source or configuration files changed' : null;
      case 'performance':
        return code > 0 && perfSignal ? 'source with loops, queries or async calls changed' : null;
      case 'code_health':
        return code > 0 ? 'source files changed' : null;
      case 'test_coverage':
        return code > 0 ? 'source files changed that tests may need to cover' : null;
      case 'best_practices':
        return code > 0 ? 'source files changed' : null;
      case 'ai_slop':
        return code + counts.test > 0 ? 'source or test files changed' : null;
    }
  };

  const unmet = (id: SpecialistId): string => {
    if (files.length === 0) return 'nothing to review';
    if (counts.source + counts.test + counts.config === 0) {
      return `only ${describeKinds(counts)} changed — nothing for this specialist to review`;
    }
    if (id === 'performance') return 'no loops, queries or async calls in the changed source';
    if (id === 'security') return 'only test files changed';
    return 'no source files changed';
  };

  const byWave = new Map<number, PlannedSpecialist[]>();
  const skipped: Plan['skipped'] = [];
  for (const specialist of SPECIALISTS) {
    if (options.only && !options.only.includes(specialist.id)) {
      skipped.push({ id: specialist.id, reason: 'not requested' });
      continue;
    }
    const reason = options.force ? 'forced' : relevance(specialist.id);
    if (reason === null) {
      skipped.push({ id: specialist.id, reason: unmet(specialist.id) });
      continue;
    }
    const list = byWave.get(specialist.wave) ?? [];
    list.push({ specialist, reason });
    byWave.set(specialist.wave, list);
  }

  const waves = [...byWave.entries()]
    .sort(([a], [b]) => a - b)
    .map(([wave, specialists]) => ({ wave, specialists }));
  return { waves, skipped, counts };
}

function describeKinds(c: Record<FileKind, number>): string {
  const parts = (['docs', 'generated', 'other'] as const)
    .filter((k) => c[k] > 0)
    .map((k) => `${k} files`);
  return parts.length > 0 ? parts.join(' and ') : 'no reviewable files';
}

/** Convenience for diff input: the planner wants the patch text for content triggers. */
export function planFromDiff(files: readonly DiffFile[], options?: PlanOptions): Plan {
  return planWaves(
    files.map((f) => ({ path: f.path, text: f.patch })),
    options,
  );
}
