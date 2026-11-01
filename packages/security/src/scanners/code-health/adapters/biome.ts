import {
  extractJson,
  hasExtension,
  relativeTo,
  type AdapterContext,
  type AdapterFinding,
  type ToolAdapter,
} from './types.js';

// Biome adapter (W9-08, MIT/Apache-2.0). Verified against Biome 2.5.9.
//
// Biome's categories are `lint/{group}/{rule}`, and only two groups describe
// defects rather than taste: `correctness` and `suspicious`. `style` and
// `complexity` are deliberately dropped — the first is a formatting opinion the
// repository's own tooling should own, and the second overlaps lizard, which
// already measures complexity with a number rather than a rule.

const KEPT_GROUPS: Record<string, { dimension: 'code_health' | 'correctness'; severity: number }> = {
  correctness: { dimension: 'correctness', severity: 3 },
  suspicious: { dimension: 'correctness', severity: 2 },
};

interface BiomeDiagnostic {
  severity?: string;
  message?: unknown;
  category?: string;
  location?: { path?: unknown; start?: { line?: number }; end?: { line?: number } };
}

/** Biome's message is sometimes a string and sometimes a rich-text array. */
function messageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    return message
      .map((part) =>
        typeof part === 'string' ? part : typeof part === 'object' && part && 'content' in part
          ? String((part as { content: unknown }).content)
          : '',
      )
      .join('')
      .trim();
  }
  return '';
}

function pathOf(path: unknown): string {
  if (typeof path === 'string') return path;
  // Biome has shipped `{ file: "..." }` for this field in some versions; read
  // it rather than storing "[object Object]" as a finding's location.
  if (path && typeof path === 'object' && 'file' in path) {
    return String((path as { file: unknown }).file);
  }
  return '';
}

export const biomeAdapter: ToolAdapter = {
  key: 'biome',
  version: '2.5.9',
  license: 'MIT OR Apache-2.0',
  /**
   * Incremental scans (W23-03): 'file' — lint rules read one file at a time, with our own baked-in config.
   */
  scope: 'file',

  detect(ctx: AdapterContext): boolean {
    return hasExtension(ctx.files, ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
  },

  command(ctx: AdapterContext): string[] {
    return [
      'biome',
      'lint',
      '--reporter=json',
      // OUR config, baked into the image read-only. Same reasoning as ruff's
      // --isolated: a repository's own biome.json would decide what our
      // scanner reports, and a repo could silence us by committing a setting.
      // Biome also refuses to start when --config-path has no config in it,
      // which is how the first version of this failed.
      '--config-path=/opt/biome',
      ctx.mountPath,
    ];
  },

  parse(stdout: string, ctx: AdapterContext): AdapterFinding[] {
    const json = extractJson(stdout);
    if (!json) return [];
    let parsed: { diagnostics?: BiomeDiagnostic[] };
    try {
      parsed = JSON.parse(json) as { diagnostics?: BiomeDiagnostic[] };
    } catch {
      return [];
    }

    const out: AdapterFinding[] = [];
    for (const diagnostic of parsed.diagnostics ?? []) {
      const category = diagnostic.category ?? '';
      const match = /^lint\/([^/]+)\/(.+)$/.exec(category);
      if (!match) continue;
      const kept = KEPT_GROUPS[match[1] as string];
      if (!kept) continue;

      const line = diagnostic.location?.start?.line ?? 1;
      const rule = match[2] as string;
      const message = messageText(diagnostic.message);
      out.push({
        ruleId: `tool.biome.${rule}`,
        file: relativeTo(ctx.mountPath, pathOf(diagnostic.location?.path)),
        lineStart: line,
        lineEnd: diagnostic.location?.end?.line ?? line,
        severity: kept.severity,
        title: `${rule}: ${message}`.slice(0, 120),
        message,
        dimension: kept.dimension,
        nativeRule: category,
      });
    }
    return out;
  },
};
