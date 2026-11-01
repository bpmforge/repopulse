import {
  extractJson,
  hasExtension,
  relativeTo,
  type AdapterContext,
  type AdapterFinding,
  type ToolAdapter,
} from './types.js';

// ruff adapter (W9-08, MIT). Verified against ruff 0.16.3 by running it.
//
// ruff is a linter, and most of what a linter says is style. Only the rule
// families that describe a DEFECT are kept — a findings list that reports
// import ordering next to a bare `except` teaches people that the list is
// mostly noise, and then they stop reading the part that mattered.

/** Rule-code prefixes worth a finding, and where each belongs. */
const KEPT_PREFIXES: { prefix: string; dimension: 'code_health' | 'correctness' }[] = [
  // E7xx: bare except, comparison to None/True, mutable default — real bugs.
  { prefix: 'E7', dimension: 'correctness' },
  // F: pyflakes — undefined names, unused imports, f-string without placeholders.
  { prefix: 'F', dimension: 'correctness' },
  // B: bugbear — mutable argument defaults, loop-variable binding, assert on tuple.
  { prefix: 'B', dimension: 'correctness' },
  // S: bandit-derived security lints. Kept as code_health rather than security:
  // this scanner is not the security suite, and a lint is not a vulnerability.
  { prefix: 'S', dimension: 'code_health' },
  // C9: mccabe complexity.
  { prefix: 'C9', dimension: 'code_health' },
];

const SEVERITY_BY_PREFIX: Record<string, number> = { E7: 3, F: 3, B: 2, S: 3, C9: 2 };

interface RuffDiagnostic {
  code?: string | null;
  message?: string;
  filename?: string;
  location?: { row?: number };
  end_location?: { row?: number };
}

export const ruffAdapter: ToolAdapter = {
  key: 'ruff',
  version: '0.16.3',
  license: 'MIT',
  /**
   * Incremental scans (W23-03): 'file' — each diagnostic is a property of one file (isolated config, no import resolution across files).
   */
  scope: 'file',

  detect(ctx: AdapterContext): boolean {
    return hasExtension(ctx.files, ['.py', '.pyi']);
  },

  command(ctx: AdapterContext): string[] {
    return [
      'ruff',
      'check',
      '--output-format',
      'json',
      // No cache: the snapshot root is read-only and the cache would be
      // written into it. Also correct on its own terms — a cache keyed on a
      // path that exists for one scan is a cache that never hits.
      '--no-cache',
      // Explicit rule selection, so a ruff upgrade cannot silently add rule
      // families to everyone's findings list overnight.
      '--select',
      'E7,F,B,S,C90',
      // No config discovery: a repository's own pyproject.toml would decide
      // what our scanner reports, which makes findings incomparable between
      // repositories and lets one repo silence us by committing a setting.
      '--isolated',
      ctx.mountPath,
    ];
  },

  parse(stdout: string, ctx: AdapterContext): AdapterFinding[] {
    const json = extractJson(stdout);
    if (!json) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    const out: AdapterFinding[] = [];
    for (const raw of parsed as RuffDiagnostic[]) {
      const code = raw.code ?? '';
      const kept = KEPT_PREFIXES.find((k) => code.startsWith(k.prefix));
      if (!kept) continue;
      const line = raw.location?.row ?? 1;
      out.push({
        ruleId: `tool.ruff.${code}`,
        file: relativeTo(ctx.mountPath, raw.filename ?? ''),
        lineStart: line,
        lineEnd: raw.end_location?.row ?? line,
        severity: SEVERITY_BY_PREFIX[kept.prefix] ?? 2,
        title: `${code}: ${raw.message ?? ''}`.slice(0, 120),
        message: raw.message ?? '',
        dimension: kept.dimension,
        nativeRule: code,
      });
    }
    return out;
  },
};
