import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Dimension } from '../gateway/types.js';
import { estimateTokens, type DiffChunk } from './index.js';

// Prompt assembly (W6-02, ANALYSIS_TIERS.md §2/§4).
//
// Checklists are versioned FILES, not string literals, for the same reason the
// metric catalog is a file: the version travels with every finding, so a
// finding raised under v1 can still be explained after v2 ships.

export const CHECKLIST_VERSION = 'v1';

const CHECKLIST_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../checklists');

const cache = new Map<string, string>();

export function loadChecklist(dimension: Dimension, version = CHECKLIST_VERSION): string {
  const key = `${dimension}.${version}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(CHECKLIST_DIR, `${dimension}.${version}.md`), 'utf8');
  cache.set(key, text);
  return text;
}

/** PR context, truncated to ~1k tokens (§2 step 4). */
export function prContext(title: string, body: string | null): string {
  const header = `PR: ${title}\n`;
  if (!body) return header;
  // ~1k tokens ≈ 3400 bytes by the §2 estimator. Truncated rather than dropped:
  // the description often carries the intent a reviewer needs, and sending all
  // of a 40kB description would crowd out the diff it describes.
  const budgetBytes = 3400;
  const trimmed =
    Buffer.byteLength(body, 'utf8') <= budgetBytes
      ? body
      : `${body.slice(0, budgetBytes)}\n[description truncated]`;
  return `${header}\n${trimmed}\n`;
}

const REQUIRED_JSON = `Respond ONLY with JSON of this exact shape, and nothing else:

{"findings":[{"dimension":"<dimension>","severity":1-5,"confidence":1-5,
"file":"<path>","line_range":[start,end],"title":"<=120 chars",
"evidence_quote":"verbatim text copied from the diff above",
"rationale":"<=800 chars","suggested_fix":"<=800 chars or null"}]}

If you find nothing, respond with {"findings":[]}. Never invent an
evidence_quote: it is checked against the diff and a finding whose quote is not
present is discarded.`;

export interface BuiltPrompt {
  text: string;
  tokens: number;
  checklistVersion: string;
}

/** System framing + checklist + required JSON + the chunk (§4). */
export function buildChunkPrompt(params: {
  dimension: Dimension;
  chunk: DiffChunk;
  prTitle: string;
  prBody: string | null;
  version?: string;
}): BuiltPrompt {
  const version = params.version ?? CHECKLIST_VERSION;
  const text = [
    loadChecklist(params.dimension, version),
    '',
    prContext(params.prTitle, params.prBody),
    '',
    `Files in this chunk: ${params.chunk.paths.join(', ')}`,
    params.chunk.part ? `(part ${params.chunk.part.index} of ${params.chunk.part.of})` : '',
    '',
    '```diff',
    params.chunk.text,
    '```',
    '',
    REQUIRED_JSON,
  ].join('\n');

  return { text, tokens: estimateTokens(text), checklistVersion: version };
}

/**
 * The reduce step (§2 step 5).
 *
 * Its input is the FINDINGS JSON, never the diff again. That is what keeps the
 * final call bounded regardless of PR size: a 5000-line PR and a 50-line one
 * produce reduce prompts of similar length, so the summary cannot be the call
 * that blows the budget.
 */
export function buildReducePrompt(params: {
  dimension: Dimension;
  findings: unknown[];
  prTitle: string;
  skipped: { path: string; reason: string }[];
}): BuiltPrompt {
  const text = [
    'You are summarising the findings of a diff-scoped review. You are given the',
    'findings themselves, not the diff. Do not invent findings that are not listed.',
    '',
    `PR: ${params.prTitle}`,
    `Dimension: ${params.dimension}`,
    '',
    'Findings JSON:',
    JSON.stringify(params.findings),
    '',
    params.skipped.length > 0
      ? `Files not reviewed (${params.skipped.length}): ${params.skipped
          .map((s) => `${s.path} (${s.reason})`)
          .join(', ')}. Mention this coverage gap in the verdict.`
      : 'Every changed file was reviewed.',
    '',
    'Respond ONLY with JSON: {"verdict":"<one paragraph>","top_risks":["…"]}',
  ].join('\n');

  return { text, tokens: estimateTokens(text), checklistVersion: CHECKLIST_VERSION };
}
