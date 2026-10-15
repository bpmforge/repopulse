import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { actionlintAdapter } from './actionlint.js';
import { CHECKOV_CHECKS, checkovAdapter } from './checkov.js';
import { hadolintAdapter, HADOLINT_CONFIG_PATH } from './hadolint.js';
import {
  adaptersFor,
  dedupeAcrossTools,
  dedupeAgainstPack,
  listAdapters,
  TOOL_DEDUP_MAP,
} from './registry.js';
import { shellcheckAdapter } from './shellcheck.js';
import { findExec, parseJsonStream, type AdapterContext, type ToolAdapter } from './types.js';

// W18-26: actionlint, shellcheck, hadolint, checkov.
//
// The parse tests read REAL tool output, recorded by running each adapter's
// own command over the trigger and clean fixtures beside it (fixtures/adapters/
// <tool>/{triggering,clean}) — shellcheck 0.11.0, hadolint 2.15.1 and
// actionlint 1.7.12 inside an alpine 3.20 root, checkov 3.3.29 under
// `unshare -n` with a read-only HOME. A parser tested against output we typed
// ourselves only proves we can read our own guesses.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDED = path.resolve(HERE, '../../../../fixtures/adapters/recorded');
const recorded = (name: string): string => readFileSync(path.join(RECORDED, name), 'utf8');
const ctx = (files: string[] = []): AdapterContext => ({ mountPath: '/scan', files });

const NEW_ADAPTERS: ToolAdapter[] = [
  actionlintAdapter,
  shellcheckAdapter,
  hadolintAdapter,
  checkovAdapter,
];

