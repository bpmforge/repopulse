import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// DEPLOY HEALTH-CHECK DRIFT GATE (W16-04).
//
// `podman compose -f deploy/compose.yaml up -d` on a clean host started five of
// six services and left the worker dead on a bind mount whose source did not
// exist. The stack still LOOKED healthy — the web tier answered 200 on :8099 —
// and the compose wrapper exited 0 while printing `exit status 125`. So
// deploy/up.sh creates the mount source and then verifies every service is
// actually running.
//
// That verification is a hardcoded service list, which is exactly the kind of
// copy that rots: add a seventh service to compose.yaml, forget this list, and
// the stack silently goes back to reporting success with a dead container. This
// test is the thing that fails instead.
//
// Deliberately reads both files as TEXT rather than parsing YAML. The assertion
// is about two lists agreeing, and a parser would add a dependency to check a
// property a regex states more plainly.

const repoRoot = new URL('../../../../', import.meta.url).pathname;

function read(rel: string): string {
  return readFileSync(repoRoot + rel, 'utf8');
}

/** Top-level service names in the compose file. */
function composeServices(): string[] {
  const text = read('deploy/compose.yaml');
  // Stop at the next TOP-LEVEL key. `volumes:` sits at the bottom of the file
  // and its entries (pgdata, redisdata) are indented exactly like a service, so
  // reading to end-of-file collects them as services.
  const after = text.slice(text.indexOf('\nservices:') + 1);
  const end = /\n(?=[a-z][a-z0-9_-]*:)/.exec(after.slice('services:'.length));
  const body = end ? after.slice(0, 'services:'.length + end.index) : after;
  const out: string[] = [];
  for (const line of body.split('\n')) {
    // Exactly two spaces of indent: a service key, not a key inside one.
    const m = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/** The service names deploy/up.sh checks are running. */
function verifiedServices(): string[] {
  const m = /^EXPECTED="([^"]+)"/m.exec(read('deploy/up.sh'));
  if (!m?.[1]) throw new Error('deploy/up.sh no longer declares EXPECTED="..."');
  return m[1].split(/\s+/).filter(Boolean);
}

