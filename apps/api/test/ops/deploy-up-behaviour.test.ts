import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const repoRoot = new URL('../../../../', import.meta.url).pathname;
const upSh = path.join(repoRoot, 'deploy/up.sh');

/**
 * deploy/up.sh behaviour (W17-04).
 *
 * RP-04 requires testing missing env, missing runtime, migration failure, worker
 * exit, port collision, paths containing spaces and a successful start. Doing
 * that against real containers would take minutes per case and could not
 * simulate a failed migration without breaking a migration.
 *
 * So the RUNTIME BINARY is stubbed: a shell script on PATH named `podman` or
 * `docker` that answers `compose`, `ps` and `inspect` from a scenario file. That
 * is the whole surface up.sh uses, and it lets every branch be driven exactly.
 * It proves the script's decision logic, NOT that podman works — the live
 * container start is a separate check, recorded in W17-04's evidence.
 */
describe('deploy/up.sh behaviour (W17-04)', () => {
  let dir: string;

  beforeEach(() => {
    // A space in the path on purpose: RP-04 lists it as an acceptance case, and
    // an unquoted expansion anywhere in the script dies here.
    dir = mkdtempSync(path.join(tmpdir(), 'rp up-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Write a fake runtime onto PATH.
   *
   * `services` maps a compose service to `status:exitcode:health`. An absent
   * service means the container does not exist at all.
   */
  function stubRuntime(
    name: 'podman' | 'docker',
    opts: {
      services: Record<string, string>;
      composeUpRc?: number;
      composeUpOut?: string;
      providerRc?: number;
    },
  ): string {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    // Encoded as `service=status:code:health` lines the stub greps.
    const table = Object.entries(opts.services)
      .map(([svc, v]) => `${svc}=${v}`)
      .join('\n');
    writeFileSync(path.join(dir, 'services.txt'), `${table}\n`);

    const script = `#!/usr/bin/env bash
TABLE="${path.join(dir, 'services.txt')}"

lookup() { grep -m1 "^$1=" "$TABLE" 2>/dev/null | cut -d= -f2; }

if [ "$1" = "compose" ]; then
  shift
  if [ "$1" = "version" ]; then
    echo "stub compose 1.0"
    exit ${opts.providerRc ?? 0}
  fi
  # any 'compose ... up -d ...'
  echo "${opts.composeUpOut ?? 'stub: compose up ran'}"
  exit ${opts.composeUpRc ?? 0}
fi

if [ "$1" = "ps" ]; then
  # up.sh filters by label=com.docker.compose.service=<svc>
  svc=""
  for a in "$@"; do
    case "$a" in label=com.docker.compose.service=*) svc="\${a##*=}";; esac
  done
  v="$(lookup "$svc")"
  [ -n "$v" ] && echo "cid-$svc"
  exit 0
fi

if [ "$1" = "inspect" ]; then
  cid="$2"; svc="\${cid#cid-}"
  fmt="$4"
  v="$(lookup "$svc")"
  status="\${v%%:*}"; rest="\${v#*:}"; code="\${rest%%:*}"; health="\${rest#*:}"
  case "$fmt" in
    *Health.Status*|*State.Health*) [ "$health" = "none" ] && echo "" || echo "$health" ;;
    *ExitCode*) echo "$code" ;;
    *Status*) echo "$status" ;;
    *) echo "" ;;
  esac
  exit 0
fi

echo "stub: unhandled $*" >&2
exit 1
`;
    const p = path.join(bin, name);
    writeFileSync(p, script);
    chmodSync(p, 0o755);
    return bin;
  }

  /** Run up.sh with a scratch deploy dir so the repo's own .env is untouched. */
  async function runUp(
    env: Record<string, string>,
    opts: { withEnvFile?: boolean; bin?: string } = {},
  ): Promise<{ code: number; out: string }> {
    const deployDir = path.join(dir, 'deploy');
    mkdirSync(deployDir, { recursive: true });
    // Copy the script under test next to a scratch .env; up.sh cd's to its own
    // directory, so this keeps every side effect inside the temp dir.
    await run('cp', [upSh, path.join(deployDir, 'up.sh')]);
    await run('cp', [
      path.join(repoRoot, 'deploy/compose.yaml'),
      path.join(deployDir, 'compose.yaml'),
    ]);
    if (opts.withEnvFile !== false)
      writeFileSync(path.join(deployDir, '.env'), 'POSTGRES_USER=x\n');

    try {
      const { stdout, stderr } = await run('bash', [path.join(deployDir, 'up.sh')], {
        env: {
          ...process.env,
          PATH: `${opts.bin ?? path.join(dir, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
          REPOPULSE_UP_TIMEOUT: '2',
          ...env,
        },
      });
      return { code: 0, out: stdout + stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
    }
  }

  const allHealthy = {
    migrate: 'exited:0:none',
    postgres: 'running:0:healthy',
    redis: 'running:0:healthy',
    api: 'running:0:none',
    worker: 'running:0:none',
    web: 'running:0:none',
  };

  it('refuses to start without deploy/.env, naming the fix', async () => {
    stubRuntime('podman', { services: allHealthy });
    const { code, out } = await runUp({}, { withEnvFile: false });

    expect(code).not.toBe(0);
    expect(out).toContain('deploy/.env is missing');
    expect(out).toContain('cp deploy/.env.example deploy/.env');
  });

  it('rejects an unknown RUNTIME instead of silently detecting one', async () => {
    stubRuntime('podman', { services: allHealthy });
    const { code, out } = await runUp({ RUNTIME: 'containerd' });

    expect(code).not.toBe(0);
    expect(out).toMatch(/RUNTIME must be 'docker' or 'podman'/);
  });

  it('fails when the REQUESTED runtime is absent, rather than falling back', async () => {
    // Only podman is stubbed; asking for docker must be an error, not a
    // silent switch to the one that happens to be installed.
    stubRuntime('podman', { services: allHealthy });
    const { code, out } = await runUp({ RUNTIME: 'docker' });

    expect(code).not.toBe(0);
    expect(out).toContain("RUNTIME=docker was requested but 'docker' is not on PATH");
  });

  it('fails when no runtime at all is on PATH', async () => {
    const emptyBin = path.join(dir, 'empty-bin');
    mkdirSync(emptyBin, { recursive: true });
    const { code, out } = await runUp({}, { bin: emptyBin });

    expect(code).not.toBe(0);
    expect(out).toContain('Neither podman nor docker is on PATH');
  });

  it('fails when the runtime exists but its compose provider does not', async () => {
    // The exact gap `command -v podman` cannot see.
    stubRuntime('podman', { services: allHealthy, providerRc: 1 });
    const { code, out } = await runUp({});

    expect(code).not.toBe(0);
    expect(out).toMatch(/is not usable on this host/);
  });

  it('treats a FAILED migration as fatal, not as a completed one-shot job', async () => {
    // The defect this case exists for: "exited" was previously success, so a
    // migration that exited 1 produced a healthy-looking stack on a schema that
    // was never applied.
    stubRuntime('podman', {
      services: { ...allHealthy, migrate: 'exited:1:none' },
    });
    const { code, out } = await runUp({});

    expect(code).not.toBe(0);
    expect(out).toContain('DATABASE MIGRATION FAILED');
    expect(out).toContain('exit 1');
  });

  it('reports a dead worker rather than a healthy stack', { timeout: 20000 }, async () => {
    stubRuntime('podman', {
      services: { ...allHealthy, worker: 'exited:1:none' },
    });
    const { code, out } = await runUp({});

    expect(code).not.toBe(0);
    expect(out).toContain('STACK IS NOT HEALTHY');
    expect(out).toMatch(/not running:.*worker/);
  });

  it('surfaces the real compose error when compose itself fails', { timeout: 20000 }, async () => {
    // `|| true` used to discard exactly this.
    stubRuntime('podman', {
      services: { ...allHealthy, web: 'exited:125:none' },
      composeUpRc: 125,
      composeUpOut: 'Error: statfs /var/lib/repopulse/scan-rules: no such file or directory',
    });
    const { code, out } = await runUp({});

    expect(code).not.toBe(0);
    expect(out).toContain('statfs /var/lib/repopulse/scan-rules');
    expect(out).toContain('compose exited 125');
  });

  it('waits for an unhealthy-but-starting service instead of failing instantly', { timeout: 20000 }, async () => {
    // postgres declares a healthcheck; "starting" must not count as up, and must
    // not be judged on the first inspect either.
    stubRuntime('podman', {
      services: { ...allHealthy, postgres: 'running:0:starting' },
    });
    const started = Date.now();
    const { code, out } = await runUp({ REPOPULSE_UP_TIMEOUT: '3' });
    const elapsed = Date.now() - started;

    expect(code).not.toBe(0);
    expect(out).toMatch(/not running:.*postgres/);
    // It actually waited rather than giving up on the first look.
    expect(elapsed).toBeGreaterThan(2500);
  });

  it('starts cleanly, from a path containing a space, and honours the project name', async () => {
    stubRuntime('podman', { services: allHealthy });
    const { code, out } = await runUp({ REPOPULSE_PROJECT: 'rp-test-xyz' });

    expect(code).toBe(0);
    expect(out).toContain('All services running');
    expect(out).toContain('compose project: rp-test-xyz');
    // The temp dir name contains a space; getting here at all proves no
    // unquoted expansion split it.
    expect(dir).toContain(' ');
  });

  it('accepts an explicit RUNTIME=docker when docker is the one present', async () => {
    stubRuntime('docker', { services: allHealthy });
    const { code, out } = await runUp({ RUNTIME: 'docker' });

    expect(code).toBe(0);
    expect(out).toContain('runtime:    docker');
  });

  it('never uses a destructive down -v anywhere in the script', async () => {
    const script = await run('cat', [upSh]);
    expect(script.stdout).not.toMatch(/down\s+(-v|--volumes)/);
  });
});
