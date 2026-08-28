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

  it('the MONTHLY history sweep is scheduled and fans out per repo (W8-05)', () => {
    // Stream mode cannot see a credential committed last March and deleted in
    // April, so history mode is the only thing that finds it — and a history
    // mode nobody schedules finds nothing at all.
    const entry = readFileSync(new URL('./index.ts', import.meta.url).pathname, 'utf8');
    expect(entry).toContain('SECRETS_HISTORY_CRON');
    expect(entry).toContain("'history-sweep'");
    expect(entry).toContain('runSecretsHistoryScan');
    // Off-switch, like the reconcile cron: a sweep starts work nobody asked
    // for at a wall-clock time, which is wrong in a test harness.
    expect(entry).toContain("historyCron !== 'off'");

    const processor = readFileSync(
      new URL('./scan-processor.ts', import.meta.url).pathname,
      'utf8',
    );
    // Looked up in an injected map, never a switch on the key: FR-SEC-1 says
    // the framework does not know scanner names.
    expect(processor).toContain('deps.historyRunners?.[data.scannerKey]');
    const code = processor
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/switch\s*\(\s*\w*[sS]cannerKey/);
  });

  it('the OWASP checklists have a caller, and are MANUAL only (W16-33)', () => {
    // runOwaspChecklist had no caller, so both read "not in this build" on
    // every install — truthfully, which is the only reason it was not worse.
    const entry = readFileSync(new URL('./index.ts', import.meta.url).pathname, 'utf8');
    expect(entry).toContain('runOwaspChecklist');
    expect(entry).toContain('owasp_web: async');
    expect(entry).toContain('owasp_llm: async');
    // NOT on the weekly cron: a checklist is a gateway call per chunk, and
    // their own defaults say a human starts them. Putting them in that list
    // would run a model over every repo every week without anyone asking.
    expect(entry).not.toContain("['owasp_web', weeklyCron]");
    expect(entry).not.toContain("['owasp_llm', weeklyCron]");
    // A DIFF, not the weekly snapshot the other scanners share.
    expect(entry).toContain('diffOf(');
  });

  it('the dependency scanner has a caller at last (W16-36)', () => {
    // W8-06 was marked done and runDependencyScan had NO caller anywhere, so
    // security.sboms had never held a row: the Security tab told every reader
    // "the CVE scanner is not available yet", the supply-chain register
    // returned no_sbom every night, and owasp_llm could only ever skip for
    // want of a document to read. One scanner unwired, four screens telling
    // the truth about it.
    const entry = readFileSync(new URL('./index.ts', import.meta.url).pathname, 'utf8');
    expect(entry).toContain('runDependencyScan');
    expect(entry).toContain('dependency_cve: async');
    // And it is SCHEDULED, not merely wired — the shape of failure this whole
    // wave has been about is a runner nothing enqueues.
    expect(entry).toContain("['dependency_cve', weeklyCron]");
  });

  it('the scanners use the SAME forge config as ingestion (W16-29)', () => {
    // Six scan runners each built `providerForRepo({ db, tokenKey })` with no
    // forge options, so FORGE_BASE_URL and the SC-12 loopback opt-in were
    // honoured by ingestion and silently dropped by every scan. Invisible
    // against api.github.com, because that IS the fallback — and in demo mode
    // it sent the fake credential to the real GitHub.
    const entry = readFileSync(new URL('./index.ts', import.meta.url).pathname, 'utf8');
    expect(entry).toContain('scanForgeDeps');
    // Not a second reading of the env with its own spelling: one object, so a
    // runner added later cannot forget half of it.
    const code = entry
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/providerForRepo\(\s*\{\s*db,\s*tokenKey/);
    const scanDeps = entry.slice(entry.indexOf('const scanForgeDeps'));
    expect(scanDeps.slice(0, 600)).toContain('FORGE_BASE_URL');
    expect(scanDeps.slice(0, 600)).toContain('FORGE_ALLOW_INSECURE_LOOPBACK');
  });

  it('the WEEKLY pass is one schedule for two scanners (W8-07 + W8-09)', () => {
    // A semgrep full run and a chain recompute are the same shape of work, and
    // two crons doing it would drift. The chainer runs AFTER the full scan on
    // purpose: a chain built from findings a full scan is about to replace is
    // a chain about last week.
    const entry = readFileSync(new URL('./index.ts', import.meta.url).pathname, 'utf8');
    expect(entry).toContain('SECURITY_WEEKLY_CRON');
    expect(entry).toContain('SECURITY_CHAIN_CRON');
    expect(entry).toContain('runSemgrepFull');
    expect(entry).toContain('runChainer');
    expect(entry).toContain("weeklyCron !== 'off'");

    const processor = readFileSync(
      new URL('./scan-processor.ts', import.meta.url).pathname,
      'utf8',
    );
    expect(processor).toContain('deps.weeklyRunners?.[data.scannerKey]');
    // W9-02 rides the same slot: both scanners want a snapshot of the same
    // commit, and a second weekly cron would drift from this one.
    expect(entry).toContain('runCodeHealthScan');
    expect(entry).toContain("'code_health_tools'");
  });

  it('the nightly reprice runs INSIDE the snapshot job (W9-09)', () => {
    // Not a separate cron: the hotspot percentiles the pricer reads are the
    // ones the snapshot just wrote, and a separate job would race the write it
    // depends on — a scoreboard lagging a day behind its own inputs.
    const processors = readFileSync(
      new URL('./processors.ts', import.meta.url).pathname,
      'utf8',
    );
    expect(processors).toContain('repriceFindings');
    expect(processors).toContain('hotspotPercentiles');
    // The precision prior is one grouped query per pass, not one per finding.
    expect(processors).toContain('ruleFpRatesFor');
  });
});
