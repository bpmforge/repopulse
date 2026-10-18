import type { Dimension } from '../gateway/types.js';

// Diff chunker (W6-02, ANALYSIS_TIERS.md §2, FR-ANALYSIS-3).
//
// The constraint that shapes everything here: a qwen3.6-class model advertises
// a large context but produces roughly 10k tokens of USABLE output. Feeding it
// a bigger prompt does not fail loudly — it returns a truncated answer that
// looks complete, which is the worst possible failure for a review tool. So
// chunks are sized by PROJECTED OUTPUT, not by what the context window allows.

/** tok(s) ≈ ceil(bytes/3.4) (ANALYSIS_TIERS.md §2). */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.4);
}

/** Projected model output for a patch of this size. */
export function projectedOutputTokens(patchTokens: number): number {
  return Math.min(10_000, Math.round(0.35 * patchTokens + 800));
}

export const PROMPT_BUDGET_TOKENS = 24_000;
export const OUTPUT_BUDGET_TOKENS = 10_000;

export interface DiffFile {
  path: string;
  patch: string | null;
  patchTruncated?: boolean;
  binary?: boolean;
}

export type SkipReason = 'patch_truncated' | 'binary' | 'generated' | 'no_patch';

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface DiffChunk {
  /** Files (or file fragments) reviewed together. */
  paths: string[];
  text: string;
  promptTokens: number;
  projectedOutputTokens: number;
  /** Present when a single file was split — 1-based index of its part. */
  part?: { index: number; of: number };
}

export interface ChunkResult {
  chunks: DiffChunk[];
  skipped: SkippedFile[];
}

// Generated files carry no review signal and would consume the entire budget.
// Recorded as skipped WITH A REASON rather than dropped: coverage honesty means
// a reader can tell "we looked and found nothing" from "we never looked".
const GENERATED = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock)$/,
  /\.min\.(js|css)$/,
  /(^|\/)(dist|build|vendor|node_modules)\//,
  /\.(snap|lock)$/,
  /\.gen\.(ts|js|go)$/,
];

export function isGenerated(path: string): boolean {
  return GENERATED.some((re) => re.test(path));
}

/**
 * Splits a unified patch into hunks.
 *
 * Hunks are the atomic unit: a sub-chunk that starts mid-hunk shows the model
 * changed lines with no surrounding context, which reliably produces confident
 * findings about code that is not there.
 */
export function splitHunks(patch: string): string[] {
  const lines = patch.split('\n');
  const hunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current.length > 0) hunks.push(current.join('\n'));
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
    // Lines before the first @@ are file headers — not part of any hunk.
  }
  if (current.length > 0) hunks.push(current.join('\n'));
  return hunks;
}

/** What one chunk may cost (W19-03). The defaults are the Tier-2 constants above. */
export interface ChunkBudget {
  promptTokens: number;
  outputTokens: number;
}

export const DEFAULT_CHUNK_BUDGET: ChunkBudget = {
  promptTokens: PROMPT_BUDGET_TOKENS,
  outputTokens: OUTPUT_BUDGET_TOKENS,
};

/**
 * Chunk budget for a model whose context window was PROBED (W19-01/W19-03).
 *
 * `null` or unknown keeps the defaults: an unknown window is not a small one,
 * and shrinking every chunk on a guess would waste calls. A known window
 * bounds the chunk so that chunk text + the fixed prompt overhead (checklist,
 * PR context, required JSON — reserved at 3000 tokens) + the projected output
 * all fit inside it, never exceeding the defaults.
 */
export function budgetForContext(contextWindow: number | null | undefined): ChunkBudget {
  if (contextWindow === null || contextWindow === undefined || contextWindow <= 0) {
    return DEFAULT_CHUNK_BUDGET;
  }
  const outputTokens = Math.min(OUTPUT_BUDGET_TOKENS, Math.floor(contextWindow * 0.25));
  const promptTokens = Math.max(
    500,
    Math.min(PROMPT_BUDGET_TOKENS, contextWindow - outputTokens - 3000),
  );
  return { promptTokens, outputTokens };
}

function fits(promptTokens: number, budget: ChunkBudget): boolean {
  return (
    promptTokens <= budget.promptTokens &&
    Math.round(0.35 * promptTokens + 800) <= Math.max(budget.outputTokens, 800)
  );
}

