import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const repoRoot = new URL('../../../../', import.meta.url).pathname;
const bundleSh = path.join(repoRoot, 'deploy/bundle.sh');
const installSh = path.join(repoRoot, 'deploy/bundle/install.sh');
const composeYaml = path.join(repoRoot, 'deploy/compose.yaml');

/**
 * deploy/bundle.sh and the install.sh it ships (W17-28).
 *
 * The bundle proper — images saved, loaded, and the stack smoked on a host
 * without the repository — is evidence, not a unit test (see
 * docs/work/product-completion/evidence/w17-28-*). What CAN be pinned here is
 * every decision the scripts make BEFORE a runtime is involved: the compose
 * rewrite, the version refusals, and install.sh's checksum and architecture
 * gates. Each one is a way a customer install fails early with a sentence
 * instead of late with a stack that looks up.
 */
describe('deploy/bundle.sh (W17-28)', () => {
  let dir: string;
  let emptyBin: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rp bundle-'));
    // A PATH with no container runtime on it, so any test that reaches
    // runtime detection fails there, visibly, rather than touching podman.
    emptyBin = path.join(dir, 'empty-bin');
    mkdirSync(emptyBin, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function sh(
    script: string,
    args: string[],
    env: Record<string, string> = {},
  ): Promise<{ code: number; out: string }> {
    try {
      const { stdout, stderr } = await run('bash', [script, ...args], {
        env: {
          ...process.env,
          PATH: `${emptyBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          REPOPULSE_VERSION: '',
          ...env,
        },
      });
      return { code: 0, out: stdout + stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
    }
  }

  describe('strip-compose', () => {
    it('removes every build: stanza and nothing else', async () => {
      const { code, out } = await sh(bundleSh, ['strip-compose', composeYaml]);
      expect(code).toBe(0);

      const original = readFileSync(composeYaml, 'utf8').split('\n');
      const stripped = out.split('\n');

      // No build anywhere: the bundle has no source to build from.
      expect(stripped.some((l) => /^\s*build:/.test(l))).toBe(false);
      expect(
        original.some((l) => /^\s*build:/.test(l)),
        'compose.yaml no longer has build: stanzas — is this test still needed?',
      ).toBe(true);

      // Everything that was removed is a build key or one of its children, in
      // order — comments, images, volumes and security options all survive
      // byte for byte.
      let j = 0;
      const removed: string[] = [];
      for (const line of original) {
        if (stripped[j] === line) {
          j += 1;
        } else {
          removed.push(line);
        }
      }
      expect(j, 'stripped output is not a subsequence of the original').toBe(stripped.length);
      expect(removed.length).toBeGreaterThan(0);
      for (const line of removed) {
        expect(line).toMatch(/^ {4}build:\s*$|^ {6}(context|dockerfile|target):/);
      }

      // Every service still names its image, so compose can start it from
      // what was loaded rather than trying to build.
      const services = (text: string[]) => text.filter((l) => /^ {2}[a-z-]+:\s*$/.test(l));
      expect(services(stripped)).toEqual(services(original));
      expect(stripped.filter((l) => /^ {4}image: /.test(l)).length).toBe(
        original.filter((l) => /^ {4}image: /.test(l)).length,
      );
    });
  });

  describe('version tag', () => {
    it('is required — there is no default to fall back to', async () => {
      const { code, out } = await sh(bundleSh, []);
      expect(code).not.toBe(0);
      expect(out).toContain('--version is required');
      // Refused BEFORE runtime detection: the empty PATH never came up.
      expect(out).not.toContain('Neither podman nor docker');
    });

    it.each(['dev', 'latest', 'demo'])('refuses the floating tag %s', async (tag) => {
      const { code, out } = await sh(bundleSh, [`--version=${tag}`]);
      expect(code).not.toBe(0);
      expect(out).toContain(`--version=${tag} is not a release tag`);
    });

    it('refuses a tag that is not an image tag', async () => {
      const { code, out } = await sh(bundleSh, ['--version=v1.0/beta']);
      expect(code).not.toBe(0);
      expect(out).toContain('not a valid image tag');
    });

    it('refuses an --arch it cannot build for, before touching a runtime', async () => {
      const { code, out } = await sh(bundleSh, ['--version=0.1.0-rc1', '--arch=sparc']);
      expect(code).not.toBe(0);
      expect(out).toContain('--arch=sparc is not supported');
    });

    it('accepts a release tag and then needs a runtime, in that order', async () => {
      const { code, out } = await sh(bundleSh, ['--version=0.1.0-rc1']);
      expect(code).not.toBe(0);
      expect(out).toContain('Neither podman nor docker is on PATH');
    });
  });
});

describe('bundle install.sh (W17-28)', () => {
  let dir: string;
  let emptyBin: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rp install-'));
    emptyBin = path.join(dir, 'empty-bin');
    mkdirSync(emptyBin, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Lay out a minimal extracted bundle: VERSION, manifest, one file, sums. */
  async function fakeBundle(opts: { platform?: string; corrupt?: boolean } = {}): Promise<string> {
    const b = path.join(dir, 'bundle');
    mkdirSync(path.join(b, 'images'), { recursive: true });
    writeFileSync(
      path.join(b, 'VERSION'),
      [
        'REPOPULSE_VERSION=9.9.9',
        'REPOPULSE_IMAGE_PREFIX=localhost/repopulse',
        `PLATFORM=${opts.platform ?? `linux/${process.arch}`}`,
        'GIT_SHA=deadbeef',
        'GIT_DIRTY=false',
        'BUILT_AT=2026-09-10T00:00:00Z',
        '',
      ].join('\n'),
    );
    writeFileSync(path.join(b, 'manifest.json'), '{}\n');
    writeFileSync(path.join(b, 'images/repopulse-images.tar'), 'not really an archive\n');
    const { stdout } = await run(
      'bash',
      ['-c', 'find . -type f -print0 | sort -z | xargs -0 shasum -a 256'],
      {
        cwd: b,
      },
    );
    writeFileSync(path.join(b, 'SHA256SUMS'), stdout);
    if (opts.corrupt) writeFileSync(path.join(b, 'images/repopulse-images.tar'), 'truncated\n');
    const target = path.join(b, 'install.sh');
    writeFileSync(target, readFileSync(installSh));
    chmodSync(target, 0o755);
    return b;
  }

  async function install(
    bundle: string,
    env: Record<string, string> = {},
  ): Promise<{ code: number; out: string }> {
    try {
      const { stdout, stderr } = await run(
        'bash',
        [path.join(bundle, 'install.sh'), '--url=http://x'],
        {
          env: { ...process.env, PATH: `${emptyBin}:/usr/bin:/bin:/usr/sbin:/sbin`, ...env },
        },
      );
      return { code: 0, out: stdout + stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
    }
  }

  it('refuses a directory that is not an extracted bundle', async () => {
    const b = path.join(dir, 'not-a-bundle');
    mkdirSync(b);
    writeFileSync(path.join(b, 'install.sh'), readFileSync(installSh));
    const { code, out } = await install(b);
    expect(code).not.toBe(0);
    expect(out).toContain('does not look like an extracted RepoPulse bundle');
  });

  it('refuses a bundle whose checksums do not match, before loading anything', async () => {
    const b = await fakeBundle({ corrupt: true });
    const { code, out } = await install(b);
    expect(code).not.toBe(0);
    expect(out).toContain('CHECKSUM MISMATCH');
    expect(out).not.toContain('loading images');
  });

  it('refuses a bundle built for another CPU architecture, naming both', async () => {
    const b = await fakeBundle({ platform: 'linux/mips64' });
    const { code, out } = await install(b);
    expect(code).not.toBe(0);
    expect(out).toContain('ARCHITECTURE MISMATCH');
    expect(out).toContain('linux/mips64');
    expect(out).toContain('ARCHITECTURES.md');
    expect(out).not.toContain('loading images');
  });

  it('the emulation test hatch downgrades an arch mismatch to a warning, and says so', async () => {
    const b = await fakeBundle({ platform: 'linux/mips64' });
    const { code, out } = await install(b, { REPOPULSE_ALLOW_EMULATED_ARCH: '1' });
    expect(code).not.toBe(0); // still needs a runtime; the point is it got that far
    expect(out).toContain('continuing under emulation');
    expect(out).toContain('testing only');
    expect(out).toContain('Neither podman nor docker is on PATH');
  });

  it('passes its own gates and then needs a runtime, in that order', async () => {
    const b = await fakeBundle();
    const { code, out } = await install(b);
    expect(code).not.toBe(0);
    expect(out).toContain('RepoPulse 9.9.9');
    expect(out).toContain('verifying checksums');
    expect(out).toContain('Neither podman nor docker is on PATH');
  });
});
