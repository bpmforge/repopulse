#!/usr/bin/env node
// @ts-check
// RepoPulse CI check (W18-18, D16 "CI pull").
//
// Your CI asks RepoPulse "what is new on this pull request?", and THIS SCRIPT
// decides whether the build fails and writes SARIF + a markdown summary. Your
// pipeline then uploads or posts them with ITS OWN forge token. RepoPulse never
// writes to your repository, never posts a status and never comments (D9a).
//
// ONE FILE, NO DEPENDENCIES, NO BUILD STEP, on purpose: a pipeline fetches it
// from your RepoPulse server (GET /api/v1/cli/repopulse.mjs, with the same CI
// token) or vendors it, and runs it with the Node that is already on the
// runner. Plain JavaScript checked by tsc (`// @ts-check` + JSDoc) so the file
// that is type-checked in the monorepo is byte-for-byte the file that runs.
//
// Usage: repopulse check --server URL --repo ID --pr N [options]   (see HELP)

import { writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const VERSION = '1.0.0';

/** Exit codes. Distinct so a pipeline can tell "your code" from "our plumbing". */
export const EXIT = Object.freeze({
  PASS: 0,
  THRESHOLD: 1,
  USAGE: 2,
  SERVER: 3,
  NOT_READY: 4,
});

export const SEVERITIES = /** @type {const} */ (['info', 'low', 'medium', 'high', 'critical']);

/** @typedef {(typeof SEVERITIES)[number]} Severity */

/**
 * @typedef {object} Finding
 * @property {number} id
 * @property {string | null} rule_id
 * @property {string | null} scanner_key
 * @property {string} dimension
 * @property {number} severity
 * @property {string} severity_label
 * @property {number} confidence
 * @property {string} title
 * @property {string | null} file
 * @property {number | null} line_start
 * @property {number | null} line_end
 * @property {string} evidence
 * @property {string} suggested_fix
 * @property {boolean} experimental
 * @property {string} status
 * @property {boolean} introduced_by_pr
 * @property {boolean} seen_at_head
 */

/**
 * @typedef {object} PrFindings
 * @property {{ number: number, title: string, state: string, head_sha: string, base_ref: string }} pull
 * @property {{ sha: string, scanned: boolean, scanners: { scanner_key: string, scanned_at: string }[], pending?: string[], failed?: string[] }} head
 * @property {Finding[]} items
 */

/**
 * @typedef {object} CheckConfig
 * @property {string} server
 * @property {number} repo
 * @property {number} pr
 * @property {string} token
 * @property {Severity | 'none'} failOn
 * @property {number | null} maxNew
 * @property {boolean} includeExperimental
 * @property {string | null} sha
 * @property {number} waitSeconds
 * @property {boolean} allowUnscanned
 * @property {string | null} sarif
 * @property {string | null} markdown
 * @property {string | null} json
 */

export const HELP = `repopulse ${VERSION} — RepoPulse CI check

Usage:
  repopulse check --server URL --repo ID --pr N [options]

Reads the CI token from REPOPULSE_TOKEN (a read-only token an admin minted in
RepoPulse). The server may also come from REPOPULSE_SERVER.

Options:
  --fail-on LEVEL        fail when a new finding is at or above LEVEL:
                         critical | high | medium | low | info | none  (default: high)
  --max-new N            fail when more than N new findings remain (default: no limit)
  --include-experimental count findings from rules still in shadow mode
  --sha SHA              the PR head commit this pipeline is testing; wait for
                         RepoPulse to have scanned exactly this commit
  --wait SECONDS         how long to wait for that scan (default: 0)
  --allow-unscanned      do not fail when the head has not been scanned yet
  --sarif PATH           write SARIF 2.1.0 (for code-scanning upload)
  --markdown PATH        write a markdown summary (for your CI to post)
  --json PATH            write the raw findings as JSON
  -h, --help             this text
  -v, --version          print the version

Exit codes:
  0 pass   1 threshold breached   2 usage error   3 server/auth error
  4 the PR head has not been scanned yet (see --wait / --allow-unscanned)
`;

export class UsageError extends Error {}
export class ServerError extends Error {}
/**
 * RepoPulse has not ingested this pull request YET (W20-15, UX_TODO X-14).
 * The usual case on a PR's first pipeline: CI starts the moment the forge
 * sends the webhook. Not a server error, so --wait keeps polling through it.
 */
export class NotSyncedError extends Error {}

/** The server's problem type for "this PR has not been ingested yet". */
export const PR_NOT_SYNCED_PROBLEM = 'urn:repopulse:problem:pr-not-synced';

/**
 * @param {string[]} argv arguments after the script name
 * @param {Record<string, string | undefined>} env
 * @returns {{ kind: 'help' } | { kind: 'version' } | { kind: 'check', config: CheckConfig }}
 */
export function parseArgs(argv, env) {
  const args = [...argv];
  if (args.includes('-h') || args.includes('--help') || args.length === 0) return { kind: 'help' };
  if (args.includes('-v') || args.includes('--version')) return { kind: 'version' };
  const command = args.shift();
  if (command !== 'check') throw new UsageError(`unknown command "${command}" (expected "check")`);

  /** @type {Record<string, string>} */
  const values = {};
  /** @type {Set<string>} */
  const flags = new Set();
  const valued = new Set([
    'server',
    'repo',
    'pr',
    'fail-on',
    'max-new',
    'sha',
    'wait',
    'sarif',
    'markdown',
    'json',
  ]);
  const boolean = new Set(['include-experimental', 'allow-unscanned']);
  while (args.length > 0) {
    const raw = /** @type {string} */ (args.shift());
    if (!raw.startsWith('--')) throw new UsageError(`unexpected argument "${raw}"`);
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    if (boolean.has(name)) {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      flags.add(name);
      continue;
    }
    if (!valued.has(name)) throw new UsageError(`unknown option --${name}`);
    const value = eq === -1 ? args.shift() : raw.slice(eq + 1);
    if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`);
    values[name] = value;
  }

  const server = (values['server'] ?? env['REPOPULSE_SERVER'] ?? '').replace(/\/+$/, '');
  if (!server) throw new UsageError('--server (or REPOPULSE_SERVER) is required');
  if (!/^https?:\/\//.test(server)) throw new UsageError('--server must be an http(s) URL');
  const token = env['REPOPULSE_TOKEN'] ?? '';
  // Never accepted on the command line: argv is visible in process listings
  // and CI logs; an environment variable fed from a CI secret is masked.
  if (!token) throw new UsageError('REPOPULSE_TOKEN is not set');

  const failOn = /** @type {Severity | 'none'} */ (values['fail-on'] ?? 'high');
  if (failOn !== 'none' && !SEVERITIES.includes(/** @type {Severity} */ (failOn))) {
    throw new UsageError(`--fail-on must be one of: ${[...SEVERITIES].reverse().join(', ')}, none`);
  }

  return {
    kind: 'check',
    config: {
      server,
      token,
      repo: positiveInt('repo', values['repo']),
      pr: positiveInt('pr', values['pr']),
      failOn,
      maxNew: values['max-new'] === undefined ? null : nonNegativeInt('max-new', values['max-new']),
      includeExperimental: flags.has('include-experimental'),
      sha: values['sha'] ?? null,
      waitSeconds: values['wait'] === undefined ? 0 : nonNegativeInt('wait', values['wait']),
      allowUnscanned: flags.has('allow-unscanned'),
      sarif: values['sarif'] ?? null,
      markdown: values['markdown'] ?? null,
      json: values['json'] ?? null,
    },
  };
}

/** @param {string} name @param {string | undefined} raw */
function positiveInt(name, raw) {
  if (raw === undefined) throw new UsageError(`--${name} is required`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

/** @param {string} name @param {string} raw */
function nonNegativeInt(name, raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a whole number`);
  return n;
}

/**
 * Every page of new findings for the PR. GET only: this tool has nothing to
 * write, and the token it carries could not write if it tried.
 *
 * @param {CheckConfig} config
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<PrFindings>}
 */
export async function fetchPrFindings(config, fetchImpl) {
  /** @type {Finding[]} */
  const items = [];
  /** @type {string | null} */
  let cursor = null;
  /** @type {PrFindings | null} */
  let first = null;
  for (let page = 0; page < 200; page++) {
    const url = new URL(`${config.server}/api/v1/repos/${config.repo}/pulls/${config.pr}/findings`);
    url.searchParams.set('new', 'true');
    url.searchParams.set('include_experimental', String(config.includeExperimental));
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);

    /** @type {Response} */
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${config.token}`,
          accept: 'application/json',
          'user-agent': `repopulse-cli/${VERSION}`,
        },
      });
    } catch (err) {
      throw new ServerError(`could not reach ${config.server}: ${describe(err)}`);
    }
    if (!res.ok) {
      const problem = await readProblem(res);
      if (res.status === 404 && problem.type === PR_NOT_SYNCED_PROBLEM) {
        throw new NotSyncedError(
          `RepoPulse has not ingested PR #${config.pr} yet${problem.detail ? ` (${problem.detail})` : ''}`,
        );
      }
      throw new ServerError(problemText(res.status, problem));
    }
    const body = /** @type {PrFindings & { next_cursor: string | null }} */ (await res.json());
    first ??= body;
    items.push(...body.items);
    cursor = body.next_cursor;
    if (!cursor) return { pull: first.pull, head: first.head, items };
  }
  throw new ServerError('the findings list did not end after 200 pages');
}

