import {
  parseJsonStream,
  relativeTo,
  type AdapterContext,
  type AdapterFinding,
  type ToolAdapter,
} from './types.js';

// actionlint adapter (W18-26, MIT). Verified against actionlint 1.7.12 by
// running it on fixtures/adapters/actionlint inside an alpine 3.20 root with
// shellcheck on PATH; fixtures/adapters/recorded holds that output.
//
// actionlint has no style level — every kind it reports is something the
// Actions runner would reject or mis-run — so the filtering here is about the
// two kinds that depend on facts the sandbox cannot see, and the shellcheck
// pass-through, whose levels are filtered exactly as the shellcheck adapter's.

/** OUR config, baked into the scan image read-only (Containerfile.scan). */
export const ACTIONLINT_CONFIG_PATH = '/opt/actionlint/actionlint.yaml';

/** Where GitHub reads workflows from; nothing else is a workflow. */
const WORKFLOW_DIR = '.github/workflows';

/**
 * Kinds dropped, each because the answer depends on something outside the
 * snapshot. `runner-label`: a self-hosted runner's labels live in the
 * organisation's settings, so every custom label reads as unknown. `pyflakes`:
 * disabled on the command line and never installed; listed so a future image
 * that gains pyflakes does not start reporting through this adapter unreviewed.
 */
const DROPPED_KINDS = new Set(['runner-label', 'pyflakes']);

const SEVERITY_BY_KIND: Record<string, number> = {
  'syntax-check': 3,
  expression: 3,
  'job-needs': 3,
  'if-cond': 3,
  permissions: 3,
  'workflow-call': 3,
  credentials: 4,
  'deprecated-commands': 2,
};

interface ActionlintError {
  message?: unknown;
  filepath?: unknown;
  line?: unknown;
  kind?: unknown;
}

/** "shellcheck reported issue in this script: SC2115:warning:3:8: ..." */
const SHELLCHECK_MESSAGE = /\b(SC\d+):(error|warning|info|style):/;

interface Classified {
  ruleId: string;
  nativeRule: string;
  severity: number;
  dimension: AdapterFinding['dimension'];
}

function classify(kind: string, message: string): Classified | null {
  if (DROPPED_KINDS.has(kind)) return null;
  if (kind === 'shellcheck') {
    const match = SHELLCHECK_MESSAGE.exec(message);
    // A shellcheck line we cannot read is dropped, not guessed at: its level
    // decides whether it is a defect or a quoting opinion.
    if (!match) return null;
    const [, code = '', level] = match;
    if (level !== 'error' && level !== 'warning') return null;
    return {
      ruleId: `tool.actionlint.shellcheck.${code}`,
      nativeRule: code,
      severity: level === 'error' ? 3 : 2,
      dimension: 'correctness',
    };
  }
  if (kind === 'expression' && message.includes('potentially untrusted')) {
    // Script injection: attacker-controlled event text interpolated into a
    // shell. Its own rule id so its FP rate is not averaged with type errors,
    // and the iac dimension so it sits with the other pipeline-security
    // findings on the Security tab.
    return {
      ruleId: 'tool.actionlint.untrusted-input',
      nativeRule: 'untrusted-input',
      severity: 4,
      dimension: 'iac',
    };
  }
  return {
    ruleId: `tool.actionlint.${kind}`,
    nativeRule: kind,
    severity: SEVERITY_BY_KIND[kind] ?? 2,
    dimension: kind === 'credentials' ? 'iac' : 'correctness',
  };
}

export const actionlintAdapter: ToolAdapter = {
  key: 'actionlint',
  version: '1.7.12',
  license: 'MIT',
  shadow: true,

  detect(ctx: AdapterContext): boolean {
    return ctx.files.some((file) => isWorkflow(file));
  },

  command(ctx: AdapterContext): string[] {
    const root = `${ctx.mountPath.replace(/\/$/, '')}/${WORKFLOW_DIR}`;
    return [
      'find',
      root,
      // Top level only: GitHub ignores subdirectories of .github/workflows.
      '-maxdepth',
      '1',
      '-type',
      'f',
      '(',
      '-name',
      '*.yml',
      '-o',
      '-name',
      '*.yaml',
      ')',
      '-exec',
      'actionlint',
      // OUR config. actionlint only discovers a repository's
      // .github/actionlint.yaml when it finds a .git directory, which a
      // tarball snapshot never has — measured both ways — but the explicit
      // flag makes that a decision rather than an accident of packaging.
      '-config-file',
      ACTIONLINT_CONFIG_PATH,
      '-format',
      '{{json .}}',
      '-no-color',
      // Empty = disabled. shellcheck stays on: it is in the image, and the
      // `run:` blocks it checks are read by no other adapter.
      '-pyflakes=',
      '{}',
      '+',
    ];
  },

  parse(stdout: string, ctx: AdapterContext): AdapterFinding[] {
    const out: AdapterFinding[] = [];
    for (const doc of parseJsonStream(stdout)) {
      if (!Array.isArray(doc)) continue;
      for (const raw of doc as ActionlintError[]) {
        if (typeof raw?.kind !== 'string') continue;
        const message = typeof raw.message === 'string' ? raw.message : '';
        const classified = classify(raw.kind, message);
        if (!classified) continue;
        const line = typeof raw.line === 'number' ? raw.line : 1;
        out.push({
          ...classified,
          file: relativeTo(ctx.mountPath, typeof raw.filepath === 'string' ? raw.filepath : ''),
          lineStart: line,
          lineEnd: line,
          title: `${classified.nativeRule}: ${message}`.slice(0, 120),
          message,
        });
      }
    }
    return out;
  },
};

function isWorkflow(file: string): boolean {
  if (!file.startsWith(`${WORKFLOW_DIR}/`)) return false;
  const rest = file.slice(WORKFLOW_DIR.length + 1);
  return !rest.includes('/') && (rest.endsWith('.yml') || rest.endsWith('.yaml'));
}
