import { existsSync } from 'node:fs';
import path from 'node:path';
import { runInSandbox, type RunInSandboxOptions } from '../../sandbox/run.js';
import type { ScanBudget } from '../framework/types.js';
import type { CallSite, ReachabilityVerdict } from './types.js';

// V3 — symbol reachability (W8-13, SECURITY_SUITE.md §3.6, FR-SEC-13).
//
// V2 answers "is it imported". This tier answers the question a developer
// actually asks next: "does our code REACH THE VULNERABLE FUNCTION". That is a
// call-graph question, and only one ecosystem here has a tool that answers it
// from source.
//
// WHAT EACH ECOSYSTEM GETS, PLAINLY
//   Go — govulncheck in source mode, inside the §2.2 sandbox. It builds a real
//     call graph and reports, per vulnerability, the trace from our code to
//     the vulnerable symbol. A vulnerability with module- and package-level
//     findings but NO function frame is proven unreachable: the tool loaded
//     the package, looked for a path to the symbol, and there is none.
//   JS/TS and Python — call SITES, not a call graph (W18-46, symbols.ts and
//     symbol-reachability.ts). Opengrep rules generated from a catalogue of
//     advisories that name a public vulnerable function find calls to it, and a
//     call upgrades the finding to 'symbol_reachable' with provenBy 'opengrep'.
//     That is weaker than govulncheck's proof and is worded that way: it shows
//     the function is used, not that attacker data reaches it, and finding NO
//     call proves nothing (dynamic access, re-exports and transitive callers are
//     invisible), so these ecosystems never answer 'proven_unreachable'. The
//     catalogue is small because OSV names a vulnerable function for few npm
//     and PyPI advisories; everything else stops at V2's 'imported' or
//     'manifest_only', with the reason in `unavailableReason`.
//
// WHAT IS NOT WIRED UP YET, STATED BECAUSE IT IS LOAD-BEARING. The scan image
// (Containerfile.scan) contains no Go toolchain and no govulncheck, and
// deploy/scan-db-sync.sh fetches no Go vulnerability database — both files are
// outside this ticket's write scope. So `goReachability` preflights for the
// database and returns 'unavailable' with that reason instead of starting a
// container that would fail; the parser below is nonetheless tested against
// REAL captured govulncheck v1.7.0 output from both a reachable and an
// unreachable fixture (fixtures/dependency/go-*), so the day the image gains
// the tool, the half that reads it has already been proven.

/** Mount point of the Go vulnerability database, mirroring VULN_DB_MOUNT_PATH. */
export const GO_VULN_DB_MOUNT_PATH = '/go-vulndb';

/** Where the host would keep the Go vulnerability database, once it syncs one. */
export function goVulnDbDir(): string {
  return path.join(process.env.SCAN_RULES_DIR ?? '/var/lib/repopulse/scan-rules', 'go-vulndb');
}

export type GoVulnDbCheck = { ok: true } | { ok: false; reason: string };

/**
 * Is there a Go vulnerability database to prove anything against?
 *
 * Checked BEFORE a container starts, for the same reason checkVulnDb is:
 * govulncheck with no database reports no vulnerabilities, and "nothing is
 * reachable" is exactly the answer that would let a real one through.
 */
export function checkGoVulnDb(dir: string): GoVulnDbCheck {
  if (!existsSync(path.join(dir, 'index', 'db.json'))) {
    return {
      ok: false,
      reason:
        `no Go vulnerability database at ${dir} — deploy/scan-db-sync.sh does not yet ` +
        `fetch one, so Go reachability is not proven`,
    };
  }
  return { ok: true };
}

/** One vulnerability's reachability, as govulncheck reported it. */
export interface GoVulnerability {
  /** The GO-… id. */
  osvId: string;
  /** CVE and GHSA ids the advisory lists — how this joins to a grype match. */
  aliases: string[];
  /** Modules the advisory affects, so a finding can be matched by package. */
  modules: string[];
  /** True when a trace reached a FUNCTION, not merely the module. */
  symbolReachable: boolean;
  callSites: CallSite[];
}

export interface GovulncheckOutput {
  vulnerabilities: GoVulnerability[];
  /** From the tool's own config record, so the stamped version is the one that ran. */
  scannerVersion: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Splits govulncheck's `-format json` stream into its messages.
 *
 * The tool emits a SEQUENCE of pretty-printed JSON objects, not an array and
 * not one per line, so neither JSON.parse nor a line reader works on it. This
 * scans for balanced braces outside of strings — verified against the captured
 * fixtures, which is the only way to know what it really emits.
 */
export function splitJsonStream(text: string): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') {
      if (depth === 0) start = at;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          messages.push(asRecord(JSON.parse(text.slice(start, at + 1))));
        } catch {
          // DEFENSIVE, and on no path today: goReachability only parses a run
          // the sandbox reported as succeeded, and a killed container comes
          // back 'timed_out' instead. Kept because the alternative — throwing
          // a whole stream away over its last object — is the wrong failure
          // for a reader whose input is downstream of someone else's source.
        }
        start = -1;
      }
    }
  }
  return messages;
}

