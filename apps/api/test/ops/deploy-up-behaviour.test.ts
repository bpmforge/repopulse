import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runtimeFreeSystemPath } from './runtime-free-path.js';

const run = promisify(execFile);
const repoRoot = new URL('../../../../', import.meta.url).pathname;
const upSh = path.join(repoRoot, 'deploy/up.sh');

// up.sh reads its configuration from the shell first and deploy/.env second
// (`env_value`). The suite loads the repo-root .env into process.env
// (vitest.config.ts imports dotenv/config), so in a developer's checkout their
// own ADMIN_EMAIL or PUBLIC_BASE_URL reached the script and overrode the
// fixture's deploy/.env: the SSO warning case failed there and passed in a
// clean clone. Every key up.sh reads that way is dropped from the inherited
// environment; a case that wants one passes it explicitly.
const UP_CONFIG_KEYS = [...readFileSync(upSh, 'utf8').matchAll(/env_value ([A-Z][A-Z0-9_]*)/g)].map(
  (m) => m[1]!,
);
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !UP_CONFIG_KEYS.includes(k)),
);

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
      /** W17-28: what `image exists <name>` answers. Default: present. */
      imagesPresent?: boolean;
      /** What `compose version` prints — podman-compose is told apart by it. */
      providerVersion?: string;
      /**
       * A stopped container from a previous compose provider listed FIRST for
       * every service (2026-10-28: docker-compose replaced podman-compose).
       */
      staleFirst?: boolean;
      /** W22-15: what `<runtime> version --format ...` prints (the Podman floor). */
      runtimeVersion?: string;
      /** W22-15: what `docker info` prints (a permission error is refused). */
      infoOut?: string;
      /** W22-15: exit status of `docker buildx version` (0 = installed). */
      buildxRc?: number;
      /** W22-15: seconds `compose up` blocks before answering (the timeout case). */
      composeUpSleep?: number;
      /** W22-13: what `logs <cid>` prints, for every container. */
      logsOut?: string;
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
    echo "${opts.providerVersion ?? 'stub compose 1.0'}"
    exit ${opts.providerRc ?? 0}
  fi
  # any 'compose ... up -d ...'; the arguments are kept for W20-16's overlay test.
  echo "$*" >> "${path.join(dir, 'compose-args.txt')}"
  ${opts.composeUpSleep ? `sleep ${opts.composeUpSleep}` : ''}
  echo "${opts.composeUpOut ?? 'stub: compose up ran'}"
  exit ${opts.composeUpRc ?? 0}
fi

if [ "$1" = "version" ]; then
  echo "${opts.runtimeVersion ?? '5.8.0'}"
  exit 0
fi

if [ "$1" = "info" ]; then
  echo "${opts.infoOut ?? 'stub info'}"
  exit 0
fi

if [ "$1" = "buildx" ]; then
  exit ${opts.buildxRc ?? 0}
fi

if [ "$1" = "build" ]; then
  # W22-15: up.sh builds the scan image itself in a checkout.
  echo "$*" >> "${path.join(dir, 'build-args.txt')}"
  exit 0
fi

if [ "$1" = "logs" ]; then
  echo "${opts.logsOut ?? 'stub logs'}"
  exit 0
fi

if [ "$1" = "image" ]; then
  # W17-28: 'image exists <name>' / 'image inspect <name>' in bundle mode.
  exit ${opts.imagesPresent === false ? 1 : 0}
fi

if [ "$1" = "ps" ]; then
  # up.sh filters by label=com.docker.compose.service=<svc>
  svc=""
  for a in "$@"; do
    case "$a" in label=com.docker.compose.service=*) svc="\${a##*=}";; esac
  done
  v="$(lookup "$svc")"
  ${opts.staleFirst ? '[ -n "$v" ] && echo "stale-$svc"' : ''}
  [ -n "$v" ] && echo "cid-$svc"
  exit 0
fi