describe('registration and routing', () => {
  it('registers all four, each with a pinned version and a licence', () => {
    const keys = listAdapters().map((a) => a.key);
    for (const adapter of NEW_ADAPTERS) {
      expect(keys).toContain(adapter.key);
      expect(adapter.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(adapter.license.length).toBeGreaterThan(2);
    }
    // GPL tools are recorded as subprocess-only in their own licence string,
    // so the constraint travels with the adapter rather than living in a doc.
    expect(shellcheckAdapter.license).toMatch(/GPL-3\.0.*subprocess/);
    expect(hadolintAdapter.license).toMatch(/GPL-3\.0.*subprocess/);
  });

  it('ships every new adapter as a shadow candidate; ruff and Biome stay as they were', () => {
    for (const adapter of NEW_ADAPTERS) expect(adapter.shadow).toBe(true);
    const ruff = listAdapters().find((a) => a.key === 'ruff');
    expect(ruff?.shadow).toBeUndefined();
  });

  it.each([
    ['.github/workflows/ci.yml', ['actionlint']],
    ['.github/workflows/release.yaml', ['actionlint']],
    ['scripts/deploy.sh', ['shellcheck']],
    ['tools/run.bash', ['shellcheck']],
    ['Dockerfile', ['hadolint', 'checkov']],
    ['services/api/Dockerfile.prod', ['hadolint', 'checkov']],
    ['api.Dockerfile', ['hadolint', 'checkov']],
    ['Containerfile', ['hadolint']],
    ['infra/main.tf', ['checkov']],
    ['stack.tf.json', ['checkov']],
    ['k8s/deployment.yaml', ['checkov']],
    ['deploy/prod/service.yml', ['checkov']],
    ['template.yaml', ['checkov']],
  ])('%s routes to %j', (file, expected) => {
    const keys = adaptersFor(ctx([file]))
      .map((a) => a.key)
      .filter((k) => NEW_ADAPTERS.some((a) => a.key === k));
    expect(keys.sort()).toEqual([...expected].sort());
  });

  it.each([
    // Near-misses: names that look close and are not what the tool reads.
    '.github/workflows/nested/ci.yml', // GitHub ignores subdirectories
    '.github/actions/setup/action.yml', // a composite action, not a workflow
    'docs/ci.yml',
    'scripts/profile.zsh', // shellcheck cannot parse zsh
    'docker-compose.yml',
    'config/settings.yaml',
    'package.json',
    'src/app.ts',
  ])('%s routes to none of them', (file) => {
    const keys = adaptersFor(ctx([file])).map((a) => a.key);
    for (const adapter of NEW_ADAPTERS) expect(keys).not.toContain(adapter.key);
  });
});

describe('commands run standalone, under our config, not the repository’s', () => {
  it('installs nothing and fetches nothing', () => {
    for (const adapter of NEW_ADAPTERS) {
      const argv = adapter.command(ctx()).join(' ');
      expect(argv).not.toMatch(/\b(install|npm|pip|curl|wget|--fix)\b/);
    }
  });

  it('points every tool at our baked-in config, or at none', () => {
    expect(shellcheckAdapter.command(ctx())).toContain('--norc');
    const hadolint = hadolintAdapter.command(ctx());
    expect(hadolint[hadolint.indexOf('--config') + 1]).toBe(HADOLINT_CONFIG_PATH);
    expect(actionlintAdapter.command(ctx())).toContain('-config-file');
    // checkov: `cd /` so the snapshot is not the working directory, and the
    // `=` form so its -d config discovery does not see the snapshot either.
    const checkov = checkovAdapter.command(ctx());
    expect(checkov.slice(0, 3)).toEqual(['sh', '-c', 'cd / && exec "$@"']);
    expect(checkov).toContain('--directory=/scan');
    expect(checkov).not.toContain('-d');
    expect(checkov).toContain('--skip-download');
  });

  it('runs checkov on the chosen frameworks and the allowlist only', () => {
    const argv = checkovAdapter.command(ctx());
    const frameworks = argv.slice(argv.indexOf('--framework') + 1, argv.indexOf('--check'));
    expect(frameworks).toEqual(['terraform', 'cloudformation', 'kubernetes', 'dockerfile']);
    // secrets and github_actions belong to other scanners; helm needs a binary
    // the image does not have.
    expect(frameworks).not.toContain('secrets');
    expect(frameworks).not.toContain('github_actions');
    expect(frameworks).not.toContain('helm');
    expect(argv[argv.indexOf('--check') + 1]?.split(',')).toEqual(Object.keys(CHECKOV_CHECKS));
  });

  it('finds files inside the container, so a big tree cannot overflow the shell line', () => {
    const argv = findExec('/scan', ['*.sh'], ['shellcheck']);
    expect(argv.slice(0, 2)).toEqual(['find', '/scan']);
    expect(argv).toContain('-prune');
    expect(argv).toContain('node_modules');
    expect(argv.slice(-3)).toEqual(['shellcheck', '{}', '+']);
  });
});

describe('parsing real output: trigger fixtures fire, clean fixtures do not', () => {
  it('shellcheck: keeps errors and warnings, drops the env-var false positive', () => {
    const findings = shellcheckAdapter.parse(recorded('shellcheck.triggering.json'), ctx());
    expect(findings.map((f) => f.nativeRule)).toEqual(['SC2164', 'SC2115', 'SC2045', 'SC3014']);
    expect(findings[0]?.ruleId).toBe('tool.shellcheck.SC2164');
    expect(findings[0]?.file).toBe('deploy.sh');
    expect(findings.find((f) => f.nativeRule === 'SC2045')?.severity).toBe(3);
    expect(shellcheckAdapter.parse(recorded('shellcheck.clean.json'), ctx())).toEqual([]);
  });

  it('hadolint: keeps error and warning levels, drops info', () => {
    const findings = hadolintAdapter.parse(recorded('hadolint.triggering.json'), ctx());
    expect(findings.map((f) => f.nativeRule)).toEqual([
      'DL3007',
      'DL3000',
      'DL3008',
      'DL3003',
      'DL3002',
    ]);
    expect(findings.map((f) => f.nativeRule)).not.toContain('DL3015'); // info
    expect(findings[0]).toMatchObject({ ruleId: 'tool.hadolint.DL3007', file: 'Dockerfile' });
    expect(hadolintAdapter.parse(recorded('hadolint.clean.json'), ctx())).toEqual([]);
  });

  it('actionlint: script injection is its own rule, shellcheck info is dropped', () => {
    const findings = actionlintAdapter.parse(recorded('actionlint.triggering.json'), ctx());
    expect(findings.map((f) => f.ruleId)).toEqual([
      'tool.actionlint.untrusted-input',
      'tool.actionlint.deprecated-commands',
      'tool.actionlint.expression',
      'tool.actionlint.shellcheck.SC2115',
      'tool.actionlint.job-needs',
    ]);
    const injection = findings[0];
    expect(injection).toMatchObject({ severity: 4, dimension: 'iac', lineStart: 11 });
    expect(injection?.file).toBe('.github/workflows/ci.yml');
    expect(actionlintAdapter.parse(recorded('actionlint.clean.json'), ctx())).toEqual([]);
  });

  it('checkov: every framework fires on its trigger fixture, under our severities', () => {
    const findings = checkovAdapter.parse(recorded('checkov.triggering.json'), ctx());
    const byFile = (file: string) =>
      findings
        .filter((f) => f.file === file)
        .map((f) => f.nativeRule)
        .sort();
    expect(byFile('terraform/main.tf')).toEqual(['CKV_AWS_16', 'CKV_AWS_17', 'CKV_AWS_24']);
    expect(byFile('cloudformation/template.yaml')).toEqual([
      'CKV_AWS_20',
      'CKV_AWS_25',
      'CKV_AWS_57',
    ]);
    expect(byFile('k8s/deployment.yaml')).toEqual([
      'CKV_K8S_14',
      'CKV_K8S_16',
      'CKV_K8S_19',
      'CKV_K8S_20',
    ]);
    expect(byFile('docker/Dockerfile')).toEqual(['CKV_DOCKER_1', 'CKV_DOCKER_7', 'CKV_DOCKER_8']);
    expect(findings.every((f) => f.dimension === 'iac')).toBe(true);
    const ssh = findings.find((f) => f.nativeRule === 'CKV_AWS_24');
    expect(ssh).toMatchObject({ severity: 4, lineStart: 1, lineEnd: 12 });
    expect(checkovAdapter.parse(recorded('checkov.clean.json'), ctx())).toEqual([]);
  });

  it('checkov: a check outside the allowlist is dropped even if checkov reports it', () => {
    // --check is the cost control; the parser is the guarantee.
    const stdout = JSON.stringify({
      check_type: 'kubernetes',
      results: {
        failed_checks: [
          { check_id: 'CKV_K8S_8', check_name: 'Liveness probe', file_abs_path: '/scan/a.yaml' },
          { check_id: 'CKV_K8S_16', check_name: 'Privileged', file_abs_path: '/scan/a.yaml' },
        ],
      },
    });
    expect(checkovAdapter.parse(stdout, ctx()).map((f) => f.nativeRule)).toEqual(['CKV_K8S_16']);
  });

  it('checkov: reads the bare summary it prints for a tree with no IaC as empty', () => {
    const summary = '{"passed": 0, "failed": 0, "skipped": 0, "parsing_errors": 0}';
    expect(checkovAdapter.parse(summary, ctx())).toEqual([]);
  });
});

describe('parse() never throws', () => {
  const hostile = [
    '',
    '   ',
    'not json',
    '{',
    '[{"code":',
    'null',
    '42',
    '"a string"',
    '[null, 1, "x", {}]',
    '{"comments": "nope"}',
    '{"results": {"failed_checks": [null, 3, {"check_id": 7}]}}',
    '[{"kind": "expression", "line": "eleven", "message": null}]',
  ];
  it.each(NEW_ADAPTERS.map((a) => [a.key, a] as const))('%s', (_key, adapter) => {
    for (const stdout of hostile) {
      expect(() => adapter.parse(stdout, ctx())).not.toThrow();
    }
    expect(adapter.parse('', ctx())).toEqual([]);
    expect(adapter.parse('not json', ctx())).toEqual([]);
  });
});

describe('parseJsonStream', () => {
  it('reads several documents back to back, as find -exec {} + produces', () => {
    const one = recorded('shellcheck.triggering.json').trim();
    const two = recorded('shellcheck.clean.json').trim();
    const docs = parseJsonStream(`${one}\n${two}`);
    expect(docs).toHaveLength(2);
    const findings = shellcheckAdapter.parse(`${one}${one}`, ctx());
    expect(findings).toHaveLength(8);
  });

  it('is not fooled by brackets inside strings, and skips noise between documents', () => {
    expect(parseJsonStream('warn: x\n{"m":"a } ] {"}\nnoise (see [docs])\n[1]')).toEqual([
      { m: 'a } ] {' },
      [1],
    ]);
  });

  it('keeps every complete document before a truncated one', () => {
    // A run killed by the wall clock mid-print: what was printed is real.
    expect(parseJsonStream('[1]\n{"comments":[{"code":')).toEqual([[1]]);
  });
});

describe('dedup', () => {
  const dockerfileRun = () => [
    ...hadolintAdapter.parse(recorded('hadolint.checkov-triggering.json'), ctx()),
    ...checkovAdapter.parse(recorded('checkov.triggering.json'), ctx()),
  ];

  it('collapses checkov and hadolint on the SAME Dockerfile, per the map', () => {
    const { kept, dropped } = dedupeAcrossTools(dockerfileRun());
    const keptRules = kept.filter((f) => f.file === 'docker/Dockerfile').map((f) => f.ruleId);
    // hadolint keeps "latest" (exact instruction); checkov keeps root-user
    // (a privilege finding, iac dimension). checkov's port-22 has no twin.
    expect(keptRules.sort()).toEqual([
      'tool.checkov.CKV_DOCKER_1',
      'tool.checkov.CKV_DOCKER_8',
      'tool.hadolint.DL3007',
    ]);
    expect(dropped.map((d) => d.ruleId).sort()).toEqual([
      'tool.checkov.CKV_DOCKER_7',
      'tool.hadolint.DL3002',
    ]);
  });

  it('does NOT collapse across different files', () => {
    const findings = dockerfileRun().map((f) =>
      f.ruleId === 'tool.hadolint.DL3007' ? { ...f, file: 'other/Dockerfile' } : f,
    );
    const { kept } = dedupeAcrossTools(findings);
    expect(kept.map((f) => f.ruleId)).toContain('tool.checkov.CKV_DOCKER_7');
  });

  it('every map entry names rules our adapters can actually emit', () => {
    for (const { keep, drop } of TOOL_DEDUP_MAP) {
      for (const ruleId of [keep, drop]) {
        const [, tool, native] = ruleId.split('.');
        expect(NEW_ADAPTERS.map((a) => a.key)).toContain(tool);
        if (tool === 'checkov') expect(Object.keys(CHECKOV_CHECKS)).toContain(native);
      }
    }
  });

  it('lets the secrets scanner own hard-coded credentials, for either half of the key', () => {
    const finding = {
      ruleId: 'tool.checkov.CKV_AWS_41',
      file: 'main.tf',
      lineStart: 1,
      lineEnd: 1,
      severity: 4,
      title: 't',
      message: 'm',
      dimension: 'iac' as const,
      nativeRule: 'CKV_AWS_41',
    };
    expect(dedupeAgainstPack([finding], ['aws-secret-access-key']).kept).toEqual([]);
    expect(dedupeAgainstPack([finding], ['aws-access-key-id']).kept).toEqual([]);
    expect(dedupeAgainstPack([finding], []).kept).toHaveLength(1);
  });
});