/**
 * @param {Response} res
 * @returns {Promise<{ type?: string, title?: string, detail?: string }>}
 */
async function readProblem(res) {
  try {
    return /** @type {{ type?: string, title?: string, detail?: string }} */ (await res.json());
  } catch {
    // not a problem+json body; the status line is all there is
    return {};
  }
}

/**
 * @param {number} status
 * @param {{ title?: string, detail?: string }} p
 */
function problemText(status, p) {
  const detail = [p.title, p.detail].filter(Boolean).join(' — ');
  const hint =
    status === 401
      ? ' (is REPOPULSE_TOKEN a current, unrevoked CI token?)'
      : status === 404
        ? ' (does the token name this repository?)'
        : '';
  return `RepoPulse answered HTTP ${status}${detail ? `: ${detail}` : ''}${hint}`;
}

/** @param {unknown} err */
function describe(err) {
  if (err instanceof Error) {
    const cause = /** @type {{ cause?: unknown }} */ (err).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}

/**
 * Whether the server has scanned the commit this pipeline is about.
 * @param {PrFindings} result
 * @param {CheckConfig} config
 */
export function headReady(result, config) {
  if (config.sha && result.pull.head_sha !== config.sha) return false;
  return result.head.scanned;
}

/**
 * Fetch, polling while the head is not scanned and --wait allows.
 * @param {CheckConfig} config
 * @param {typeof fetch} fetchImpl
 * @param {(ms: number) => Promise<void>} sleep
 * @param {() => number} now
 */
export async function fetchWhenReady(config, fetchImpl, sleep, now) {
  const deadline = now() + config.waitSeconds * 1000;
  for (;;) {
    /** @type {PrFindings} */
    let result;
    try {
      result = await fetchPrFindings(config, fetchImpl);
    } catch (err) {
      // Not ingested yet is "not ready", not a refusal (X-14): keep waiting.
      if (err instanceof NotSyncedError && now() < deadline) {
        await sleep(Math.min(15_000, Math.max(0, deadline - now())));
        continue;
      }
      throw err;
    }
    if (headReady(result, config) || now() >= deadline) return result;
    await sleep(Math.min(15_000, Math.max(0, deadline - now())));
  }
}

/** @param {Severity | 'none'} level */
export function severityRank(level) {
  return level === 'none' ? Infinity : SEVERITIES.indexOf(level) + 1;
}

/**
 * The verdict. Pure, so the thresholds are unit-tested without a server.
 *
 * @param {PrFindings} result
 * @param {CheckConfig} config
 * @returns {{ exitCode: number, reasons: string[], atOrAbove: Finding[], ready: boolean }}
 */
export function evaluate(result, config) {
  const reasons = [];
  const atOrAbove = result.items.filter((f) => f.severity >= severityRank(config.failOn));
  if (config.failOn !== 'none' && atOrAbove.length > 0) {
    reasons.push(
      `${atOrAbove.length} new finding${atOrAbove.length === 1 ? '' : 's'} at or above ${config.failOn}`,
    );
  }
  if (config.maxNew !== null && result.items.length > config.maxNew) {
    reasons.push(`${result.items.length} new findings (limit ${config.maxNew})`);
  }
  const ready = headReady(result, config);
  // Not-ready wins over a threshold: findings from an older head may already be
  // fixed in the commit this pipeline is testing, and failing the build on them
  // would blame the author for a scan that has not happened.
  if (!ready && !config.allowUnscanned) {
    const why =
      config.sha && result.pull.head_sha !== config.sha
        ? `RepoPulse has head ${short(result.pull.head_sha)}, not ${short(config.sha)}, for this PR`
        : `RepoPulse has not scanned head ${short(result.pull.head_sha)} yet`;
    return { exitCode: EXIT.NOT_READY, reasons: [why], atOrAbove, ready };
  }
  if (reasons.length > 0) return { exitCode: EXIT.THRESHOLD, reasons, atOrAbove, ready };
  return { exitCode: EXIT.PASS, reasons, atOrAbove, ready };
}

/** @param {string} sha */
function short(sha) {
  return sha.slice(0, 7);
}

/** @param {number} severity @returns {'error' | 'warning' | 'note'} */
export function sarifLevel(severity) {
  if (severity >= 4) return 'error';
  if (severity === 3) return 'warning';
  return 'note';
}

/** @param {Finding} f */
function ruleIdOf(f) {
  return f.rule_id ?? `repopulse.${f.scanner_key ?? f.dimension}`;
}

/**
 * SARIF 2.1.0 (OASIS), the shape GitHub code scanning, GitLab and most CI
 * dashboards ingest. One run, one rule per distinct rule id.
 *
 * @param {PrFindings} result
 * @param {CheckConfig} config
 */
export function toSarif(result, config) {
  /** @type {Map<string, number>} */
  const ruleIndex = new Map();
  /** @type {Record<string, unknown>[]} */
  const rules = [];
  for (const f of result.items) {
    const id = ruleIdOf(f);
    if (ruleIndex.has(id)) continue;
    ruleIndex.set(id, rules.length);
    rules.push({
      id,
      shortDescription: { text: f.title },
      defaultConfiguration: { level: sarifLevel(f.severity) },
      properties: { dimension: f.dimension, ...(f.scanner_key ? { scanner: f.scanner_key } : {}) },
    });
  }
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'RepoPulse',
            version: VERSION,
            informationUri: config.server,
            rules,
          },
        },
        results: result.items.map((f) => {
          const id = ruleIdOf(f);
          /** @type {Record<string, unknown>} */
          const out = {
            ruleId: id,
            ruleIndex: ruleIndex.get(id) ?? 0,
            level: sarifLevel(f.severity),
            message: { text: `${f.title}\n\n${f.evidence}` },
            partialFingerprints: { repopulseFindingId: String(f.id) },
            properties: {
              severity: f.severity_label,
              confidence: f.confidence,
              dimension: f.dimension,
              experimental: f.experimental,
              suggestedFix: f.suggested_fix,
            },
          };
          // A repository-level finding (a vulnerable dependency) has no file;
          // inventing one would point a reviewer at the wrong place.
          if (f.file) {
            /** @type {Record<string, unknown>} */
            const physicalLocation = { artifactLocation: { uri: f.file } };
            if (f.line_start !== null && f.line_start >= 1) {
              physicalLocation['region'] = {
                startLine: f.line_start,
                ...(f.line_end !== null && f.line_end >= f.line_start
                  ? { endLine: f.line_end }
                  : {}),
              };
            }
            out['locations'] = [{ physicalLocation }];
          }
          return out;
        }),
        // Not versionControlProvenance: that names the repository's own URI,
        // which RepoPulse's answer does not carry and must not be guessed.
        properties: { headSha: result.pull.head_sha, pullRequest: result.pull.number },
      },
    ],
  };
}

