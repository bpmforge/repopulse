import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runtimeFreeSystemPath } from './runtime-free-path.js';

const run = promisify(execFile);
const repoRoot = new URL('../../../../', import.meta.url).pathname;

/**
 * deploy/configure.sh (W22-15) — the wrapper that runs configure.mjs inside the
 * migrate image when the host has no Node.
 *
 * The 2026-10-31 fresh-VM test found it could not work on any Linux host
 * following the checkout steps: it needed the migrate image that only
 * `up.sh --build` made (G1), and under rootless Podman `--user uid:gid` could not
 * write deploy/.env (G2). The runtime and `uname` are stubbed, and Node is kept
 * off PATH so the containerised branch is the one that runs. This proves the
 * script's decisions; the live run is recorded in W22-15's notes.
 */
describe('deploy/configure.sh (W22-15)', () => {
  let dir: string;
  let bin: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rp cfgsh-'));
    bin = path.join(dir, 'bin');
    mkdirSync(bin);
    mkdirSync(path.join(dir, 'root', 'deploy'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** System tools minus the runtimes AND node, so configure.sh cannot exec node. */
  function nodeFreePath(): string {
    const out = path.join(dir, 'sys');
    if (existsSync(out)) return out;
    mkdirSync(out);
    const sys = runtimeFreeSystemPath();
    for (const name of readdirSync(sys)) {
      if (name === 'node' || name === 'uname') continue;
      symlinkSync(path.join(sys, name), path.join(out, name));
    }
    return out;
  }

  function stub(
    runtime: 'podman' | 'docker',
    opts: { imagePresent?: boolean; buildxRc?: number; os?: string } = {},
  ): void {
    const calls = path.join(dir, 'calls.txt');
    const script = `#!/usr/bin/env bash
echo "$*" >> "${calls}"
case "$1" in
  image) exit ${opts.imagePresent ? 0 : 1} ;;
  buildx) exit ${opts.buildxRc ?? 0} ;;
  build|run) exit 0 ;;
esac
exit 1
`;
    writeFileSync(path.join(bin, runtime), script);
    chmodSync(path.join(bin, runtime), 0o755);
    writeFileSync(path.join(bin, 'uname'), `#!/bin/sh\necho ${opts.os ?? 'Linux'}\n`);
    chmodSync(path.join(bin, 'uname'), 0o755);
  }

  /** A checkout has the Dockerfile beside deploy/ and build: stanzas in compose. */
  async function layout(checkout: boolean): Promise<string> {
    const deploy = path.join(dir, 'root', 'deploy');
    await run('cp', [
      path.join(repoRoot, 'deploy/configure.sh'),
      path.join(deploy, 'configure.sh'),
    ]);
    if (checkout) {
      await run('cp', [
        path.join(repoRoot, 'deploy/compose.yaml'),
        path.join(deploy, 'compose.yaml'),
      ]);
      writeFileSync(path.join(dir, 'root', 'Dockerfile'), 'FROM scratch\n');
    } else {
      const { stdout } = await run('bash', [
        path.join(repoRoot, 'deploy/bundle.sh'),
        'strip-compose',
        path.join(repoRoot, 'deploy/compose.yaml'),
      ]);
      writeFileSync(path.join(deploy, 'compose.yaml'), stdout);
    }
    return deploy;
  }

  async function configure(
    deploy: string,
    env: Record<string, string> = {},
  ): Promise<{ code: number; out: string; calls: string }> {
    let code = 0;
    let out = '';
    try {
      const r = await run(
        'bash',
        [
          path.join(deploy, 'configure.sh'),
          '--url=http://127.0.0.1:8099',
          '--admin-email=a@example.com',
        ],
        { env: { PATH: `${bin}:${nodeFreePath()}`, HOME: dir, ...env } },
      );
      out = r.stdout + r.stderr;
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      code = err.code ?? 1;
      out = (err.stdout ?? '') + (err.stderr ?? '');
    }
    const callsFile = path.join(dir, 'calls.txt');
    return { code, out, calls: existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : '' };
  }

  it('builds the migrate image itself in a checkout, then runs configure.mjs in it (G1)', async () => {
    stub('podman');
    const deploy = await layout(true);
    const { code, calls } = await configure(deploy);

    expect(code).toBe(0);
    const root = path.join(dir, 'root');
    expect(calls).toContain(
      `build -f ${root}/Dockerfile --target migrate -t repopulse/migrate:dev ${root}`,
    );
    const lines = calls.trim().split('\n');
    expect(lines.findIndex((l) => l.startsWith('build '))).toBeLessThan(
      lines.findIndex((l) => l.startsWith('run ')),
    );
  });

  it('in a bundle, a missing image is a "load the bundle" refusal and nothing is built', async () => {
    stub('podman');
    const deploy = await layout(false);
    const { code, out, calls } = await configure(deploy);

    expect(code).not.toBe(0);
    expect(out).toContain('podman load -i images/repopulse-images.tar');
    expect(calls).not.toContain('build ');
  });

  it('maps the operator with --userns=keep-id under rootless podman on Linux (G2)', async () => {
    stub('podman', { imagePresent: true, os: 'Linux' });
    const { code, calls } = await configure(await layout(true));
    const runLine = calls.split('\n').find((l) => l.startsWith('run '))!;

    expect(code).toBe(0);
    expect(runLine).toContain('--userns=keep-id');
    expect(runLine).not.toContain('--user ');
  });

  it('keeps --user uid:gid for docker, and for podman machine on macOS', async () => {
    const uid = String(process.getuid?.() ?? 0);
    stub('docker', { imagePresent: true });
    const docker = await configure(await layout(true), { RUNTIME: 'docker' });
    expect(docker.calls.split('\n').find((l) => l.startsWith('run '))).toContain(`--user ${uid}:`);

    rmSync(path.join(dir, 'calls.txt'), { force: true });
    rmSync(path.join(bin, 'docker'));
    stub('podman', { imagePresent: true, os: 'Darwin' });
    const mac = await configure(path.join(dir, 'root', 'deploy'));
    expect(mac.calls.split('\n').find((l) => l.startsWith('run '))).toContain(`--user ${uid}:`);
  });

  it('refuses to build under docker without buildx, naming the package (D2)', async () => {
    stub('docker', { buildxRc: 1 });
    const { code, out, calls } = await configure(await layout(true), { RUNTIME: 'docker' });

    expect(code).not.toBe(0);
    expect(out).toContain("Docker's buildx plugin is missing");
    expect(out).toContain('docker-buildx');
    expect(calls).not.toContain('build -f');
  });
});
