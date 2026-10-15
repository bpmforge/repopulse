import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { configuredRunnerAddress } from './runner-client.js';

// What the scan sandbox can and cannot run, stated rather than implied
// (W17-27, acceptance 3).
//
// Two lists and one reader. The lists are maintained by hand against
// Containerfile.scan, and the test beside this file greps that file so a tool
// added or removed there without updating them fails the build. The reader
// looks at the synced vulnerability database, because "dependency scanning is
// available" is a claim about DATA that is refreshed nightly, not about a
// binary that is either in the image or not.

/** A tool the scan image carries and the scanner keys that run it. */
export interface ScanTool {
  tool: string;
  usedBy: string[];
}

/** Every binary Containerfile.scan installs, with who calls it. */
export const SCAN_TOOLS: readonly ScanTool[] = [
  { tool: 'opengrep', usedBy: ['semgrep'] },
  { tool: 'lizard', usedBy: ['code_health_tools'] },
  { tool: 'jscpd', usedBy: ['code_health_tools'] },
  { tool: 'ruff', usedBy: ['code_health_tools'] },
  { tool: 'biome', usedBy: ['code_health_tools'] },
  // W18-26 — all four run as shadow candidates until promoted (§8.2).
  { tool: 'actionlint', usedBy: ['code_health_tools'] },
  { tool: 'shellcheck', usedBy: ['code_health_tools'] },
  { tool: 'hadolint', usedBy: ['code_health_tools'] },
  { tool: 'checkov', usedBy: ['code_health_tools'] },
  { tool: 'depcruise', usedBy: ['architecture_register'] },
  { tool: 'grimp', usedBy: ['architecture_register'] },
  { tool: 'syft', usedBy: ['dependency_cve', 'supply_chain_register'] },
  { tool: 'grype', usedBy: ['dependency_cve'] },
];

/** A tool a reader might expect and this build deliberately does not run. */
export interface UnsupportedTool {
  tool: string;
  reason: string;
}

/**
 * Named so their absence is a statement, not a gap. Each of these is
 * something a security-minded reader would look for; each is absent for a
 * reason that is written down here rather than discoverable only by a scan
 * that quietly reports nothing.
 */
export const UNSUPPORTED_TOOLS: readonly UnsupportedTool[] = [
  {
    tool: 'govulncheck',
    reason:
      'Not in the scan image and no Go vulnerability database is synced, so Go reachability reports "unavailable" rather than clean.',
  },
  {
    tool: 'Semgrep registry packs (p/*, --config auto)',
    reason:
      'Licence: SECURITY_SUITE §3.3 bars registry packs for service use. Only the in-house rulepacks under packages/security/rulepacks run.',
  },
  {
    tool: 'import-linter',
    reason:
      'Its contract file would be a config surface a scanned repository could edit. grimp, the graph engine under it, runs instead.',
  },
  {
    tool: 'cosign',
    reason:
      'Not installed. Tool binaries are pinned by sha256 recorded at build time, which detects a silent replacement but is not sigstore verification.',
  },
  {
    tool: 'trivy config, KICS',
    reason:
      'Not installed. Infrastructure-as-code is read by one tool, run inside code_health_tools on an allowlist of checks, and its findings are shadow candidates until promoted — a second IaC engine would double-report the same misconfigurations.',
  },
  {
    tool: 'helm / kustomize rendering',
    reason:
      'Not installed. Helm charts and kustomize overlays are templates; checking them means rendering them, which needs those binaries and, for charts with dependencies, the network. Plain Kubernetes manifests are checked; charts are not.',
  },
  {
    tool: 'Secret scanners (gitleaks, trufflehog)',
    reason:
      'Secrets are found by the in-house diff scanner over ingested patches, which needs no snapshot and no container; no third-party secret scanner runs.',
  },
];

/** grype's own default: it refuses a database older than this. */
export const VULN_DB_MAX_AGE_DAYS = 5;

export interface VulnDbStatus {
  present: boolean;
  /** grype schema directory the database was found in, e.g. "6". */
  schema: string | null;
  /** ISO timestamp the database was BUILT (from Anchore's artefact name). */
  builtAt: string | null;
  ageDays: number | null;
  maxAgeDays: number;
  /** Older than grype will accept — the scanner will fail, not report clean. */
  stale: boolean | null;
  /** Where it came from, for an operator checking the sync. */
  source: string | null;
  /** Why it is absent or unreadable, when it is. */
  reason: string | null;
}

