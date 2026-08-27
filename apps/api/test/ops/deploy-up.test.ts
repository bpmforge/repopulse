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
    // or fail for the wrong reason.
    const composeAt = script.indexOf('"${COMPOSE[@]}" -f compose.yaml up -d');

    expect(mkdirAt, 'up.sh must create SCAN_RULES_DIR').toBeGreaterThan(-1);
    expect(composeAt).toBeGreaterThan(-1);
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
