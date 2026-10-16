import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readVulnDbStatus,
  SCAN_TOOLS,
  UNSUPPORTED_TOOLS,
  VULN_DB_MAX_AGE_DAYS,
  rulepackMountDir,
} from './tooling.js';

// What the sandbox can and cannot run, stated (W17-27, acceptance 3).

const DAY = 24 * 60 * 60 * 1000;

function dbDir(source: string | null, schema = '6'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'w17-27-vulndb-'));
  mkdirSync(path.join(dir, schema));
  writeFileSync(path.join(dir, schema, 'vulnerability.db'), 'not really sqlite');
  if (source !== null) {
    writeFileSync(
      path.join(dir, schema, 'import.json'),
      JSON.stringify({ digest: 'xxh64:abc', source, client_version: 'v6.1.9' }),
    );
  }
  return dir;
}

// The shape deploy/scan-db-sync.sh actually leaves behind — copied from a real
// import.json, not invented.
const SOURCE =
  'https://grype.anchore.io/databases/v6/vulnerability-db_v6.1.9_2026-08-20T00:15:42Z_1787206628.tar.zst?checksum=sha256%3A39324b';

describe('readVulnDbStatus', () => {
  it('reads the build time out of the artefact name and computes the age', () => {
    const now = () => Date.parse('2026-08-22T12:00:00Z');
    const status = readVulnDbStatus(dbDir(SOURCE), now);
    expect(status.present).toBe(true);
    expect(status.schema).toBe('6');
    expect(status.builtAt).toBe('2026-08-20T00:15:42Z');
    expect(status.ageDays).toBe(2);
    expect(status.stale).toBe(false);
    expect(status.maxAgeDays).toBe(VULN_DB_MAX_AGE_DAYS);
    expect(status.reason).toBeNull();
  });

  it('calls a database older than grype accepts STALE rather than present-and-fine', () => {
    // grype refuses it and the dependency scan fails — which the screen must
    // be able to predict before someone presses Run.
    const now = () => Date.parse('2026-08-20T00:15:42Z') + 6 * DAY + 1;
    const status = readVulnDbStatus(dbDir(SOURCE), now);
    expect(status.ageDays).toBe(6);
    expect(status.stale).toBe(true);
  });

  it('says why when there is no database, naming the sync script', () => {
    const status = readVulnDbStatus(path.join(tmpdir(), 'w17-27-no-such-vulndb'));
    expect(status.present).toBe(false);
    expect(status.stale).toBeNull();
    expect(status.reason).toContain('deploy/scan-db-sync.sh');
  });

  it('a schema directory with no vulnerability.db is an unfinished sync, not a database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'w17-27-vulndb-empty-'));
    mkdirSync(path.join(dir, '6'));
    const status = readVulnDbStatus(dir);
    expect(status.present).toBe(false);
    expect(status.reason).toContain('did not finish');
  });

  it('falls back to the file mtime when import.json is missing, still reporting an age', () => {
    const status = readVulnDbStatus(dbDir(null));
    expect(status.present).toBe(true);
    expect(status.builtAt).not.toBeNull();
    expect(status.ageDays).toBe(0);
  });
});

