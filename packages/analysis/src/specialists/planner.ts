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

/**
 * W27-07: which specialists a file is for. Each AI area reads only its own kind
 * of code: configuration goes to security alone, performance reads source
 * with loops, queries or async calls, and docs, generated and other files go
 * to none. planWaves decides WHETHER a specialist runs from the same rules, so
 * a specialist that runs always has at least one file of its own.
 */
export function fileAreas(path: string, text?: string | null): Set<SpecialistId> {
  const kind = classifyPath(path);
  const areas = new Set<SpecialistId>();
  if (kind === 'source') {
    if (!text || SECURITY_SIGNAL.test(text)) areas.add('security');
    areas.add('code_health');
    areas.add('test_coverage');
    areas.add('best_practices');
    areas.add('ai_slop');
    if (text && PERF_SIGNAL.test(text)) areas.add('performance');
  } else if (kind === 'config') {
    areas.add('security');
  } else if (kind === 'test') {
    areas.add('ai_slop');
  }
  return areas;
}

// W27-07: what the security checklist can speak to in source: input, auth,
// secrets, crypto, queries, shell, files, network, rendering, deserialising.
// Broad on purpose (a handler almost always matches); a file with none of it
// (pure math, formatting, types) gives security nothing to read.
const SECURITY_SIGNAL =
  /\b(req|request|params|query|body|headers?|cookies?|session|token|passw(or)?d|secret|api_?key|auth\w*|login|jwt|oauth|crypto|cipher|hash\w*|encrypt|decrypt|hmac|random|exec\w*|spawn|eval|system|shell|subprocess|popen|sql|select|insert|update|delete|readFile\w*|writeFile\w*|unlink|open|fs|path|fetch|http\w*|url|redirect|upload|socket|deserializ\w*|unmarshal|pickle|yaml|innerHTML|dangerouslySetInnerHTML|template|render|permission|role|admin|acl|cors|csrf|tls|ssl|cert\w*)\b/i;

/**
 * W27-08: whether a slice of code has anything for performance or security to
 * read (the same signals fileAreas uses per file). Other areas have no signal.
 */
export function sliceHasSignal(id: 'performance' | 'security', text: string): boolean {
  return id === 'performance' ? PERF_SIGNAL.test(text) : SECURITY_SIGNAL.test(text);
}

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
  let securityFiles = 0;
  for (const f of files) {
    const kind = classifyPath(f.path);
    counts[kind] += 1;
    if (kind === 'source' && f.text && PERF_SIGNAL.test(f.text)) perfSignal = true;
    // W27-07: the same per-file rule the runner uses, so a planned security
    // review always has a file of its own.
    if (fileAreas(f.path, f.text).has('security')) securityFiles += 1;
  }

  const relevance = (id: SpecialistId): string | null => {
    const code = counts.source;
    switch (id) {
      case 'security':
        // Config and infrastructure files carry security-relevant mistakes
        // (open ports, wildcard IAM, credentials) that source-only logic misses.
        return securityFiles > 0 ? 'source or configuration files changed' : null;
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
    if (id === 'security') {
      return counts.source + counts.config > 0
        ? 'no input, auth, secrets, crypto, query, shell, file or network handling in the changed code'
        : 'only test files changed';
    }
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
