import { estimateTokens, PROMPT_BUDGET_TOKENS, type DiffChunk } from '@repopulse/analysis';
import type { ImportGraphSnapshot } from '@repopulse/insights';

// Repo-wide context for a Tier-2 chunk (W18-25, mechanical-checks plan tier 3).
//
// A diff shows a model the function that changed and nothing about who calls
// it or what it calls. That is the half of a review a human gets by clicking
// through, and without it the model either guesses ("this may break callers")
// or says nothing. The fast-lane import graph already knows both, so each
// chunk carries a few lines of it.
//
// THE CONTEXT IS NOT THE DIFF. It goes into the prompt beside the fence, never
// into chunk.text, because chunk.text is what validateFindings checks evidence
// quotes against: a model quoting a caller's path back as evidence must still
// be rejected.
//
// THE BUDGET IS THE CHUNKER'S. chunkDiff sized the chunk against
// PROMPT_BUDGET_TOKENS; the context gets what that left over, capped at
// REPO_CONTEXT_MAX_TOKENS so a small chunk does not grow a large preamble.

export const REPO_CONTEXT_MAX_TOKENS = 1_200;
/** Callers listed per function before "+N more". */
const MAX_CALLERS = 6;
/** Callees listed per file. */
const MAX_CALLEES = 12;

const IDENT = /^[A-Za-z_$][\w$]*$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|tests?|e2e)\//;
const isTest = (path: string): boolean => TEST_FILE.test(path);
/**
 * Paths go into a prompt, and a path is attacker-controlled text. Anything
 * outside this alphabet is left out rather than escaped: no real source path
 * needs a backtick or a newline.
 */
const SAFE_PATH = /^[\w@.+\-/ ]+$/;

const NOT_A_NAME = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'constructor',
  'super',
  'await',
  'typeof',
  'new',
]);

