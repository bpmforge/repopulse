import { execFile } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const repoRoot = new URL('../../../../', import.meta.url).pathname;

/**
 * deploy/restore.sh, deploy/backup.sh and scripts/drill-backup-restore.sh
 * refusal paths (W17-29).
 *
 * Everything here is a decision the scripts make BEFORE touching a container
 * runtime: which project they will restore into, whether the key is usable,
 * whether the dump matches its manifest. Those are the cases where a wrong
 * answer destroys the live database or "succeeds" into undecryptable
 * credentials, so they are pinned with a stub runtime that RECORDS every call
 * and answers nothing — a refusal that has already called `compose rm` is not
 * a refusal. The live path (dump, load, in-image decrypt, migration failure,
 * recovery) is the drill script, recorded in
 * docs/work/product-completion/evidence/w17-29-backup-restore-drill-*.md.
 */
describe('deploy/restore.sh + backup.sh refusals (W17-29)', () => {
  let dir: string;
  let deployDir: string;
  let callsFile: string;
  let bin: string;
  const GOOD_KEY = 'a'.repeat(64);

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'rp restore-'));
    deployDir = path.join(dir, 'deploy');
    mkdirSync(deployDir, { recursive: true });
    for (const f of ['restore.sh', 'backup.sh', 'scan-db-sync.sh', 'compose.yaml']) {
      await run('cp', [path.join(repoRoot, 'deploy', f), path.join(deployDir, f)]);
    }
    // A stub `podman` that logs its argv and fails: any runtime call at all
    // during a refusal is itself the defect under test.
    bin = path.join(dir, 'bin');
    mkdirSync(bin);
    callsFile = path.join(dir, 'calls.txt');
    const stub = `#!/usr/bin/env bash\necho "$*" >> "${callsFile}"\nexit 1\n`;
    writeFileSync(path.join(bin, 'podman'), stub);
    chmodSync(path.join(bin, 'podman'), 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeEnv(overrides: Record<string, string> = {}): void {
    const vars: Record<string, string> = {
      POSTGRES_PASSWORD: 'pw',
      TOKEN_ENC_KEY: GOOD_KEY,
      REPOPULSE_VERSION: '0.0.0-test',
      ...overrides,
    };
    writeFileSync(
      path.join(deployDir, '.env'),
      Object.entries(vars)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n',
    );
  }

  function writeDump(
    name = 'dump.sql',
    body = '-- dump\nPostgreSQL database dump complete\n',
  ): string {
    const p = path.join(dir, name);
    writeFileSync(p, body);
    return p;
  }

  async function sh(
    script: 'restore.sh' | 'backup.sh' | 'scan-db-sync.sh',
    args: string[],
    env: Record<string, string> = {},
  ): Promise<{ code: number; out: string }> {
    try {
      const { stdout, stderr } = await run(path.join(deployDir, script), args, {
        cwd: deployDir,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: dir,
          ...env,
        },
      });
      return { code: 0, out: stdout + stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
    }
  }

  const runtimeCalls = (): string => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : '');

  describe('target project (acceptance 4)', () => {
    it('refuses when no project is given, before any runtime call', async () => {
      writeEnv();
      const dump = writeDump();
      const r = await sh('restore.sh', ['--yes', dump]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('RESTORE REFUSED: no target project');
      expect(r.out).toContain('--project=<name>');
      expect(runtimeCalls()).toBe('');
    });

    it('refuses the live project name without --production', async () => {
      writeEnv();
      const dump = writeDump();
      const r = await sh('restore.sh', ['--project=repopulse', '--yes', dump]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('--project=repopulse is the live install');
      expect(r.out).toContain('--production');
      expect(runtimeCalls()).toBe('');
    });

    it('REPOPULSE_PROJECT=repopulse in the environment is refused the same way', async () => {
      writeEnv();
      const dump = writeDump();
      const r = await sh('restore.sh', ['--yes', dump], { REPOPULSE_PROJECT: 'repopulse' });
      expect(r.code).toBe(1);
      expect(r.out).toContain('is the live install');
    });

    it('--production opens the gate for the live project (then proceeds to the next check)', async () => {
      writeEnv();
      // No dump argument, so the next thing it can fail on is usage — which
      // proves the target check was passed, not that anything ran.
      const r = await sh('restore.sh', ['--project=repopulse', '--production', '--yes']);
      expect(r.code).toBe(1);
      expect(r.out).not.toContain('is the live install');
      expect(r.out).toContain('usage: restore.sh');
    });

    it('any other explicit project passes the target check', async () => {
      writeEnv();
      const r = await sh('restore.sh', ['--project=rp-verify', '--yes']);
      expect(r.out).not.toContain('RESTORE REFUSED');
      expect(r.out).toContain('usage: restore.sh');
    });
  });

  describe('TOKEN_ENC_KEY (acceptance 2)', () => {
    it('missing key is refused before anything is stopped or dropped', async () => {
      writeEnv({ TOKEN_ENC_KEY: '' });
      const dump = writeDump();
      const r = await sh('restore.sh', ['--project=rp-verify', '--yes', dump]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('RESTORE REFUSED: TOKEN_ENC_KEY is not set');
      expect(runtimeCalls()).toBe('');
    });

    it('a key of the wrong length is refused, and its value is not echoed', async () => {
      const shortKey = 'b'.repeat(62);
      writeEnv({ TOKEN_ENC_KEY: shortKey });
      const dump = writeDump();
      const r = await sh('restore.sh', ['--project=rp-verify', '--yes', dump]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('62 characters');
      expect(r.out).not.toContain(shortKey);
      expect(runtimeCalls()).toBe('');
    });

    it('a non-hex key is refused', async () => {
      writeEnv({ TOKEN_ENC_KEY: 'z'.repeat(64) });
      const dump = writeDump();
      const r = await sh('restore.sh', ['--project=rp-verify', '--yes', dump]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('is not hex');
      expect(runtimeCalls()).toBe('');
    });

    it('backup.sh refuses to dump under a missing key', async () => {
      writeEnv({ TOKEN_ENC_KEY: '' });
      const r = await sh('backup.sh', ['--project=rp-verify']);
      expect(r.code).toBe(1);
      expect(r.out).toContain('BACKUP REFUSED');
      expect(runtimeCalls()).toBe('');
    });
  });

  // INS-67: the fetching containers get the outbound proxy from deploy/.env.
  it('scan-db-sync.sh passes HTTPS_PROXY / NO_PROXY from .env into the fetch container', async () => {
    writeEnv({
      SCAN_RULES_DIR: path.join(dir, 'scan-rules'),
      HTTPS_PROXY: 'http://proxy.test:3128',
      NO_PROXY: 'api,scan-runner',
    });
    await sh('scan-db-sync.sh', []);
    const calls = runtimeCalls();
    expect(calls).toContain('run --rm --user 0:0 -e GRYPE_DB_CACHE_DIR=/db');
    expect(calls).toContain('-e HTTPS_PROXY=http://proxy.test:3128');
    expect(calls).toContain('-e https_proxy=http://proxy.test:3128');
    expect(calls).toContain('-e NO_PROXY=api,scan-runner');
  });

  // INS-65: root's podman cannot see a rootless install's containers or images,
  // so a nightly job in root's crontab failed every night. Both scripts now
  // refuse up front when run as root over an install another user owns. Only
  // testable when this suite itself runs as root (chown needs it).
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  describe.runIf(asRoot)('refuses to run as root over a rootless install (INS-65)', () => {
    it('backup.sh refuses, names the owner, and calls no runtime', async () => {
      writeEnv();
      chownSync(path.join(deployDir, '.env'), 65534, 65534);
      const r = await sh('backup.sh', ['--project=rp-verify']);
      expect(r.code).toBe(1);
      expect(r.out).toContain('BACKUP REFUSED: running as root');
      expect(r.out).toContain('crontab');
      expect(runtimeCalls()).toBe('');
    });

    it('scan-db-sync.sh refuses the same way, before writing anything', async () => {
      writeEnv({ SCAN_RULES_DIR: path.join(dir, 'scan-rules') });
      chownSync(path.join(deployDir, '.env'), 65534, 65534);
      const r = await sh('scan-db-sync.sh', []);
      expect(r.code).toBe(1);
      expect(r.out).toContain('REFUSED: running as root');
      expect(existsSync(path.join(dir, 'scan-rules'))).toBe(false);
      expect(runtimeCalls()).toBe('');
    });

    it('REPOPULSE_ALLOW_ROOT=1 opens the gate for a rootful install', async () => {
      writeEnv();
      chownSync(path.join(deployDir, '.env'), 65534, 65534);
      const r = await sh('backup.sh', ['--project=rp-verify'], { REPOPULSE_ALLOW_ROOT: '1' });
      expect(r.out).not.toContain('running as root');
      // The stub runtime answers nothing, so it now fails on the container lookup.
      expect(r.out).toContain('postgres container is not running');
    });
  });

  describe('manifest (acceptance 1 + 2)', () => {
    const sha256 = async (file: string): Promise<string> => {
      const { stdout } = await run('shasum', ['-a', '256', file]);
      return stdout.split(' ')[0]!;
    };

    it('refuses a dump whose sha256 differs from its manifest', async () => {
      writeEnv();
      const dump = writeDump();
      writeFileSync(
        `${dump}.manifest`,
        `REPOPULSE_BACKUP_FORMAT=1\nDUMP_SHA256=${'0'.repeat(64)}\n`,
      );
      const r = await sh('restore.sh', ['--project=rp-verify', '--yes', dump]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('does not match the sha256');
      expect(runtimeCalls()).toBe('');
    });

    it('refuses a key whose fingerprint differs from the manifest, naming both fingerprints and neither key', async () => {
      writeEnv();
      const dump = writeDump();
      const sha = await sha256(dump);
      writeFileSync(
        `${dump}.manifest`,
        `REPOPULSE_BACKUP_FORMAT=1\nDUMP_SHA256=${sha}\nTOKEN_ENC_KEY_FINGERPRINT=sha256:0123456789abcdef\n`,
      );
      const r = await sh('restore.sh', ['--project=rp-verify', '--yes', dump]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('not the key this dump was taken under');
      expect(r.out).toContain('sha256:0123456789abcdef');
      expect(r.out).not.toContain(GOOD_KEY);
      expect(runtimeCalls()).toBe('');
    });

    it('a matching manifest gets past both checks to the runtime', async () => {
      writeEnv();
      const dump = writeDump();
      const sha = await sha256(dump);
      // The fingerprint restore.sh computes for GOOD_KEY: sha256 of the hex
      // string, first 16 hex chars — computed here the same way, so the test
      // pins the format the two scripts share.
      const { stdout } = await run('bash', [
        '-c',
        `printf '%s' '${GOOD_KEY}' | shasum -a 256 | cut -c1-16`,
      ]);
      const fp = `sha256:${stdout.trim()}`;
      writeFileSync(
        `${dump}.manifest`,
        `REPOPULSE_BACKUP_FORMAT=1\nDUMP_SHA256=${sha}\nTOKEN_ENC_KEY_FINGERPRINT=${fp}\nROWS_WORKSPACES=1\n`,
      );
      const r = await sh('restore.sh', ['--project=rp-verify', '--yes', dump]);
      expect(r.out).toContain('key fingerprint');
      expect(r.out).toContain('matches');
      // First runtime call is stopping the app containers of THAT project —
      // with -p, which the W11-03 script lacked (it stopped the live install's).
      expect(runtimeCalls()).toContain('compose -p rp-verify');
      expect(runtimeCalls()).not.toContain('-p repopulse');
    });
  });
});

describe('scripts/drill-backup-restore.sh refusals (W17-29)', () => {
  const drill = path.join(repoRoot, 'scripts/drill-backup-restore.sh');

  async function drillRun(args: string[]): Promise<{ code: number; out: string }> {
    try {
      const { stdout, stderr } = await run(drill, args, {
        env: { PATH: '/usr/bin:/bin', HOME: tmpdir() },
      });
      return { code: 0, out: stdout + stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
    }
  }

  it('refuses when source or target is unspecified', async () => {
    const r = await drillRun(['--version=0.0.0']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('--source= and --target= are both required');
  });

  it('refuses the live project as either side, with no override', async () => {
    for (const args of [
      ['--source=repopulse', '--target=x', '--version=0.0.0'],
      ['--source=x', '--target=repopulse', '--version=0.0.0'],
    ]) {
      const r = await drillRun(args);
      expect(r.code).toBe(2);
      expect(r.out).toContain("'repopulse' is the live install");
      expect(r.out).toContain('no flag');
    }
  });

  it('refuses identical projects and floating tags', async () => {
    expect((await drillRun(['--source=a', '--target=a', '--version=0.0.0'])).out).toContain(
      'must differ',
    );
    expect((await drillRun(['--source=a', '--target=b', '--version=latest'])).out).toContain(
      'floating tag',
    );
    expect((await drillRun(['--source=a', '--target=b'])).out).toContain('--version= is required');
  });
});
