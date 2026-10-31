import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { usablePromptParts, type PromptParts } from '../gateway/types.js';
import { ProviderError } from '../t2/client.js';

// The customer-supplied Claude Code CLI as a model backend (W19-08).
//
// WHAT THIS IS AND IS NOT. The customer installs the `claude` CLI and signs in
// to it themselves, inside their own container. RepoPulse runs it as a
// subprocess, hands it a prompt on stdin, and reads one JSON object back. It
// never reads, stores, forwards or logs the login: that lives in the CLI's own
// config directory, which this file does not open. The only identity-bearing
// thing it asks for is `claude auth status`, and it reads one boolean from it.
//
// CONSTRAINED, because the CLI is an agent and this is a text-completion call:
//   --tools ""              no tools at all: it cannot run commands or read files
//   --no-session-persistence nothing is written to disk about this call
//   an empty temp directory  as cwd, so no project file or CLAUDE.md is picked up
//   a minimal environment    only what the CLI needs to find its own login and
//                            reach the network; none of RepoPulse's secrets
// The prompt goes on STDIN, not argv: code in argv is visible to every process
// on the machine.
//
// FAILS CLOSED, loudly, in the words an operator needs: a missing binary and an
// expired login are different fixes. Every failure is a ProviderError, so a
// routing chain falls back past it.

export const DEFAULT_BINARY = 'claude';

/** The customer may have installed the CLI outside PATH (CLAUDE_CLI_PATH); otherwise `claude`. */
export const cliBinary = (deps: { binary?: string } = {}): string =>
  deps.binary ?? process.env.CLAUDE_CLI_PATH ?? DEFAULT_BINARY;
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** The only variables the child inherits. Anything not named here does not reach it. */
const ENV_ALLOW = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TERM',
  // The CLI's own config location, if the customer moved it.
  'CLAUDE_CONFIG_DIR',
  // A customer behind a proxy needs these to reach Anthropic at all.
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
] as const;

export function childEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOW) if (source[k] !== undefined) out[k] = source[k];
  return out;
}

export interface CliDeps {
  spawnImpl?: typeof nodeSpawn;
  binary?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CliResult {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Already inside tokensIn (W23-06). */
  cacheReadTokens: number;
  durationMs: number;
}

const NOT_FOUND = (bin: string): string =>
  `The Claude Code CLI ("${bin}") was not found. It is customer-supplied: install it in this container and sign in (run \`claude\` once and complete the login), then try again. Nothing was sent.`;
const SIGNED_OUT = (detail: string): string =>
  `The Claude Code CLI is signed out or its login expired (${detail}). Sign in again inside this container (run \`claude\` and complete the login). Nothing was processed.`;

const AUTH_PATTERN =
  /authenticat|oauth|log\s?in|sign\s?in|session expired|credential|unauthori[sz]ed|401/i;

interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
  timedOut: boolean;
}

function run(
  bin: string,
  args: string[],
  input: string | null,
  cwd: string,
  deps: CliDeps,
): Promise<Spawned> {
  const spawnImpl = deps.spawnImpl ?? nodeSpawn;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(bin, args, {
        cwd,
        env: deps.env ?? childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        error: err as NodeJS.ErrnoException,
        timedOut: false,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    // A closed stdin (the child died first) must not throw into the caller.
    child.stdin?.on('error', () => undefined);
    if (input !== null) child.stdin?.write(input);
    child.stdin?.end();
  });
}

async function inEmptyDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'repopulse-cli-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const cliArgs = (model: string, staticPrompt?: string): string[] => [
  '-p',
  '--output-format',
  'json',
  '--tools',
  '',
  '--no-session-persistence',
  '--model',
  model,
  // W23-06: the static half of the prompt (checklist + schema + rules) goes on
  // the system side, APPENDED to the CLI's own system prompt rather than
  // replacing it, so the CLI's behaviour is unchanged and the byte-identical
  // prefix is what its prompt cache sees. It is our own fixed text, never the
  // customer's code, so having it in argv does not expose anything the stdin
  // rule protects; the diff stays on stdin.
  ...(staticPrompt ? ['--append-system-prompt', staticPrompt] : []),
];