describe('tool lists stay true to Containerfile.scan', () => {
  const containerfile = readFileSync(
    new URL('../../../Containerfile.scan', import.meta.url),
    'utf8',
  );

  it('every supported tool is installed by the image', () => {
    for (const { tool } of SCAN_TOOLS) {
      expect(
        containerfile,
        `${tool} is listed as supported but Containerfile.scan does not install it`,
      ).toMatch(new RegExp(`\\b${tool}\\b`));
    }
  });

  it('every tool the image installs is listed, so a new tool has to be declared', () => {
    // The image proves each tool runs by invoking it at the end of its stanza;
    // those invocations are the ground truth this list is checked against.
    const invoked = new Set(
      [
        ...containerfile.matchAll(
          /(?:^|\s)(opengrep|lizard|jscpd|depcruise|ruff|biome|actionlint|shellcheck|hadolint|checkov|syft|grype|helm|kustomize) (?:--version|version)\b/gm,
        ),
      ].map((m) => m[1]),
    );
    if (/import grimp/.test(containerfile)) invoked.add('grimp');
    const listed = new Set(SCAN_TOOLS.map((t) => t.tool));
    expect([...invoked].sort()).toEqual([...listed].sort());
  });

  it('names what is NOT supported, each with a reason a reader can act on', () => {
    expect(UNSUPPORTED_TOOLS.length).toBeGreaterThanOrEqual(4);
    for (const { tool, reason } of UNSUPPORTED_TOOLS) {
      expect(tool.length).toBeGreaterThan(2);
      expect(reason.length).toBeGreaterThan(20);
      // An unsupported tool must not also be claimed as supported.
      expect(SCAN_TOOLS.some((t) => new RegExp(`\\b${t.tool}\\b`, "i").test(tool))).toBe(false);
    }
    expect(UNSUPPORTED_TOOLS.map((t) => t.tool)).toContain('govulncheck');
  });
});

// Where a rulepack is read from and mounted from (W17-27). Behind a runner the
// checkout path is unreachable by the daemon and refused by the runner; the
// synced copy under SCAN_RULES_DIR is the one every container can see.
describe('rulepackMountDir', () => {
  const before = { ...process.env };
  afterEach(() => {
    delete process.env.SCAN_RUNNER_URL;
    delete process.env.SCAN_RUNNER_SOCKET;
    delete process.env.SCAN_RULES_DIR;
    Object.assign(process.env, before);
  });

  it('is the checkout path when no runner is configured (the dev machine spawns the runtime itself)', () => {
    delete process.env.SCAN_RUNNER_URL;
    delete process.env.SCAN_RUNNER_SOCKET;
    process.env.SCAN_RULES_DIR = '/var/lib/repopulse/scan-rules';
    expect(rulepackMountDir('/home/me/repopulse/packages/security/rulepacks/semgrep')).toBe(
      '/home/me/repopulse/packages/security/rulepacks/semgrep',
    );
  });

  it('is the synced copy under SCAN_RULES_DIR behind a runner, keeping the path below rulepacks/', () => {
    process.env.SCAN_RUNNER_URL = 'http://scan-runner:3310';
    process.env.SCAN_RULES_DIR = '/var/lib/repopulse/scan-rules';
    expect(rulepackMountDir('/app/packages/security/rulepacks/semgrep')).toBe(
      '/var/lib/repopulse/scan-rules/rulepacks/semgrep',
    );
    expect(rulepackMountDir('/app/packages/security/rulepacks/code-health/perf')).toBe(
      '/var/lib/repopulse/scan-rules/rulepacks/code-health/perf',
    );
  });

  it('matches what deploy/scan-db-sync.sh actually lays down', () => {
    // The sync copies packages/security/rulepacks/. verbatim; the resolved
    // path must exist in a synced tree for every pack a scanner mounts.
    process.env.SCAN_RUNNER_URL = 'http://scan-runner:3310';
    process.env.SCAN_RULES_DIR = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../../deploy/scan-rules',
    );
    const checkout = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../rulepacks',
    );
    for (const sub of ['semgrep', 'code-health', 'code-health/perf']) {
      const synced = rulepackMountDir(path.join(checkout, sub));
      expect(synced.startsWith(process.env.SCAN_RULES_DIR)).toBe(true);
      // Present here because the sync has been run on this checkout; a fresh
      // clone without deploy/scan-rules/rulepacks is the case the read-time
      // failure in runSemgrepScan exists for.
      if (existsSync(path.join(process.env.SCAN_RULES_DIR, 'rulepacks'))) {
        expect(existsSync(synced), synced).toBe(true);
      }
    }
  });
});
