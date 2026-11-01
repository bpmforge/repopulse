import {
  basenameMatches,
  findExec,
  parseJsonStream,
  relativeTo,
  type AdapterContext,
  type AdapterFinding,
  type ToolAdapter,
} from './types.js';

// hadolint adapter (W18-26, GPL-3.0 — run as a subprocess only, never linked
// or modified; DESIGN_REVIEW.md §4 records the distribution obligation).
// Verified against hadolint 2.15.1 by running it on fixtures/adapters/hadolint
// inside an alpine 3.20 root; fixtures/adapters/recorded holds that output.
//
// hadolint embeds shellcheck for RUN instructions, so its output carries both
// DLxxxx (Dockerfile) and SCxxxx (the shell inside RUN) codes. Both are kept:
// the shellcheck adapter only reads *.sh files, so nothing else sees a RUN line.

/** Dockerfile names as people actually write them, Podman's included. */
const DOCKERFILE_PATTERNS = [
  'Dockerfile',
  'Dockerfile.*',
  '*.Dockerfile',
  '*.dockerfile',
  'Containerfile',
  'Containerfile.*',
];

/** OUR config, baked into the scan image read-only (Containerfile.scan). */
export const HADOLINT_CONFIG_PATH = '/opt/hadolint/hadolint.yaml';

/**
 * Error and warning only. hadolint's info level is where "use
 * --no-install-recommends" and "delete the apt lists" live — image-size advice,
 * not defects — and style is style.
 */
const SEVERITY_BY_LEVEL: Record<string, number> = { error: 3, warning: 2 };

interface HadolintResult {
  code?: unknown;
  file?: unknown;
  level?: unknown;
  line?: unknown;
  message?: unknown;
}

export const hadolintAdapter: ToolAdapter = {
  key: 'hadolint',
  version: '2.15.1',
  license: 'GPL-3.0-only (subprocess only)',
  /**
   * Incremental scans (W23-03): 'file' — one Dockerfile at a time, no cross-file context.
   */
  scope: 'file',
  shadow: true,

  detect(ctx: AdapterContext): boolean {
    return ctx.files.some((file) => basenameMatches(file, DOCKERFILE_PATTERNS));
  },

  command(ctx: AdapterContext): string[] {
    return findExec(ctx.mountPath, DOCKERFILE_PATTERNS, [
      'hadolint',
      // Without --config hadolint reads .hadolint.yaml from the working
      // directory — which in the sandbox is the snapshot — so a repository
      // could `ignored:` any rule out of our findings. Measured: a fixture
      // repo's `ignored: [DL3007]` silenced DL3007 until this flag was added.
      // /dev/null does not work: hadolint rejects an empty config and prints
      // the complaint on stdout, ahead of the JSON.
      '--config',
      HADOLINT_CONFIG_PATH,
      '--no-color',
      '-f',
      'json',
    ]);
  },

  parse(stdout: string, ctx: AdapterContext): AdapterFinding[] {
    const out: AdapterFinding[] = [];
    for (const doc of parseJsonStream(stdout)) {
      if (!Array.isArray(doc)) continue;
      for (const raw of doc as HadolintResult[]) {
        if (typeof raw?.code !== 'string' || !/^(DL|SC)\d+$/.test(raw.code)) continue;
        const severity = SEVERITY_BY_LEVEL[String(raw.level)];
        if (severity === undefined) continue;
        const message = typeof raw.message === 'string' ? raw.message : '';
        const line = typeof raw.line === 'number' ? raw.line : 1;
        out.push({
          ruleId: `tool.hadolint.${raw.code}`,
          file: relativeTo(ctx.mountPath, typeof raw.file === 'string' ? raw.file : ''),
          lineStart: line,
          lineEnd: line,
          severity,
          title: `${raw.code}: ${message}`.slice(0, 120),
          message,
          dimension: 'correctness',
          nativeRule: raw.code,
        });
      }
    }
    return out;
  },
};