/**
 * Reads a govulncheck run.
 *
 * THE FIELD NAMES ARE THE ONES THE TOOL ACTUALLY EMITS, captured from
 * govulncheck v1.7.0 against fixtures/dependency/go-reachable — `finding.trace`
 * is ordered CALLEE-FIRST, so trace[0] is the vulnerable symbol and the last
 * frame is our own entry point. A `position` is relative to the package's
 * directory, not to the repository root.
 */
export function parseGovulncheck(text: string): GovulncheckOutput {
  const messages = splitJsonStream(text);
  const byId = new Map<string, GoVulnerability>();
  let scannerVersion: string | null = null;

  for (const message of messages) {
    const config = asRecord(message['config']);
    const version = asString(config['scanner_version']);
    if (version) scannerVersion = version;

    const osv = asRecord(message['osv']);
    const osvId = asString(osv['id']);
    if (osvId) {
      byId.set(osvId, {
        osvId,
        aliases: asArray(osv['aliases'])
          .flatMap((alias) => (asString(alias) ? [asString(alias)!.toUpperCase()] : []))
          .sort(),
        modules: [
          ...new Set(
            asArray(osv['affected']).flatMap((entry) => {
              const name = asString(asRecord(asRecord(entry)['package'])['name']);
              return name ? [name] : [];
            }),
          ),
        ],
        symbolReachable: false,
        callSites: byId.get(osvId)?.callSites ?? [],
      });
    }

    const finding = asRecord(message['finding']);
    const findingId = asString(finding['osv']);
    if (!findingId) continue;
    const frames = asArray(finding['trace']).map(asRecord);
    // A FUNCTION FRAME IS THE PROOF. Every affected module produces a
    // module-level finding and every loaded package a package-level one, so
    // presence of a finding says nothing on its own — only a frame naming a
    // function means the call graph has a path into the vulnerable code.
    const symbolFrame = frames.find((frame) => asString(frame['function']) !== null);
    if (!symbolFrame) continue;

    const entry = byId.get(findingId) ?? {
      osvId: findingId,
      aliases: [],
      modules: [],
      symbolReachable: false,
      callSites: [],
    };
    entry.symbolReachable = true;
    // The CALLER is what a developer needs: "your main.go line 11 calls it" is
    // actionable, where the callee's own position points into a dependency
    // nobody in this repository can edit.
    const callerFrame = frames[frames.length - 1] ?? symbolFrame;
    const position = asRecord(callerFrame['position']);
    const file = asString(position['filename']);
    const line = position['line'];
    entry.callSites.push({
      file: file ?? asString(callerFrame['package']) ?? 'unknown',
      line: typeof line === 'number' ? line : 0,
      symbol: [asString(symbolFrame['receiver']), asString(symbolFrame['function'])]
        .filter((part): part is string => part !== null)
        .join('.'),
    });
    byId.set(findingId, entry);
  }

  return { vulnerabilities: [...byId.values()], scannerVersion };
}

export interface GoReachabilityArgs {
  targetDir: string;
  image: string;
  budget: Pick<ScanBudget, 'wallClockMs'> & Partial<ScanBudget>;
  /** Host directory holding the Go vulnerability database. */
  goVulnDb?: string;
  runtime?: string;
  spawnFn?: RunInSandboxOptions['spawnFn'];
}

export interface GoReachabilityResult {
  status: 'succeeded' | 'skipped' | 'failed';
  vulnerabilities: GoVulnerability[];
  toolVersion: string | null;
  /** Why nothing ran, when nothing ran. Always set for 'skipped'/'failed'. */
  reason: string | null;
}

/**
 * Runs govulncheck over the snapshot, inside the unmodified §2.2 profile.
 *
 * EVERY FLAG BELOW EXISTS TO KEEP IT OFFLINE. govulncheck reaches for
 * https://vuln.go.dev and the module proxy by default, and a tool that
 * silently degrades under --network=none is worse than one that fails:
 *   - `-db file://` points it at the mounted database instead of the internet;
 *   - GOFLAGS=-mod=vendor makes it read the repository's vendor tree, so no
 *     module download is needed — a repository with no vendor directory
 *     therefore cannot be analysed offline, which is a real limitation of
 *     source mode under this profile and is reported, not hidden;
 *   - GOPROXY=off turns a would-be fetch into an error rather than a hang;
 *   - GOFLAGS/GOMODCACHE/GOCACHE point at the profile's tmpfs, because the
 *     container's root filesystem is read-only and the Go toolchain writes a
 *     build cache.
 * Verified offline HOST-SIDE against both fixtures (GOPROXY=off, vendored,
 * `-db file://…`); NOT yet verified in the container, because the image has no
 * Go toolchain in it — see the file header.
 */