if [ "$1" = "inspect" ]; then
  cid="$2"; svc="\${cid#cid-}"
  fmt="$4"
  case "$cid" in stale-*)
    case "$fmt" in *StartedAt*) echo "2026-10-27 08:00:00" ;; *ExitCode*) echo 137 ;; *Status*) echo exited ;; *) echo "" ;; esac
    exit 0 ;;
  esac
  v="$(lookup "$svc")"
  status="\${v%%:*}"; rest="\${v#*:}"; code="\${rest%%:*}"; health="\${rest#*:}"
  case "$fmt" in
    *Health.Status*|*State.Health*) [ "$health" = "none" ] && echo "" || echo "$health" ;;
    *StartedAt*) echo "2026-10-28 09:00:00" ;;
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
    opts: {
      withEnvFile?: boolean;
      envFile?: string;
      bin?: string;
      bundle?: boolean;
      /** W20-16: arguments to up.sh, and the CLI overlay copied beside it. */
      args?: string[];
      withCliOverlay?: boolean;
      /** W22-15: put a Containerfile.scan beside deploy/, as a checkout has. */
      withScanContainerfile?: boolean;
    } = {},
  ): Promise<{ code: number; out: string }> {
    const deployDir = path.join(dir, 'deploy');
    mkdirSync(deployDir, { recursive: true });
    // Copy the script under test next to a scratch .env; up.sh cd's to its own
    // directory, so this keeps every side effect inside the temp dir.
    await run('cp', [upSh, path.join(deployDir, 'up.sh')]);
    if (opts.bundle) {
      // W17-28: a bundle's compose file is the same file with no build:
      // stanzas, which is what puts up.sh into "images must be loaded" mode.
      const { stdout } = await run('bash', [
        path.join(repoRoot, 'deploy/bundle.sh'),
        'strip-compose',
        path.join(repoRoot, 'deploy/compose.yaml'),
      ]);
      writeFileSync(path.join(deployDir, 'compose.yaml'), stdout);
    } else {
      await run('cp', [
        path.join(repoRoot, 'deploy/compose.yaml'),
        path.join(deployDir, 'compose.yaml'),
      ]);
    }
    // W17-27: a real install always has SCAN_RUNNER_TOKEN (configure.mjs
    // generates it); the fixture mirrors that so the token refusal, tested on
    // its own below, does not mask the migrate/health behaviour under test.
    if (opts.withScanContainerfile) writeFileSync(path.join(dir, 'Containerfile.scan'), 'FROM scratch\n');
    if (opts.withCliOverlay) {
      await run('cp', [
        path.join(repoRoot, 'deploy/compose.claude-cli.yaml'),
        path.join(deployDir, 'compose.claude-cli.yaml'),
      ]);
    }
    if (opts.withEnvFile !== false)
      writeFileSync(
        path.join(deployDir, '.env'),
        opts.envFile ?? 'POSTGRES_USER=x\nSCAN_RUNNER_TOKEN=test-token-not-a-secret\n',
      );

    try {
      const { stdout, stderr } = await run(
        'bash',
        [path.join(deployDir, 'up.sh'), ...(opts.args ?? [])],
        {
          env: {
            ...inheritedEnv,
            PATH: `${opts.bin ?? path.join(dir, 'bin')}:${runtimeFreeSystemPath()}`,
            REPOPULSE_UP_TIMEOUT: '2',
            ...env,
          },
        },
      );
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
    // W17-27: the scan-runner sidecar is a long-running service up.sh verifies.
    'scan-runner': 'running:0:none',
    web: 'running:0:none',
  };

  it('refuses to start without deploy/.env, naming the fix', async () => {
    stubRuntime('podman', { services: allHealthy });
    const { code, out } = await runUp({}, { withEnvFile: false });

    expect(code).not.toBe(0);
    expect(out).toContain('deploy/.env is missing');
    expect(out).toContain('cp deploy/.env.example deploy/.env');
  });

  it('refuses to start without SCAN_RUNNER_TOKEN in .env, naming the fix (W17-27)', async () => {
    stubRuntime('podman', { services: allHealthy });
    const { code, out } = await runUp({}, { envFile: 'POSTGRES_USER=x\n' });

    expect(code).not.toBe(0);
    expect(out).toContain('SCAN_RUNNER_TOKEN is missing from deploy/.env');
    expect(out).toContain('deploy/configure.mjs');
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

  it('names an old Redis 7.4 volume when Valkey refuses it (W22-13)', { timeout: 20000 }, async () => {
    stubRuntime('podman', {
      services: { ...allHealthy, redis: 'exited:1:none' },
      logsOut: "# Can't handle RDB format version 12",
    });
    const { code, out } = await runUp({});

    expect(code).not.toBe(0);
    expect(out).toMatch(/not running:.*redis/);
    expect(out).toContain('written by Redis 7.4');
    expect(out).toContain('--rdb-version-check relaxed');
    expect(out).toContain('Do not delete');
  });

  it('says nothing about Redis 7.4 when redis fails for another reason', { timeout: 20000 }, async () => {
    stubRuntime('podman', {
      services: { ...allHealthy, redis: 'exited:1:none' },
      logsOut: 'Fatal error loading the DB: Permission denied',
    });
    const { code, out } = await runUp({});

    expect(code).not.toBe(0);
    expect(out).toMatch(/not running:.*redis/);
    expect(out).not.toContain('written by Redis 7.4');
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

  it(
    'waits for an unhealthy-but-starting service instead of failing instantly',
    { timeout: 20000 },
    async () => {
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
    },
  );

  // W20-16 (UX_TODO AI-74): the CLI overlay survives a plain restart.
  it('--with-claude-cli records the overlay in .env, and a later plain run keeps it', async () => {
    stubRuntime('podman', { services: allHealthy });
    const first = await runUp({}, { args: ['--with-claude-cli'], withCliOverlay: true });
    expect(first.code).toBe(0);
    const envText = readFileSync(path.join(dir, 'deploy', '.env'), 'utf8');
    expect(envText).toContain('COMPOSE_EXTRA_FILES=compose.claude-cli.yaml');
    expect(envText).toContain('SCAN_RUNNER_TOKEN=test-token-not-a-secret');

    // Second start: no flag; runUp writes back the .env the first run left.
    const second = await runUp({}, { withCliOverlay: true, envFile: envText });
    expect(second.code).toBe(0);
    const calls = readFileSync(path.join(dir, 'compose-args.txt'), 'utf8').trim().split('\n');
    const ups = calls.filter((c) => c.includes(' up -d'));
    expect(ups).toHaveLength(2);
    for (const c of ups) expect(c).toContain('-f compose.yaml -f compose.claude-cli.yaml');
    // The flag itself never reaches compose.
    expect(calls.join('\n')).not.toContain('--with-claude-cli');
  });

  // 2026-10-27 walkthrough: podman-compose 1.6 left api and worker running
  // with their old environment after deploy/.env gained NODE_EXTRA_CA_CERTS.
  it('recreates containers under podman-compose so a deploy/.env change applies', async () => {
    stubRuntime('podman', { services: allHealthy, providerVersion: 'podman-compose version 1.6.0' });
    expect((await runUp({})).code).toBe(0);
    const calls = readFileSync(path.join(dir, 'compose-args.txt'), 'utf8').trim().split('\n');
    const up = calls.find((c) => c.includes(' up -d'))!;
    expect(up).toContain('--force-recreate');
  });

  it('leaves recreation to docker compose, and to an explicit --no-recreate', async () => {
    stubRuntime('podman', { services: allHealthy, providerVersion: 'Docker Compose version v2.29.1' });
    expect((await runUp({})).code).toBe(0);
    stubRuntime('podman', { services: allHealthy, providerVersion: 'podman-compose version 1.6.0' });
    expect((await runUp({}, { args: ['--no-recreate'] })).code).toBe(0);
    const ups = readFileSync(path.join(dir, 'compose-args.txt'), 'utf8')
      .trim()
      .split('\n')
      .filter((c) => c.includes(' up -d'));
    expect(ups).toHaveLength(2);
    for (const c of ups) expect(c).not.toContain('--force-recreate');
  });

  it('checks the running container when a stopped one from another provider shares its labels', async () => {
    stubRuntime('podman', { services: allHealthy, staleFirst: true });
    const { code, out } = await runUp({});
    expect(out).toContain('All services running');
    expect(code).toBe(0);
  });

  it('refuses a COMPOSE_EXTRA_FILES entry that is not in deploy/', async () => {
    stubRuntime('podman', { services: allHealthy });
    const { code, out } = await runUp(
      {},
      { envFile: 'SCAN_RUNNER_TOKEN=t\nCOMPOSE_EXTRA_FILES=../evil.yaml\n' },
    );
    expect(code).not.toBe(0);
    expect(out).toContain('must be a file name inside deploy/');
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

  // W20-07 (UX_TODO INS-74): a first SSO sign-in is never made admin, so SSO
  // with no ADMIN_EMAIL is an install nobody can administer.
  it('warns when single sign-on is configured but ADMIN_EMAIL is empty', async () => {
    stubRuntime('podman', { services: allHealthy });
    const base = 'POSTGRES_USER=x\nSCAN_RUNNER_TOKEN=test-token-not-a-secret\n';
    const sso = await runUp({}, { envFile: `${base}OIDC_ISSUER=https://idp.example.com\n` });
    expect(sso.code).toBe(0);
    expect(sso.out).toContain('single sign-on is configured but ADMIN_EMAIL is empty');

    const withAdmin = await runUp(
      {},
      { envFile: `${base}OIDC_ISSUER=https://idp.example.com\nADMIN_EMAIL=a@example.com\n` },
    );
    expect(withAdmin.out).not.toContain('ADMIN_EMAIL is empty');
  });

  it('accepts an explicit RUNTIME=docker when docker is the one present', async () => {
    stubRuntime('docker', { services: allHealthy });
    const { code, out } = await runUp({ RUNTIME: 'docker' });

    expect(code).toBe(0);
    expect(out).toContain('runtime:    docker');
  });

  // W17-28: bundle mode. With no build: in compose.yaml the images must already
  // be loaded under the name .env pins, and up.sh says so BEFORE compose can
  // turn a missing image into a registry error.
  const bundleEnv = (extra = '') =>
    `POSTGRES_USER=x\nSCAN_RUNNER_TOKEN=test-token-not-a-secret\n${extra}`;

  it('bundle mode: refuses to run pre-built images without a pinned version', async () => {
    stubRuntime('podman', { services: allHealthy });
    const { code, out } = await runUp({}, { bundle: true, envFile: bundleEnv() });

    expect(code).not.toBe(0);
    expect(out).toContain("REPOPULSE_VERSION is 'unset' in deploy/.env");
    expect(out).not.toContain('compose up ran');
  });

  it('bundle mode: refuses when the pinned images are not loaded, naming them and the fix', async () => {
    stubRuntime('podman', { services: allHealthy, imagesPresent: false });
    const { code, out } = await runUp(
      {},
      {
        bundle: true,
        envFile: bundleEnv('REPOPULSE_VERSION=1.2.3\nREPOPULSE_IMAGE_PREFIX=localhost/repopulse\n'),
      },
    );

    expect(code).not.toBe(0);
    expect(out).toContain('IMAGES NOT LOADED');
    expect(out).toContain('localhost/repopulse/api:1.2.3');
    expect(out).toContain('podman load -i images/repopulse-images.tar');
    expect(out).not.toContain('compose up ran');
  });

  it('bundle mode: starts when every pinned image is present', async () => {
    stubRuntime('podman', { services: allHealthy });
    const { code, out } = await runUp(
      {},
      {
        bundle: true,
        envFile: bundleEnv('REPOPULSE_VERSION=1.2.3\nREPOPULSE_IMAGE_PREFIX=localhost/repopulse\n'),
      },
    );

    expect(code).toBe(0);
    expect(out).toContain('images:     localhost/repopulse/*:1.2.3 (all present)');
    expect(out).toContain('All services running');
  });

  // W22-15 (2026-10-31 fresh Ubuntu 24.04): Podman 4.9 never starts api, and
  // podman-compose 1.0.6 overrides up.sh's mounts and prints secrets. Both are
  // refused by version before compose is called.
  it('refuses Podman older than 5 with a sentence, before calling compose (W22-15)', async () => {
    stubRuntime('podman', { services: allHealthy, runtimeVersion: '4.9.3' });
    const { code, out } = await runUp({});

    expect(code).not.toBe(0);
    expect(out).toContain('Podman 4.9.3 is too old: RepoPulse needs Podman 5 or newer');
    expect(out).toContain('Ubuntu 26.04');
    expect(out).not.toContain('compose up ran');
  });

  it('refuses podman-compose older than 1.5, in either spelling of its version line (W22-15)', async () => {
    stubRuntime('podman', {
      services: allHealthy,
      providerVersion: 'podman-compose version: 1.0.6\npodman-compose version 1.0.6',
    });
    const { code, out } = await runUp({});

    expect(code).not.toBe(0);
    expect(out).toContain('podman-compose 1.0.6 is too old');
    expect(out).toContain('print every password');
    expect(out).not.toContain('compose up ran');
  });

  it('accepts Podman 5 with podman-compose 1.5 (W22-15)', async () => {
    stubRuntime('podman', {
      services: allHealthy,
      runtimeVersion: '5.7.0',
      providerVersion: 'podman-compose version 1.5.0',
    });
    const { code, out } = await runUp({});

    expect(code).toBe(0);
    expect(out).toContain('All services running');
  });

  it('refuses Docker without buildx in a checkout, naming the package (W22-15)', async () => {
    stubRuntime('docker', { services: allHealthy, buildxRc: 1 });
    const { code, out } = await runUp({ RUNTIME: 'docker' });

    expect(code).not.toBe(0);
    expect(out).toContain("Docker's buildx plugin is missing");
    expect(out).toContain('docker-buildx');
    expect(out).not.toContain('compose up ran');
  });

  it('names the docker group and a new login when the socket is refused (W22-15)', async () => {
    stubRuntime('docker', {
      services: allHealthy,
      infoOut: 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock',
    });
    const { code, out } = await runUp({ RUNTIME: 'docker' });

    expect(code).not.toBe(0);
    expect(out).toContain('sudo usermod -aG docker');
    expect(out).toContain('NEW login session');
  });

  it('builds the scan image in a checkout on --build, under the name compose gives scan-runner (W22-15)', async () => {
    stubRuntime('podman', { services: allHealthy });
    const { code } = await runUp({}, { args: ['--build'], withScanContainerfile: true });

    expect(code).toBe(0);
    const builds = readFileSync(path.join(dir, 'build-args.txt'), 'utf8');
    expect(builds).toContain('build -f ../Containerfile.scan -t repopulse/scan:dev ..');
  });

  it('builds a missing scan image in a checkout even without --build (W22-15)', async () => {
    stubRuntime('podman', { services: allHealthy, imagesPresent: false });
    const { code } = await runUp({}, { withScanContainerfile: true });

    expect(code).toBe(0);
    expect(readFileSync(path.join(dir, 'build-args.txt'), 'utf8')).toContain('Containerfile.scan');
  });

  // P3: on Podman 4.9 compose never returned, so the post-compose timeout never
  // ran. `timeout` is coreutils; stock macOS has none and the call stays unbounded.
  const hasTimeout = (() => {
    try {
      readFileSync(path.join(runtimeFreeSystemPath(), 'timeout'));
      return true;
    } catch {
      return false;
    }
  })();
  it.runIf(hasTimeout)(
    'ends a compose up that never returns, and says so (W22-15)',
    { timeout: 20000 },
    async () => {
      stubRuntime('podman', { services: allHealthy, composeUpSleep: 30 });
      const started = Date.now();
      const { code, out } = await runUp({ REPOPULSE_COMPOSE_TIMEOUT: '2' });

      expect(code).not.toBe(0);
      expect(out).toContain('did not return within 2s and was stopped');
      expect(Date.now() - started).toBeLessThan(15000);
    },
  );

  it('never uses a destructive down -v anywhere in the script', async () => {
    const script = await run('cat', [upSh]);
    expect(script.stdout).not.toMatch(/down\s+(-v|--volumes)/);
  });
});
