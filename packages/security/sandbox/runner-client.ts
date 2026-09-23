import { request as httpRequest } from 'node:http';
import {
  parseRunnerAddress,
  RUNNER_AUTH_HEADER,
  RUNNER_RUN_PATH,
  RUNNER_STATUS_PATH,
  runnerProblemSchema,
  runnerResponseSchema,
  runnerStatusSchema,
  type RunnerRequest,
  type RunnerResponse,
  type RunnerStatus,
} from './runner-protocol.js';

// The worker's side of the scan-runner boundary (W17-27).
//
// HTTP over either a unix socket (tests, non-SELinux hosts) or a TCP port on
// the internal `scan` compose network that only the worker and the runner
// join, with a bearer token on top (the packaged default — see
// runner-protocol.ts for why a shared-volume socket cannot work on an SELinux
// host). node's fetch() cannot address a unix socket, hence node:http directly.

export class RunnerUnavailableError extends Error {
  constructor(address: string, cause: string) {
    super(`scan-runner at ${address} is not reachable: ${cause}`);
    this.name = 'RunnerUnavailableError';
  }
}

interface HttpResult {
  status: number;
  body: string;
}

function call(
  address: string,
  method: 'GET' | 'POST',
  path: string,
  body: string | undefined,
  timeoutMs: number,
  token?: string,
): Promise<HttpResult> {
  const target = parseRunnerAddress(address);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        ...(target.kind === 'unix'
          ? { socketPath: target.path }
          : { host: target.host, port: target.port }),
        method,
        path,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { [RUNNER_AUTH_HEADER]: `Bearer ${token}` } : {}),
        },
        // node's default socket timeout is none; a runner that hangs must not
        // hang the worker's job forever. The runner enforces the scan's own
        // wall clock; this bound is for the runner itself going away.
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`no response within ${timeoutMs}ms`));
    });
    req.on('error', (err) => reject(new RunnerUnavailableError(address, err.message)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Asks the runner to run one scan container.
 *
 * A refusal (4xx) and a runner fault (5xx) both come back as a `failed`
 * result carrying the runner's sentence, so they land on the scan_run row the
 * same way a tool failure does — the screen already knows how to show that.
 * Only an UNREACHABLE runner throws, and then with a name the processor can
 * recognise.
 */
export async function runViaRunner(
  address: string,
  req: RunnerRequest,
  token: string | undefined = configuredRunnerToken(),
): Promise<RunnerResponse> {
  const startedAt = Date.now();
  // The runner kills the container at wallClockMs; give it time to say so.
  const res = await call(
    address,
    'POST',
    RUNNER_RUN_PATH,
    JSON.stringify(req),
    (req.budget?.wallClockMs ?? 60_000) + 30_000,
    token,
  );
  const durationMs = Date.now() - startedAt;

  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    return {
      status: 'failed',
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs,
      error: `scan-runner answered ${res.status} with a non-JSON body`,
    };
  }

  if (res.status === 200) {
    const parsed = runnerResponseSchema.safeParse(json);
    if (parsed.success) return parsed.data;
    return {
      status: 'failed',
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs,
      error: `scan-runner answered with an unrecognised result: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    };
  }

  const problem = runnerProblemSchema.safeParse(json);
  return {
    status: 'failed',
    exitCode: null,
    stdout: '',
    stderr: '',
    durationMs,
    error: `scan-runner refused (${res.status}): ${problem.success ? problem.data.error : res.body.slice(0, 300)}`,
  };
}

/** The runner's capability report. Throws when the runner is unreachable. */
export async function runnerStatus(address: string, timeoutMs = 10_000): Promise<RunnerStatus> {
  const res = await call(address, 'GET', RUNNER_STATUS_PATH, undefined, timeoutMs);
  if (res.status !== 200) throw new Error(`scan-runner status answered ${res.status}`);
  return runnerStatusSchema.parse(JSON.parse(res.body));
}

/**
 * Where the worker should send scans, if this process is packaged behind a
 * runner: SCAN_RUNNER_URL (http://host:port) or SCAN_RUNNER_SOCKET (a path).
 * Neither set means "spawn the runtime locally" — the dev checkout.
 */
export function configuredRunnerAddress(): string | undefined {
  for (const name of ['SCAN_RUNNER_URL', 'SCAN_RUNNER_SOCKET']) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/** The shared secret the runner expects on /v1/run, when one is configured. */
export function configuredRunnerToken(): string | undefined {
  const value = process.env.SCAN_RUNNER_TOKEN;
  return value === undefined || value === '' ? undefined : value;
}
