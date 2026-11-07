import { and, eq, inArray, isNull } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import { sliceHasSignal, type AreaFocus, type ModuleFile } from '@repopulse/analysis';

// W27-08: each AI area reads the functions it needs, not whole files.
//
// Brad, 2026-11-07: "make sure the ai portion is focused on the code for each of
// the areas". W27-07 decided WHICH FILES each area reads; this cuts a file down
// to the PARTS each area reads, from what Repo Pulse already knows without a
// model call:
//
//   code health  -> the functions the code health tools measured as worst
//                   (complexity, length, parameters, clones). A file with none
//                   has nothing for code health, when the tools measured any.
//   performance  -> the functions with a loop, a query or an async call.
//   security     -> the functions that handle input, auth, secrets, crypto,
//                   queries, shell, files or network, plus the function around
//                   every open security rule hit.
//   others       -> the whole file (best practices, test coverage, AI slop).
//
// Function spans come from the code map (code_index_defs). A file the map does
// not cover, or a repository with no map, is read whole: a missing map never
// hides code from the model. A smaller input is a smaller prefill on a local
// model, so more areas fit the call budget.

/** Lines kept above a function: its decorators, doc comment and signature. */
const LEAD_LINES = 3;

/** Rule families of the code health tools that point at one function or block. */
const CODE_HEALTH_MEASURED = /^(complexity\.(cyclomatic|function_length|parameters)|duplication\.)/;

/** Security-relevant finding dimensions whose lines security must read. */
const SECURITY_DIMENSIONS = ['security', 'secrets', 'iac', 'sast'];

type Span = readonly [number, number];

interface FocusRows {
  defs: { path: string; startLine: number; endLine: number }[];
  findings: {
    file: string | null;
    dimension: string;
    ruleId: string | null;
    scannerKey: string | null;
    lineStart: number | null;
    lineEnd: number | null;
  }[];
}

/**
 * A function's span. The regex tier of the map records only the line a
 * definition starts on, so a one-line span runs to the line before the next
 * definition in the same file (or the end of the file).
 */
export function functionSpans(
  defs: readonly { startLine: number; endLine: number }[],
  lineCount: number,
): Span[] {
  const sorted = [...defs].sort((a, b) => a.startLine - b.startLine);
  return sorted.map((d, i) => {
    if (d.endLine > d.startLine) return [d.startLine, Math.min(d.endLine, lineCount)] as const;
    const next = sorted.slice(i + 1).find((n) => n.startLine > d.startLine);
    return [d.startLine, next ? next.startLine - 1 : lineCount] as const;
  });
}

const withLead = ([a, b]: Span): Span => [Math.max(1, a - LEAD_LINES), b];

/** The span around `line`: the innermost function containing it, else ±10 lines. */
function around(line: number, spans: readonly Span[], lineCount: number): Span {
  const inside = spans
    .filter(([a, b]) => a <= line && line <= b)
    .sort((x, y) => x[1] - x[0] - (y[1] - y[0]))[0];
  return inside ?? [Math.max(1, line - 10), Math.min(lineCount, line + 10)];
}

/** Pure: the focus of each file from the map's definitions and the open findings. */
export function buildFocus(files: readonly ModuleFile[], rows: FocusRows): ModuleFile[] {
  const defsBy = new Map<string, { startLine: number; endLine: number }[]>();
  for (const d of rows.defs) defsBy.set(d.path, [...(defsBy.get(d.path) ?? []), d]);
  const measured = rows.findings.filter(
    (f) => f.scannerKey === 'code_health_tools' && f.ruleId && CODE_HEALTH_MEASURED.test(f.ruleId),
  );
  const anyMeasured = measured.length > 0;

  return files.map((f) => {
    const lines = f.content.split('\n');
    const lineCount = lines.length;
    const defs = defsBy.get(f.path) ?? [];
    const focus: AreaFocus = {};
    const spans = defs.length > 0 ? functionSpans(defs, lineCount) : [];
    const text = ([a, b]: Span) => lines.slice(a - 1, b).join('\n');

    // Code health: what the tools measured, whether or not the map has the file.
    if (anyMeasured) {
      focus.code_health = measured
        .filter((m) => m.file === f.path && m.lineStart !== null)
        .map((m) => withLead([m.lineStart!, m.lineEnd ?? m.lineStart!]));
    }

    if (spans.length > 0) {
      focus.performance = spans.filter((s) => sliceHasSignal('performance', text(s))).map(withLead);
      const hits = rows.findings
        .filter(
          (h) =>
            h.file === f.path && h.lineStart !== null && SECURITY_DIMENSIONS.includes(h.dimension),
        )
        .map((h) => around(h.lineStart!, spans, lineCount));
      focus.security = [
        ...spans.filter((s) => sliceHasSignal('security', text(s))).map(withLead),
        ...hits,
      ];
      // A file whose code sits outside any definition (a script, top-level
      // handlers) would lose that code: such a file is read whole.
      const covered = new Set<number>();
      for (const [a, b] of spans) for (let i = a; i <= b; i++) covered.add(i);
      const topLevel = lines.filter(
        (l, i) =>
          !covered.has(i + 1) &&
          l.trim() !== '' &&
          !/^\s*(import|export \{|\/\/|#|\*|\/\*)/.test(l),
      ).length;
      if (topLevel > 20) {
        delete focus.performance;
        delete focus.security;
      }
    }
    return Object.keys(focus).length > 0 ? { ...f, focus } : f;
  });
}

/** Loads the map's definitions and the open findings for `files`, then builds the focus. */
export async function focusFiles(
  db: Database,
  key: { workspaceId: number; repoId: number },
  files: readonly ModuleFile[],
): Promise<ModuleFile[]> {
  const paths = files.map((f) => f.path);
  if (paths.length === 0) return [...files];
  const defs = await db
    .select({
      path: read.codeIndexDefs.path,
      startLine: read.codeIndexDefs.startLine,
      endLine: read.codeIndexDefs.endLine,
    })
    .from(read.codeIndexDefs)
    .innerJoin(
      read.codeIndexes,
      and(
        eq(read.codeIndexes.id, read.codeIndexDefs.indexId),
        eq(read.codeIndexes.workspaceId, read.codeIndexDefs.workspaceId),
      ),
    )
    .where(
      and(
        eq(read.codeIndexDefs.workspaceId, key.workspaceId),
        eq(read.codeIndexes.repoId, key.repoId),
        eq(read.codeIndexDefs.kind, 'function'),
        inArray(read.codeIndexDefs.path, paths),
      ),
    );
  const findings = await db
    .select({
      file: read.findings.file,
      dimension: read.findings.dimension,
      ruleId: read.findings.ruleId,
      scannerKey: read.findings.scannerKey,
      lineStart: read.findings.lineStart,
      lineEnd: read.findings.lineEnd,
    })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, key.workspaceId),
        eq(read.findings.repoId, key.repoId),
        eq(read.findings.status, 'open'),
        isNull(read.findings.pullRequestId),
        inArray(read.findings.file, paths),
      ),
    );
  return buildFocus(files, { defs, findings });
}