/** @param {string} text */
function cell(text) {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/</g, '&lt;');
}

/** A fence longer than any backtick run inside, so evidence cannot close it. @param {string} text */
function fenced(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

const MARKDOWN_ROWS = 50;

/**
 * Where a finding opens in RepoPulse (W20-08, UX_TODO FND-50): the findings
 * explorer's own deep link. A developer whose build fails on a wrong finding
 * needs the one screen where it can be dismissed.
 *
 * @param {CheckConfig} config
 * @param {number} id
 */
export function findingUrl(config, id) {
  return `${config.server}/findings?finding=${encodeURIComponent(String(id))}`;
}

/**
 * The summary your CI posts as a PR comment, with your own token.
 *
 * @param {PrFindings} result
 * @param {ReturnType<typeof evaluate>} verdict
 * @param {CheckConfig} config
 */
export function toMarkdown(result, verdict, config) {
  const n = result.items.length;
  const lines = [];
  const status =
    verdict.exitCode === EXIT.PASS
      ? 'passed'
      : verdict.exitCode === EXIT.NOT_READY
        ? 'not ready'
        : 'failed';
  lines.push(
    `### RepoPulse: ${n} new finding${n === 1 ? '' : 's'} on #${result.pull.number} — ${status}`,
  );
  lines.push('');
  const scanners = result.head.scanners.map((s) => s.scanner_key).join(', ');
  const pending = result.head.pending ?? [];
  const failed = result.head.failed ?? [];
  lines.push(
    result.head.scanned
      ? `Head \`${short(result.pull.head_sha)}\` scanned by: ${scanners || 'none'}.`
      : `Head \`${short(result.pull.head_sha)}\` has not been fully scanned yet; findings below may be from earlier commits of this PR.`,
  );
  // Which scanners the verdict is missing (W20-15, UX_TODO X-13): a pass with
  // a scanner still running or failed is a pass on a partial scan.
  if (pending.length > 0) lines.push(`Still scanning: ${pending.join(', ')}.`);
  if (failed.length > 0) {
    lines.push(`Failed at this head (their findings are missing): ${failed.join(', ')}.`);
  }
  const threshold = [
    config.failOn === 'none' ? 'no severity threshold' : `fail on ${config.failOn} or above`,
    config.maxNew === null ? null : `at most ${config.maxNew} new`,
  ]
    .filter(Boolean)
    .join(', ');
  lines.push(
    `Threshold: ${threshold}.${verdict.reasons.length ? ` ${verdict.reasons.join('; ')}.` : ''}`,
  );
  lines.push('');
  if (n === 0) {
    lines.push('No new findings.');
    return lines.join('\n') + '\n';
  }
  lines.push('| Severity | Finding | Location | Rule | |');
  lines.push('|---|---|---|---|---|');
  for (const f of result.items.slice(0, MARKDOWN_ROWS)) {
    const loc = f.file ? `${f.file}${f.line_start ? `:${f.line_start}` : ''}` : '(repository)';
    const tag = f.experimental ? ' _(experimental)_' : '';
    lines.push(
      `| ${f.severity_label} | ${cell(f.title)}${tag} | \`${cell(loc)}\` | \`${cell(ruleIdOf(f))}\` | [View in RepoPulse](${findingUrl(config, f.id)}) |`,
    );
  }
  if (n > MARKDOWN_ROWS) lines.push(`\n…and ${n - MARKDOWN_ROWS} more (see the SARIF report).`);
  lines.push('');
  for (const f of result.items.slice(0, MARKDOWN_ROWS)) {
    lines.push(`<details><summary>${cell(f.severity_label)}: ${cell(f.title)}</summary>`);
    lines.push('');
    lines.push(fenced(f.evidence));
    lines.push('');
    if (f.suggested_fix) lines.push(`**Suggested fix:** ${f.suggested_fix.replace(/\r?\n/g, ' ')}`);
    lines.push('</details>');
  }
  lines.push('');
  // The way out of a wrong finding, said where the developer is looking.
  lines.push(
    '_A finding that is wrong? Open it with "View in RepoPulse" and dismiss it with a reason; a dismissed finding no longer counts, so the next run of this check clears it._',
  );
  return lines.join('\n') + '\n';
}

/**
 * @typedef {object} Io
 * @property {(text: string) => void} out
 * @property {(text: string) => void} err
 * @property {typeof fetch} fetch
 * @property {(path: string, data: string) => Promise<void>} writeFile
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} now
 */

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {Io} io
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, env, io) {
  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs(argv, env);
  } catch (err) {
    io.err(`repopulse: ${describe(err)}\n\n${HELP}`);
    return EXIT.USAGE;
  }
  if (parsed.kind === 'help') {
    io.out(HELP);
    return EXIT.PASS;
  }
  if (parsed.kind === 'version') {
    io.out(`${VERSION}\n`);
    return EXIT.PASS;
  }
  const config = parsed.config;

  /** @type {PrFindings} */
  let result;
  try {
    result = await fetchWhenReady(config, io.fetch, io.sleep, io.now);
  } catch (err) {
    io.err(`repopulse: ${describe(err)}\n`);
    // The wait ran out before the PR was ingested: not ready, not broken (X-14).
    return err instanceof NotSyncedError ? EXIT.NOT_READY : EXIT.SERVER;
  }

  const verdict = evaluate(result, config);
  if (config.sarif)
    await io.writeFile(config.sarif, JSON.stringify(toSarif(result, config), null, 2));
  const markdown = toMarkdown(result, verdict, config);
  if (config.markdown) await io.writeFile(config.markdown, markdown);
  if (config.json) await io.writeFile(config.json, JSON.stringify(result, null, 2));

  io.out(markdown);
  return verdict.exitCode;
}

function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const code = await main(process.argv.slice(2), process.env, {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    fetch: globalThis.fetch,
    writeFile: (p, d) => writeFile(p, d, 'utf8'),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  });
  process.exitCode = code;
}