describe('deploy/up.sh health check (W16-04)', () => {
  it('verifies every long-running compose service', () => {
    // `migrate` is excluded on purpose and only `migrate`: it is a one-shot job
    // whose success is having EXITED, so asserting it is running would fail on
    // every healthy stack. Naming it here rather than filtering by a pattern
    // means a second one-shot service has to be considered, not absorbed.
    const oneShot = new Set(['migrate']);
    const expected = composeServices().filter((s) => !oneShot.has(s));

    expect(expected.length, 'compose.yaml services were not parsed').toBeGreaterThan(0);
    expect([...verifiedServices()].sort()).toEqual([...expected].sort());
  });

  it('creates the scan-rules mount source before compose runs', () => {
    // The whole defect in one line: the bind mount fails at container-creation
    // time, so the worker cannot degrade gracefully — there is nothing running
    // to degrade. The directory has to exist BEFORE compose is invoked.
    const script = read('deploy/up.sh');
    const mkdirAt = script.indexOf('mkdir -p "$SCAN_RULES_DIR"');
    // The real invocation, not the `up -d` inside this script's own header
    // comment — which is earlier in the file and would make the assertion pass
    // or fail for the wrong reason. Matched by shape rather than by an exact
    // string: W17-04 inserted `-p "$REPOPULSE_PROJECT"` so a test stack cannot
    // collide with the operator's, and pinning the literal made this assertion
    // fail for a reason it does not care about.
    // W20-16: the files are now an array that always starts with compose.yaml
    // (`COMPOSE_FILES=(-f compose.yaml)`) plus any COMPOSE_EXTRA_FILES overlay.
    const composeAt = script.search(/\$\{COMPOSE\[@\]\}"[^\n]*"\$\{COMPOSE_FILES\[@\]\}" up -d/);
    expect(script).toContain('COMPOSE_FILES=(-f compose.yaml)');

    expect(mkdirAt, 'up.sh must create SCAN_RULES_DIR').toBeGreaterThan(-1);
    expect(composeAt, 'up.sh must invoke compose up on compose.yaml').toBeGreaterThan(-1);
    expect(mkdirAt, 'the directory must be created BEFORE compose up').toBeLessThan(composeAt);
  });

  it('still defaults SCAN_RULES_DIR to the production path in compose.yaml', () => {
    // up.sh picks the shipped deploy/scan-rules only when the operator has not
    // chosen one. The compose default stays absolute and outside the checkout,
    // because on a real host the rules are refreshed by a timer and must
    // survive the checkout being deleted.
    expect(read('deploy/compose.yaml')).toContain(
      '${SCAN_RULES_DIR:-/var/lib/repopulse/scan-rules}',
    );
  });
});

describe('container healthchecks use binaries the image HAS (W17-06)', () => {
  // Verified in-image on 2026-09-08:
  //   worker (node:22-alpine)  node yes, wget yes, curl NO
  //   web    (nginx:1.27-alpine) wget yes, curl yes, nc yes, node NO
  // Copying the api probe into the web stage would mark every web container
  // unhealthy forever, and the failure would look like a broken web tier.
  const dockerfile = read('Dockerfile');

  /** The body of a stage, from `FROM ... AS <name>` to the next FROM. */
  function stage(name: string): string {
    const start = dockerfile.search(new RegExp(`^FROM .* AS ${name}$`, 'm'));
    expect(start, `stage ${name} not found`).toBeGreaterThan(-1);
    const after = dockerfile.slice(start + 1);
    const end = after.search(/^FROM /m);
    return end === -1 ? after : after.slice(0, end);
  }

  it('every long-running stage declares a healthcheck', () => {
    for (const name of ['api', 'worker', 'web']) {
      expect(stage(name), `${name} has no HEALTHCHECK`).toContain('HEALTHCHECK');
    }
  });

  it('the web stage does NOT use node — nginx:alpine has none', () => {
    const web = stage('web');
    const healthLine = web.slice(web.indexOf('HEALTHCHECK'));
    expect(healthLine).not.toMatch(/\bnode\b/);
    expect(healthLine).toMatch(/wget|curl/);
  });

  it('the worker stage does NOT use curl — it is not installed there', () => {
    const worker = stage('worker');
    const healthLine = worker.slice(worker.indexOf('HEALTHCHECK'));
    expect(healthLine).not.toMatch(/\bcurl\b/);
    expect(healthLine).toMatch(/\bnode\b/);
  });

  it('the worker probe targets the worker health port, not the API port', () => {
    const worker = stage('worker');
    expect(worker.slice(worker.indexOf('HEALTHCHECK'))).toContain('WORKER_HEALTH_PORT');
  });
});

describe('cross-arch bundle build (W11-01, 2026-09-23)', () => {
  // `deploy/bundle.sh --arch=amd64` on an arm64 host died in `vite build`:
  // esbuild is a Go binary, and under qemu-user emulation the Go runtime
  // aborts (`fatal error: lfstack.push`) — twice, deterministically. The SPA's
  // output is static files that are identical on every arch, so the web build
  // runs on the BUILD platform and only nginx is the target arch.
  const dockerfile = read('Dockerfile');

  it('the web asset build stage runs on $BUILDPLATFORM, never under emulation', () => {
    expect(dockerfile).toMatch(/^FROM --platform=\$BUILDPLATFORM \S+ AS web-build$/m);
  });

  it('the runtime stages stay on the target platform (no --platform on them)', () => {
    for (const name of ['base', 'web']) {
      expect(dockerfile).toMatch(new RegExp(`^FROM (?!--platform)\\S+ AS ${name}$`, 'm'));
    }
  });
});
