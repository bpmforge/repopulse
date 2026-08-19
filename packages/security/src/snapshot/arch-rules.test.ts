import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The lint gates for C1a and NFR-14 (W8-03), tested by PLANTING violations.
//
// Asserting that today's tree passes proves nothing: a rule whose regex never
// matches anything passes forever, which is the built-but-never-fires cousin of
// the built-but-never-called defect this project keeps hitting. Each rule here
// is run against a throwaway tree containing the exact thing it forbids, and is
// required to fail.

const RULES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../scripts/arch-rules-6-7.sh',
);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function runRule(fn: string, root: string): { ok: boolean; output: string } {
  try {
    const out = execFileSync('bash', ['-c', `source ${RULES}; ${fn} ${JSON.stringify(root)}`], {
      stdio: 'pipe',
    });
    return { ok: true, output: out.toString() };
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    return { ok: false, output: `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}` };
  }
}

function plant(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'w8-03-arch-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

describe('rule 6 — no clone, and getTarball only from the snapshot service (C1a)', () => {
  it('FIRES on a git clone anywhere', () => {
    const root = plant({
      'packages/ingest/src/bad.ts': `execFileSync('git', ['clone', repoUrl, dir]);\n`,
    });
    const result = runRule('rule6_clone_and_tarball', root);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('bad.ts');
  });

  it('FIRES on a clone library, not just the command', () => {
    // C1 says no cloning. Reaching for simple-git instead of the binary is the
    // same violation with a nicer API.
    const root = plant({ 'apps/api/src/bad.ts': `import simpleGit from 'simple-git';\n` });
    expect(runRule('rule6_clone_and_tarball', root).ok).toBe(false);
  });

  it('FIRES when something outside the snapshot service calls getTarball', () => {
    // Whole-repo source pulled anywhere else is source that never gets
    // extracted under guard and never gets shredded.
    const root = plant({
      'packages/ingest/src/bad.ts': `const tar = await provider.getTarball(ctx, repo, sha);\n`,
    });
    expect(runRule('rule6_clone_and_tarball', root).ok).toBe(false);
  });

  it('ALLOWS the forge package defining it and the security package calling it', () => {
    const root = plant({
      'packages/forge/src/github/provider.ts': `async getTarball(ctx, repo, sha) { return x; }\n`,
      'packages/security/src/snapshot/fetch.ts': `await provider.getTarball(ctx, repo, sha);\n`,
    });
    expect(runRule('rule6_clone_and_tarball', root).ok).toBe(true);
  });

  it('passes on the real tree', () => {
    const result = runRule('rule6_clone_and_tarball', REPO_ROOT);
    expect(result.output).toBe('');
    expect(result.ok).toBe(true);
  });
});

describe('rule 7 — scan tools spawn only inside the sandbox (NFR-14)', () => {
  it('FIRES on a semgrep spawned outside packages/security/sandbox', () => {
    // A tool run outside the profile runs with the host network, the host
    // filesystem and this process's environment.
    const root = plant({
      'apps/api/src/bad.ts': `execFileSync('semgrep', ['--config', 'auto', dir]);\n`,
    });
    const result = runRule('rule7_scan_tool_spawn', root);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('semgrep');
  });

  it('FIRES on gitleaks, trivy, syft, grype and the rest of the set', () => {
    for (const tool of ['gitleaks', 'trivy', 'syft', 'grype', 'osv-scanner', 'checkov']) {
      const root = plant({ 'packages/insights/src/bad.ts': `spawn('${tool}', args);\n` });
      expect(runRule('rule7_scan_tool_spawn', root).ok, tool).toBe(false);
    }
  });

  it('does not fire on the word semgrep in prose', () => {
    // A rule that flags documentation gets disabled by the third person it
    // annoys, and then it is not a rule.
    const root = plant({
      'packages/security/src/config/defaults.ts': `export const rationale = 'semgrep finds SAST issues';\n`,
    });
    expect(runRule('rule7_scan_tool_spawn', root).ok).toBe(true);
  });

  it('passes on the real tree', () => {
    const result = runRule('rule7_scan_tool_spawn', REPO_ROOT);
    expect(result.output).toBe('');
    expect(result.ok).toBe(true);
  });
});