export async function goReachability(args: GoReachabilityArgs): Promise<GoReachabilityResult> {
  const goVulnDb = args.goVulnDb ?? goVulnDbDir();
  const dbCheck = checkGoVulnDb(goVulnDb);
  if (!dbCheck.ok) {
    return { status: 'skipped', vulnerabilities: [], toolVersion: null, reason: dbCheck.reason };
  }
  if (!existsSync(path.join(args.targetDir, 'go.mod'))) {
    return {
      status: 'skipped',
      vulnerabilities: [],
      toolVersion: null,
      reason: 'no go.mod in the snapshot — nothing for a Go call graph to be built from',
    };
  }
  if (!existsSync(path.join(args.targetDir, 'vendor'))) {
    return {
      status: 'skipped',
      vulnerabilities: [],
      toolVersion: null,
      reason:
        'the module is not vendored, and source mode cannot resolve its dependencies ' +
        'with --network=none',
    };
  }

  const result = await runInSandbox({
    image: args.image,
    snapshotDir: args.targetDir,
    ...(args.runtime ? { runtime: args.runtime } : {}),
    ...(args.spawnFn ? { spawnFn: args.spawnFn } : {}),
    extraMounts: [{ hostPath: goVulnDb, containerPath: GO_VULN_DB_MOUNT_PATH }],
    budget: args.budget,
    parseOutput: false,
    command: [
      'sh',
      '-c',
      // The environment is set HERE rather than passed in: buildSandboxArgs
      // gives the container nothing from this process, by design, and adding
      // env-passing to the profile to suit one tool would trade the trust
      // boundary for convenience.
      [
        'GOFLAGS=-mod=vendor',
        'GOPROXY=off',
        'GOCACHE=/tmp/gocache',
        'GOMODCACHE=/tmp/gomodcache',
        'govulncheck',
        `-db file://${GO_VULN_DB_MOUNT_PATH}`,
        '-format json',
        './...',
      ].join(' '),
    ],
  });

  if (result.status !== 'succeeded' || result.rawStdout === undefined) {
    return {
      status: 'failed',
      vulnerabilities: [],
      toolVersion: null,
      reason: result.error ?? `govulncheck ${result.status}`,
    };
  }

  const parsed = parseGovulncheck(result.rawStdout);
  return {
    status: 'succeeded',
    vulnerabilities: parsed.vulnerabilities,
    toolVersion: parsed.scannerVersion,
    reason: null,
  };
}

/**
 * The reachability tier for one vulnerability, given everything above it.
 *
 * ORDER MATTERS AND IS THE POINT: a proof beats an observation, and an
 * observation beats a manifest entry. `proven_unreachable` is only ever
 * returned when a call-graph tool looked and found no path — never because we
 * failed to find an import, which is V2's much weaker claim.
 */
export function reachabilityFor(
  usageStatus: 'imported' | 'not_imported' | 'unknown',
  proof: GoVulnerability | null,
  unavailableReason: string | null,
  symbolCalls: readonly CallSite[] = [],
): ReachabilityVerdict {
  if (!proof && symbolCalls.length > 0) {
    // A call SITE, not a call graph: the function is called somewhere in this
    // repository's own sources, which says nothing about whether attacker
    // data reaches it. Never 'proven_unreachable' from this path.
    return {
      tier: 'symbol_reachable',
      provenBy: 'opengrep',
      unavailableReason: null,
      callSites: [...symbolCalls],
    };
  }
  if (proof) {
    return {
      tier: proof.symbolReachable ? 'symbol_reachable' : 'proven_unreachable',
      provenBy: 'govulncheck',
      unavailableReason: null,
      callSites: proof.callSites,
    };
  }
  return {
    // 'imported' is V2's tier and is NOT a reachability proof — it says the
    // package is loaded, not that the vulnerable function is called. Anything
    // else stays at manifest_only, which is the weakest claim there is and the
    // only honest one when nothing looked.
    tier: usageStatus === 'imported' ? 'imported' : 'manifest_only',
    provenBy: null,
    unavailableReason,
    callSites: [],
  };
}
