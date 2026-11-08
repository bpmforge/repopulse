import { estimateTokens, type ChunkBudget, type DiffChunk } from '../chunker/index.js';
import { loadChecklist } from '../chunker/prompt.js';
import type { Dimension } from '../gateway/types.js';
import type { Specialist } from './registry.js';

// W27-05: one combined review per chunk (the first look).
//
// The roster sends every chunk to every planned specialist: six calls that each
// re-read the same files. Measured on gin's first look, that was 3h54 for two
// of six specialists. A first look wants the first useful result in minutes,
// so it sends each chunk ONCE with every planned checklist, and each finding
// names the checklist it came from.
//
// ORDER: the code first, the instructions last. The Mac A/B (2026-11-06) put
// the files ahead of the checklist and got 88-93% of the next prompt from the
// local server's prefix cache, and more findings with the instructions last.
// One call per chunk has no next specialist to share a prefix with, but the
// corrective retry does: it appends to the end and reuses the whole prompt.

/** Recorded on the pass so a finding can be traced to the prompt that raised it. */
export const COMBINED_PROMPT_VERSION = 'combined.v1';

/**
 * Tokens the chunker already reserves for one checklist + PR context + the
 * required JSON (budgetForContext reserves 3000 in total). The combined
 * prompt's extra checklists come out of the chunk's share instead, so the
 * prompt still fits the model's window.
 */
const RESERVED_OVERHEAD_TOKENS = 2_000;

export function combinedChecklists(specialists: readonly Specialist[]): string {
  return specialists
    .map(
      (s) =>
        `## Checklist: ${s.dimension}\n\n${loadChecklist(s.dimension, s.checklistVersion).trim()}`,
    )
    .join('\n\n');
}

/** The chunk budget shrunk by what the extra checklists cost. */
/**
 * W27-09: the code one combined call reads. Measured on gin (103e6c3, local
 * 27B with reasoning): ~18-23k tokens of code with six checklists took 27 s
 * to read and then reasoned past the 1,200 s timeout on all three calls, so
 * nothing came back. A combined call reads at most this much code; the
 * reasoning it provokes grows with what it is asked to review.
 */
export const COMBINED_CHUNK_TOKENS = 8_000;

/**
 * W27-11: the code one QUICK combined call (reasoning none) reads. Measured on
 * gin (1e3b74c): quick calls of 5-12k tokens answered in 14-31 s, but at 8k a
 * chunk the first look's 15 files needed more calls than the budget held and
 * 9 of 11 files were left unread. Without reasoning the cost is the prefill,
 * so a quick call reads up to this much.
 */
export const COMBINED_QUICK_CHUNK_TOKENS = 20_000;

export function combinedBudget(
  budget: ChunkBudget,
  specialists: readonly Specialist[],
  chunkTokens: number = COMBINED_CHUNK_TOKENS,
): ChunkBudget {
  const extra = Math.max(
    0,
    estimateTokens(combinedChecklists(specialists)) - RESERVED_OVERHEAD_TOKENS,
  );
  return {
    ...budget,
    promptTokens: Math.max(500, Math.min(chunkTokens, budget.promptTokens - extra)),
  };
}

const requiredJson = (dimensions: readonly Dimension[]) => {
  const list = dimensions.map((d) => `"${d}"`).join(' | ');
  return `Respond ONLY with JSON of this exact shape, and nothing else:

{"findings":[{"dimension":${list},"severity":1-5,"confidence":1-5,
"file":"<path>","line_range":[start,end],"title":"<=120 chars",
"evidence_quote":"verbatim text copied from the diff you are given",
"rationale":"<=800 chars","suggested_fix":"<=800 chars or null"}]}

"dimension" is the checklist the finding comes from, exactly as written in its
heading. If you find nothing, respond with {"findings":[]}. Never invent an
evidence_quote: it is checked against the diff and a finding whose quote is not
present is discarded.`;
};

export function buildCombinedPrompt(params: {
  specialists: readonly Specialist[];
  chunk: DiffChunk;
  title: string;
  /**
   * W27-07: for a checklist that covers only some of the chunk's files, those
   * files. A checklist absent from the map covers every file in the chunk.
   */
  scope?: ReadonlyMap<Dimension, readonly string[]>;
}): { text: string; tokens: number } {
  const dims = params.specialists.map((s) => s.dimension);
  const scoped = params.specialists
    .map((s) => [s.dimension, params.scope?.get(s.dimension)] as const)
    .filter((e): e is readonly [Dimension, readonly string[]] => e[1] !== undefined);
  const scopeLines =
    scoped.length > 0
      ? [
          'Apply each checklist only to the files it covers:',
          ...scoped.map(([d, paths]) => `- ${d}: only ${paths.join(', ')}`),
          '- every other checklist: all files in this chunk',
          '',
        ]
      : [];
  const text = [
    'You are reviewing source code from one repository. The code comes first;',
    'the checklists and the answer format follow it.',
    '',
    `Context: ${params.title}`,
    `Files in this chunk: ${params.chunk.paths.join(', ')}`,
    params.chunk.part ? `(part ${params.chunk.part.index} of ${params.chunk.part.of})` : '',
    '',
    '```diff',
    params.chunk.text,
    '```',
    '',
    `Review the code above against EACH of the ${dims.length} checklists below. Report only`,
    'real problems you can quote from the code; an empty list is a good answer.',
    '',
    ...scopeLines,
    combinedChecklists(params.specialists),
    '',
    requiredJson(dims),
  ].join('\n');
  return { text, tokens: estimateTokens(text) };
}

const ALIASES: Record<string, Dimension> = {
  slop: 'ai_slop',
  anti_slop: 'ai_slop',
  test: 'test_coverage',
  tests: 'test_coverage',
  testing: 'test_coverage',
  best_practice: 'best_practices',
  health: 'code_health',
  maintainability: 'code_health',
  perf: 'performance',
};

/**
 * Keeps the findings whose dimension is one of the checklists asked, with the
 * spelling normalised ("Code health" -> code_health). Any other dimension is
 * dropped and named, never relabelled: the checklist decides what a finding
 * is, and guessing one for it would file it under a review that never ran.
 */
export function splitByDimension(
  raw: unknown,
  asked: readonly Dimension[],
): { raw: unknown; dropped: string[] } {
  const findings = (raw as { findings?: unknown })?.findings;
  if (!Array.isArray(findings)) return { raw, dropped: [] };
  const allowed = new Set<string>(asked);
  const kept: unknown[] = [];
  const dropped: string[] = [];
  for (const f of findings) {
    if (!f || typeof f !== 'object') {
      kept.push(f);
      continue;
    }
    const given = String((f as { dimension?: unknown }).dimension ?? '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    const dim = allowed.has(given) ? given : ALIASES[given];
    if (dim && allowed.has(dim)) kept.push({ ...f, dimension: dim });
    else dropped.push(given || '(none)');
  }
  return { raw: { ...(raw as object), findings: kept }, dropped };
}