/**
 * A single hunk larger than the budget has no hunk boundary to split at. It is
 * cut at line boundaries, each piece keeping the original `@@` header so a
 * reader (and the evidence check) still sees where it came from. Rare, and
 * degraded on purpose: the alternative is a chunk the model cannot answer.
 */
function splitOversizedHunk(hunk: string, budget: ChunkBudget, headerTokens: number): string[] {
  const lines = hunk.split('\n');
  const head = lines[0] ?? '';
  const out: string[] = [];
  let cur: string[] = [head];
  let tokens = headerTokens + estimateTokens(head);
  for (const line of lines.slice(1)) {
    const t = estimateTokens(line) + 1;
    if (cur.length > 1 && !fits(tokens + t, budget)) {
      out.push(cur.join('\n'));
      cur = [head];
      tokens = headerTokens + estimateTokens(head);
    }
    cur.push(line);
    tokens += t;
  }
  if (cur.length > 1) out.push(cur.join('\n'));
  return out;
}

/**
 * Chunks a PR's files for one dimension.
 *
 * Order of operations matters: skip first (so skipped files never consume
 * budget), then split oversized files at hunk boundaries, then greedy-pack the
 * small remainder. Packing before splitting would pair a small file with a
 * fragment and blur which finding came from where.
 */
export function chunkDiff(
  files: readonly DiffFile[],
  _dimension: Dimension,
  budget: ChunkBudget = DEFAULT_CHUNK_BUDGET,
): ChunkResult {
  const skipped: SkippedFile[] = [];
  const reviewable: { path: string; patch: string }[] = [];

  for (const file of files) {
    if (file.binary) skipped.push({ path: file.path, reason: 'binary' });
    else if (file.patchTruncated) skipped.push({ path: file.path, reason: 'patch_truncated' });
    else if (isGenerated(file.path)) skipped.push({ path: file.path, reason: 'generated' });
    else if (!file.patch || file.patch.trim() === '')
      skipped.push({ path: file.path, reason: 'no_patch' });
    else reviewable.push({ path: file.path, patch: file.patch });
  }

  const chunks: DiffChunk[] = [];
  const packable: { path: string; patch: string; tokens: number }[] = [];

  for (const file of reviewable) {
    const header = `--- ${file.path}\n`;
    const tokens = estimateTokens(header + file.patch);
    if (fits(tokens, budget)) {
      packable.push({ path: file.path, patch: file.patch, tokens });
      continue;
    }

    // Oversized: split at hunk boundaries, never mid-hunk.
    const headerTokens = estimateTokens(header);
    const hunks = splitHunks(file.patch).flatMap((h) =>
      fits(headerTokens + estimateTokens(h), budget)
        ? [h]
        : splitOversizedHunk(h, budget, headerTokens),
    );
    const groups: string[][] = [];
    let group: string[] = [];
    let groupTokens = estimateTokens(header);
    for (const hunk of hunks) {
      const hunkTokens = estimateTokens(hunk);
      if (group.length > 0 && !fits(groupTokens + hunkTokens, budget)) {
        groups.push(group);
        group = [];
        groupTokens = estimateTokens(header);
      }
      group.push(hunk);
      groupTokens += hunkTokens;
    }
    if (group.length > 0) groups.push(group);

    groups.forEach((g, i) => {
      const text = header + g.join('\n');
      const promptTokens = estimateTokens(text);
      chunks.push({
        paths: [file.path],
        text,
        promptTokens,
        projectedOutputTokens: projectedOutputTokens(promptTokens),
        part: { index: i + 1, of: groups.length },
      });
    });
  }

  // Greedy-pack the small files.
  let batch: { path: string; patch: string }[] = [];
  let batchTokens = 0;
  const flush = () => {
    if (batch.length === 0) return;
    const text = batch.map((f) => `--- ${f.path}\n${f.patch}`).join('\n');
    const promptTokens = estimateTokens(text);
    chunks.push({
      paths: batch.map((f) => f.path),
      text,
      promptTokens,
      projectedOutputTokens: projectedOutputTokens(promptTokens),
    });
    batch = [];
    batchTokens = 0;
  };
  for (const file of packable) {
    if (batch.length > 0 && !fits(batchTokens + file.tokens, budget)) flush();
    batch.push({ path: file.path, patch: file.patch });
    batchTokens += file.tokens;
  }
  flush();

  return { chunks, skipped };
}
