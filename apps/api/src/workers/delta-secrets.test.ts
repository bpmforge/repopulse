import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The secrets scanner is CALLED by the delta path (W8-04, FR-SEC-3).
//
// Stream mode's entire claim is "a finding within 60s of the webhook", and the
// webhook delta is the only thing that runs on that clock. A scanner wired to
// nothing meets the claim in the same way an empty repository does — which is
// the defect this codebase has now hit often enough to have a gate for it.

describe('delta -> secrets stream (W8-04)', () => {
  it('the WORKER ENTRYPOINT passes runSecretsStream, not just the type', () => {
    // The half that has been wrong four times before: the dependency exists,
    // the tests inject it, and production never does.
    const entry = readFileSync(new URL('./index.ts', import.meta.url).pathname, 'utf8');
    expect(entry).toContain('runSecretsStream:');
    expect(entry).toContain('runSecretsStreamScan');

    const processors = readFileSync(new URL('./processors.ts', import.meta.url).pathname, 'utf8');
    // And the delta processor calls it for exactly the two triggers stream
    // mode claims (SECURITY_SUITE 3.1).
    expect(processors).toContain('deps.runSecretsStream');
    expect(processors).toContain("data.kind === 'pull_requests'");
    expect(processors).toContain("data.kind === 'push_commits'");
  });
});