/**
 * Reads the synced grype database's presence and age.
 *
 * `dir` is the `vuln-db` directory deploy/scan-db-sync.sh fills (the
 * scanner's vulnDbDir()). grype lays it out as `<schema>/vulnerability.db`
 * beside an `import.json` whose `source` URL carries the build timestamp in
 * its file name — the only place the build time is recorded in a form that
 * does not require opening the sqlite database.
 */
export function readVulnDbStatus(dir: string, now: () => number = Date.now): VulnDbStatus {
  const absent = (reason: string): VulnDbStatus => ({
    present: false,
    schema: null,
    builtAt: null,
    ageDays: null,
    maxAgeDays: VULN_DB_MAX_AGE_DAYS,
    stale: null,
    source: null,
    reason,
  });

  if (!existsSync(dir))
    return absent(`no vulnerability database at ${dir} — run deploy/scan-db-sync.sh`);

  let schemas: string[];
  try {
    schemas = readdirSync(dir)
      .filter((name) => /^\d+$/.test(name))
      .filter((name) => existsSync(path.join(dir, name, 'vulnerability.db')))
      .sort((a, b) => Number(b) - Number(a));
  } catch (err) {
    return absent(`cannot read ${dir}: ${(err as Error).message}`);
  }
  const schema = schemas[0];
  if (schema === undefined) {
    return absent(`${dir} exists but holds no <schema>/vulnerability.db — the sync did not finish`);
  }

  let source: string | null = null;
  let builtAt: string | null = null;
  try {
    const meta = JSON.parse(readFileSync(path.join(dir, schema, 'import.json'), 'utf8')) as {
      source?: unknown;
    };
    if (typeof meta.source === 'string') {
      source = meta.source;
      const m = /_(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)_/.exec(meta.source);
      if (m?.[1]) builtAt = m[1];
    }
  } catch {
    // Fall through to the file's own mtime below: an older grype wrote no
    // import.json, and a database with an unknown build date is still a
    // database — but its age must then be stated as a lower bound.
  }
  if (builtAt === null) {
    try {
      builtAt = new Date(
        statSync(path.join(dir, schema, 'vulnerability.db')).mtimeMs,
      ).toISOString();
    } catch {
      builtAt = null;
    }
  }

  const ageDays =
    builtAt === null
      ? null
      : Math.max(0, Math.floor((now() - Date.parse(builtAt)) / (24 * 60 * 60 * 1000)));

  return {
    present: true,
    schema,
    builtAt,
    ageDays,
    maxAgeDays: VULN_DB_MAX_AGE_DAYS,
    stale: ageDays === null ? null : ageDays > VULN_DB_MAX_AGE_DAYS,
    source,
    reason: null,
  };
}

/** The synced-rules root, same env var and default as every scanner. */
export function scanRulesDir(): string {
  return process.env.SCAN_RULES_DIR ?? '/var/lib/repopulse/scan-rules';
}

/**
 * Where a rulepack is read from AND mounted from, given its checkout path.
 *
 * Every scanner resolves its pack relative to its own source file, which is
 * right on a dev checkout: the runtime is on this machine and can bind that
 * directory. Behind a scan-runner it is wrong twice over — the runner's
 * daemon cannot see this container's filesystem, and the runner refuses any
 * mount source outside SCAN_RULES_DIR by design. deploy/scan-db-sync.sh has
 * always copied the in-house packs to `<SCAN_RULES_DIR>/rulepacks/…` for
 * exactly this reason (docs/DEPLOYMENT.md), and that directory is mounted
 * read-only into worker, runner and scan container alike. So: behind a runner,
 * the synced copy; otherwise the checkout. The caller READS the returned
 * directory too, so the version stamped on the run is the pack that ran, and
 * a pack the sync never delivered fails at the read with the path in the
 * message rather than mounting an empty directory the runtime created.
 *
 * Measured before this existed (W17-27): semgrep, logging_hygiene and
 * performance all refused with `extra mount "/app/packages/security/rulepacks/…"
 * is outside the rules dir` on the first packaged scan.
 */
export function rulepackMountDir(checkoutDir: string): string {
  if (configuredRunnerAddress() === undefined) return checkoutDir;
  const marker = `${path.sep}rulepacks${path.sep}`;
  const at = checkoutDir.lastIndexOf(marker);
  const rel = at === -1 ? path.basename(checkoutDir) : checkoutDir.slice(at + marker.length);
  return path.join(scanRulesDir(), 'rulepacks', rel);
}