interface CliJson {
  is_error?: boolean;
  result?: unknown;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
}

function parseCliJson(text: string): CliJson | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' ? (v as CliJson) : null;
  } catch {
    return null;
  }
}

export async function runClaudeCli(
  prompt: string,
  model: string,
  deps: CliDeps = {},
  parts?: PromptParts,
): Promise<CliResult> {
  const bin = cliBinary(deps);
  const started = Date.now();
  // With a usable split: static -> system flag, dynamic -> stdin. Otherwise the
  // whole prompt on stdin, exactly as before.
  const split = usablePromptParts(prompt, parts);
  const r = await inEmptyDir((dir) =>
    run(bin, cliArgs(model, split?.static), split ? split.dynamic : prompt, dir, deps),
  );

  if (r.error?.code === 'ENOENT') throw new ProviderError(NOT_FOUND(bin));
  if (r.error)
    throw new ProviderError(`The Claude Code CLI could not be started: ${r.error.message}`);
  if (r.timedOut) {
    throw new ProviderError(
      `The Claude Code CLI did not answer within ${Math.round((deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s and was stopped.`,
    );
  }

  const body = parseCliJson(r.stdout);

  if (body === null) {
    const tail = (r.stderr || r.stdout).trim().slice(-300);
    if (AUTH_PATTERN.test(tail)) throw new ProviderError(SIGNED_OUT(tail));
    throw new ProviderError(
      `The Claude Code CLI exited ${r.code ?? 'abnormally'} without a usable answer${tail ? `: ${tail}` : ''}`,
    );
  }
  const text = typeof body.result === 'string' ? body.result : '';
  if (body.is_error === true || (r.code !== 0 && r.code !== null)) {
    if (AUTH_PATTERN.test(text)) throw new ProviderError(SIGNED_OUT(text.slice(0, 200)));
    throw new ProviderError(
      `The Claude Code CLI reported an error: ${text.slice(0, 300) || `exit ${r.code}`}`,
    );
  }

  const u = body.usage ?? {};
  const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  return {
    text,
    model: Object.keys(body.modelUsage ?? {})[0] ?? model,
    // Cached input still went to the model, so it counts as input.
    tokensIn: n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens'),
    tokensOut: n('output_tokens'),
    cacheReadTokens: n('cache_read_input_tokens'),
    durationMs: Date.now() - started,
  };
}

export interface CliStatus {
  found: boolean;
  version: string | null;
  /**
   * What `claude auth status` SAYS. It can say true while the session has
   * expired (observed), so it is a hint and never proof; only a real call is.
   */
  reportsLoggedIn: boolean | null;
  reason: string | null;
}

/** Presence, version and the CLI's own opinion of its login. No model call, no token spend. */
export async function claudeCliStatus(deps: CliDeps = {}): Promise<CliStatus> {
  const bin = cliBinary(deps);
  return inEmptyDir(async (dir) => {
    const v = await run(bin, ['--version'], null, dir, { ...deps, timeoutMs: 15_000 });
    if (v.error?.code === 'ENOENT') {
      return { found: false, version: null, reportsLoggedIn: null, reason: NOT_FOUND(bin) };
    }
    if (v.error || v.code !== 0) {
      return {
        found: false,
        version: null,
        reportsLoggedIn: null,
        reason: `could not run "${bin} --version"`,
      };
    }
    const version = v.stdout.trim().split('\n')[0] ?? null;
    const a = await run(bin, ['auth', 'status', '--json'], null, dir, {
      ...deps,
      timeoutMs: 15_000,
    });
    let reportsLoggedIn: boolean | null = null;
    try {
      // Only the boolean is read. The same object carries an email and an
      // organisation; they are neither kept nor returned.
      const j = JSON.parse(a.stdout) as { loggedIn?: unknown };
      if (typeof j.loggedIn === 'boolean') reportsLoggedIn = j.loggedIn;
    } catch {
      reportsLoggedIn = null;
    }
    return { found: true, version, reportsLoggedIn, reason: null };
  });
}