const DECLARATIONS = [
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/g,
  // Class and object methods: `name(args) {` at the start of a line.
  /^\s*(?:(?:public|private|protected|static|async|override|readonly)\s+)*\*?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{/gm,
];

/** Function names declared in a piece of code. */
export function declaredFunctions(text: string): string[] {
  const out = new Set<string>();
  for (const re of DECLARATIONS) {
    for (const m of text.matchAll(re)) {
      const name = m[1] as string;
      if (!NOT_A_NAME.has(name)) out.add(name);
    }
  }
  return [...out];
}

interface FileSection {
  path: string;
  /** Changed (+/-) lines and hunk-header function context, for declarations. */
  changed: string;
  /** Added and context lines: the code as it will be, for callee names. */
  after: string;
}

/**
 * Splits a chunk's text back into its files. A header counts only when it
 * names one of the chunk's own paths: a removed SQL line `-- x` reads as
 * `--- x` once its diff marker is added.
 */
function sections(chunk: Pick<DiffChunk, 'text' | 'paths'>): FileSection[] {
  const paths = new Set(chunk.paths);
  const out: FileSection[] = [];
  let current: FileSection | null = null;
  for (const line of chunk.text.split('\n')) {
    const header = /^--- (.+)$/.exec(line);
    if (header && paths.has(header[1] as string)) {
      current = { path: header[1] as string, changed: '', after: '' };
      out.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@')) {
      // git puts the enclosing function after the second @@ — a change in
      // the middle of a body still names the function it is in.
      current.changed += `${line.replace(/^@@[^@]*@@/, '')}\n`;
    } else if (line.startsWith('+') || line.startsWith('-')) {
      current.changed += `${line.slice(1)}\n`;
      if (line.startsWith('+')) current.after += `${line.slice(1)}\n`;
    } else {
      current.after += `${line.slice(1)}\n`;
    }
  }
  return out;
}

export interface RepoContext {
  /** Empty when there is nothing to say or no room to say it. */
  text: string;
  tokens: number;
  /** Changed functions the context covers. */
  functions: number;
}

const NONE: RepoContext = { text: '', tokens: 0, functions: 0 };

/** Callers and callees of a chunk's changed functions, within the chunk budget. */
export function repoContextFor(
  graph: ImportGraphSnapshot | null,
  chunk: Pick<DiffChunk, 'text' | 'promptTokens' | 'paths'>,
  maxTokens = REPO_CONTEXT_MAX_TOKENS,
): RepoContext {
  if (!graph) return NONE;
  const budget = Math.min(maxTokens, PROMPT_BUDGET_TOKENS - chunk.promptTokens);
  if (budget <= 0) return NONE;

  const position = new Map(graph.files.map((f, i) => [f, i]));
  const header = [
    `Repository context from the import graph at ${graph.commitSha.slice(0, 7)}.`,
    graph.complete
      ? 'Callers are files that import the function; callees are repository imports the changed code uses.'
      : 'The import graph is INCOMPLETE (snapshot capped): these lists may be missing entries.',
  ];
  const blocks: { test: boolean; lines: string[] }[] = [];
  let functions = 0;

  for (const section of sections(chunk)) {
    const self = position.get(section.path);
    if (self === undefined || !SAFE_PATH.test(section.path)) continue;
    const lines: string[] = [];

    const importers = graph.edges.filter(([, to]) => to === self);
    // A file nothing imports gets its one header line, not a "no other file
    // imports it" per local helper: in a test file that is a dozen lines
    // saying the same thing, spent from the same budget as real callers.
    const changed = importers.length
      ? declaredFunctions(section.changed).filter((n) => IDENT.test(n))
      : [];
    for (const name of changed) {
      const callers = importers
        .filter(([, , names]) => names === null || names.includes(name))
        .map(([from]) => graph.files[from] as string)
        .filter((p) => SAFE_PATH.test(p))
        // Shipped callers first: a test calling a function says less about
        // what a change can break than the code that runs it.
        .sort((a, b) => Number(isTest(a)) - Number(isTest(b)));
      functions += 1;
      if (callers.length === 0) {
        lines.push(`  ${name}: no other file in the repository imports it`);
      } else {
        const shown = callers.slice(0, MAX_CALLERS).join(', ');
        const more = callers.length > MAX_CALLERS ? ` (+${callers.length - MAX_CALLERS} more)` : '';
        lines.push(`  ${name}: called from ${shown}${more}`);
      }
    }

    // Callees: names this file imports from repository modules that the code
    // as changed actually mentions. A namespace import is skipped — what is
    // read off it is not something the graph recorded.
    const mentioned = new Set(section.after.match(/[A-Za-z_$][\w$]*/g) ?? []);
    const callees: string[] = [];
    for (const [from, to, names] of graph.edges) {
      if (from !== self || names === null) continue;
      const target = graph.files[to] as string;
      if (!SAFE_PATH.test(target)) continue;
      for (const name of names) {
        if (name !== 'default' && IDENT.test(name) && mentioned.has(name)) {
          callees.push(`${name} (${target})`);
        }
      }
    }
    if (callees.length > 0) {
      const more = callees.length > MAX_CALLEES ? ` (+${callees.length - MAX_CALLEES} more)` : '';
      lines.push(`  uses: ${callees.slice(0, MAX_CALLEES).join(', ')}${more}`);
    }

    if (lines.length > 0) {
      blocks.push({
        test: isTest(section.path),
        lines: [
          `${section.path} (imported by ${new Set(importers.map(([f]) => f)).size} files)`,
          ...lines,
        ],
      });
    }
  }
  if (blocks.length === 0) return NONE;
  // Shipped files before tests, so a tight budget is spent on them.
  blocks.sort((a, b) => Number(a.test) - Number(b.test));

  // Whole lines only, in order, until the budget is spent: a list cut
  // mid-path would hand the model a path that does not exist.
  const kept = [...header];
  let truncated = false;
  for (const line of blocks.flatMap((b) => b.lines)) {
    if (estimateTokens([...kept, line, '[context truncated]'].join('\n')) > budget) {
      truncated = true;
      break;
    }
    kept.push(line);
  }
  if (kept.length === header.length) return NONE;
  if (truncated) kept.push('[context truncated]');
  const text = kept.join('\n');
  return { text, tokens: estimateTokens(text), functions };
}

/**
 * Callers and callees for a batch of judged candidates (the anti-slop.v2
 * prompt). A candidate is an excerpt, not a diff, so each file's excerpts are
 * laid out as the added lines of one section: every function declared in an
 * excerpt then gets its callers listed. `promptTokens` is what the batch's
 * own prompt already costs.
 */
export function repoContextForCandidates(
  graph: ImportGraphSnapshot | null,
  candidates: readonly { file: string; excerpt: { text: string } }[],
  promptTokens: number,
  maxTokens = REPO_CONTEXT_MAX_TOKENS,
): RepoContext {
  const byFile = new Map<string, string[]>();
  for (const c of candidates) {
    const lines = byFile.get(c.file) ?? [];
    for (const line of c.excerpt.text.split('\n')) lines.push(`+${line}`);
    byFile.set(c.file, lines);
  }
  const paths = [...byFile.keys()];
  const text = paths.map((path) => `--- ${path}\n${byFile.get(path)!.join('\n')}`).join('\n');
  return repoContextFor(graph, { text, paths, promptTokens }, maxTokens);
}
