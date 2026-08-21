import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGrypeMatches } from '../scanners/dependency/matches.js';
import { dependencyFindings } from '../scanners/dependency/findings.js';
import { validateVulnerabilities } from '../validation/index.js';
import { basePurl, compareVersions, parseRange, parseVersion, versionInRange } from './range.js';
import { applyVexStatements, coveringStatement, observationOf } from './statements.js';
import { vexFunnel } from './funnel.js';
import { openVexDocument } from './openvex.js';
import { embedVex } from './cyclonedx.js';
import { validateAgainstSchema } from './jsonschema.js';
import { CYCLONEDX_SCHEMA, OPENVEX_SCHEMA, VENDORED_SCHEMAS, schemaRegistry } from './schemas.js';
import { isVexJustification, isVexStatus, type VexStatementRecord } from './types.js';

// VEX — triage, suppression and export (W8-14, SECURITY_SUITE.md §3.6, FR-SEC-14/15).
//
// THE TOOL OUTPUT HERE IS REAL, following W8-06 and W8-13. Two captures of the
// SAME package at two versions are what make the suppression criteria provable
// rather than asserted, because the whole question is what happens when the
// version moves out from under a statement:
//
//   fixtures/vex/jquery-331-{sbom.cyclonedx,grype}.json  (NEW, W8-14)
//     mkdir w && cd w   # package.json + package-lock.json are beside the fixtures
//     syft scan dir:. -o cyclonedx-json -q > sbom.json
//     grype sbom:sbom.json -o json -q > grype.json
//     # syft 1.51.0, grype 0.117.0, deploy/scan-rules/vuln-db; absolute paths
//     # rewritten to /scan so the fixture reads like a sandbox run.
//   fixtures/dependency/jquery-{sbom.cyclonedx,grype}.json  (W8-06, reused)
//     the same package at 3.4.1.
//
// jquery 3.3.1 carries three advisories and 3.4.1 carries two of the same
// three, which is exactly the shape the reopen test needs: one vulnerability
// present at both versions, so the only thing that changes between the two
// scans is the version the statement was written about.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VEX_FIXTURES = path.resolve(HERE, '../../fixtures/vex');
const DEP_FIXTURES = path.resolve(HERE, '../../fixtures/dependency');

const readVex = (name: string): string => readFileSync(path.join(VEX_FIXTURES, name), 'utf8');
const readDep = (name: string): string => readFileSync(path.join(DEP_FIXTURES, name), 'utf8');

/**
 * The advisory jquery 3.3.1 and 3.4.1 both carry — the one triage is about.
 *
 * A CVE and not the GHSA grype leads with: V0 unions the alias set and promotes
 * the CVE to `primaryId`, leaving `GHSA-gxr4-xjj5-5px2` as an alias. Which of
 * the two a statement is keyed on is exactly what the alias test below exists
 * to make not matter.
 */
const SHARED_VULN = 'CVE-2020-11022';
const SHARED_VULN_GHSA = 'GHSA-gxr4-xjj5-5px2';

/** Runs the real V0-V3 funnel over a captured grype document. */
function validateFixture(grypeFile: string, fixtureDir: string) {
  const { matches, funnel } = parseGrypeMatches(
    grypeFile.startsWith('jquery-331') ? readVex(grypeFile) : readDep(grypeFile),
  );
  return validateVulnerabilities({
    matches,
    snapshotDir: fixtureDir,
    // grype's OWN pre-dedup count, so `raw -> deduped` is the whole narrowing.
    rawMatchCount: funnel.rawMatches,
  });
}

const covered = validateFixture('jquery-331-grype.json', VEX_FIXTURES);
const bumped = validateFixture('jquery-grype.json', path.join(DEP_FIXTURES, 'vulnerable'));

function statement(overrides: Partial<VexStatementRecord> = {}): VexStatementRecord {
  return {
    id: 1,
    packagePurl: 'pkg:npm/jquery',
    vulnId: SHARED_VULN,
    versionRange: '>=3.0.0 <3.4.0',
    status: 'not_affected',
    justification: 'vulnerable_code_not_in_execute_path',
    statusNotes: 'The import scan found no call into the affected selector path.',
    evidence: { reachability: 'manifest_only', finding_id: 42 },
    author: 'ada@example.com',
    createdAt: new Date('2026-08-01T09:00:00.000Z'),
    ...overrides,
  };
}

describe('the fixtures are the two versions the criteria need', () => {
  it('captures the same advisory at 3.3.1 and at 3.4.1', () => {
    // If this ever stops holding, every suppression test below is testing two
    // unrelated vulnerabilities and would pass for the wrong reason.
    const at331 = covered.vulnerabilities.map((v) => v.primaryId);
    const at341 = bumped.vulnerabilities.map((v) => v.primaryId);
    expect(at331).toContain(SHARED_VULN);
    expect(at341).toContain(SHARED_VULN);
    // And the GHSA really is carried as an alias rather than as a second row.
    const merged = covered.vulnerabilities.find((v) => v.primaryId === SHARED_VULN)!;
    expect(merged.aliases).toContain(SHARED_VULN_GHSA);
    expect(covered.vulnerabilities[0]!.packageVersion).toBe('3.3.1');
    expect(bumped.vulnerabilities[0]!.packageVersion).toBe('3.4.1');
  });
});

describe('version ranges', () => {
  it('reads the grammar it documents and refuses the rest', () => {
    expect(parseRange('*')).toEqual({ ok: true, clauses: [] });
    expect(parseRange('3.4.1')).toEqual({ ok: true, clauses: [{ op: '=', version: '3.4.1' }] });
    expect(parseRange('>=1.0.0 <2.0.0')).toEqual({
      ok: true,
      clauses: [
        { op: '>=', version: '1.0.0' },
        { op: '<', version: '2.0.0' },
      ],
    });
    // Refused at WRITE time, so an unreadable range can never become a stored
    // suppression whose meaning nobody can reconstruct.
    expect(parseRange('^1.0.0').ok).toBe(false);
    expect(parseRange('~1.0.0').ok).toBe(false);
    expect(parseRange('>=1.0.0 || <0.5.0').ok).toBe(false);
    expect(parseRange('').ok).toBe(false);
    expect(parseRange('not-a-version').ok).toBe(false);
  });

  it('orders releases, prereleases and suffixed versions', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
    // A missing segment is zero, which is what every ecosystem here means.
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    // A finished release outranks anything on the way to it.
    expect(compareVersions('2.0.0', '2.0.0-rc.1')).toBe(1);
    expect(compareVersions('2.0.0-rc.2', '2.0.0-rc.10')).toBe(-1);
    expect(compareVersions('2.0.0rc1', '2.0.0')).toBe(-1);
    expect(compareVersions('v1.0.0', '1.0.0+build.7')).toBe(0);
  });

  it('treats a version it cannot COMPARE as not covered', () => {
    // The fail-safe direction. A comparison we cannot make is not evidence
    // that a dismissal applies, so the finding stays open and says why.
    expect(parseVersion('1!2.0')).toBeNull();
    const verdict = versionInRange('1!2.0', '>=1.0.0');
    expect(verdict.covered).toBe(false);
    expect(verdict.reason).toMatch(/cannot be compared/);
  });

  it("honours '*' even for a version it cannot parse", () => {
    // Not an exception to the rule above but a different question. '*' is an
    // author saying "no version of this package is affected", which needs no
    // comparison to apply — there is nothing to compare it against.
    expect(versionInRange('1!2.0', '*').covered).toBe(true);
  });

  it('strips versions and syft qualifiers off a purl', () => {
    expect(basePurl('pkg:npm/jquery@3.4.1?package-id=a4e4575f')).toBe('pkg:npm/jquery');
    expect(basePurl('pkg:npm/@scope/pkg@1.0.0')).toBe('pkg:npm/@scope/pkg');
    expect(basePurl('pkg:golang/github.com/dgrijalva/jwt-go@3.2.0')).toBe(
      'pkg:golang/github.com/dgrijalva/jwt-go',
    );
  });
});

describe('suppression at a covered version', () => {
  it('creates ZERO new findings for the covered vulnerability', () => {
    const applied = applyVexStatements(covered.vulnerabilities, [statement()]);

    const suppressedIds = applied.suppressed.map((entry) => entry.vulnerability.primaryId);
    expect(suppressedIds).toEqual([SHARED_VULN]);

    // The acceptance criterion, measured where it actually matters: what the
    // mapper is handed. A suppressed vulnerability never reaches
    // persistFindings, so no row is created, updated or resolved for it.
    const before = dependencyFindings(
      covered.vulnerabilities,
      JSON.parse(readVex('jquery-331-sbom.cyclonedx.json')) as Record<string, unknown>,
    );
    const after = dependencyFindings(
      applied.reportable.map((entry) => entry.vulnerability),
      JSON.parse(readVex('jquery-331-sbom.cyclonedx.json')) as Record<string, unknown>,
    );
    expect(before.findings.length - after.findings.length).toBe(1);
    expect(after.findings.map((f) => f.ruleId)).not.toContain(SHARED_VULN);
  });

  it('leaves every OTHER advisory on the same package alone', () => {
    // A statement is about one vulnerability, never about a package. jquery
    // 3.3.1 carries three; dismissing one must not quieten the other two.
    const applied = applyVexStatements(covered.vulnerabilities, [statement()]);
    expect(applied.reportable).toHaveLength(covered.vulnerabilities.length - 1);
    expect(applied.reopened).toHaveLength(0);
  });

  it('matches a statement written against an ALIAS of the merged finding', () => {
    // The finding's primary id is the CVE; this statement names the GHSA. Both
    // are the same vulnerability, and which one V0 promoted depends on what the
    // database led with that day — so a statement keyed on the twin has to keep
    // applying, or the suppression lapses silently the next time grype reorders.
    const merged = covered.vulnerabilities.find((v) => v.primaryId === SHARED_VULN)!;
    expect(merged.aliases).toContain(SHARED_VULN_GHSA);

    const verdict = coveringStatement(
      [statement({ vulnId: SHARED_VULN_GHSA })],
      observationOf(merged),
    );
    expect(verdict.suppressed).toBe(true);
    expect(verdict.status).toBe('not_affected');
  });
});

describe('a version outside the covered range reopens the finding', () => {
  it('returns under_investigation, not the stored dismissal', () => {
    // Same statement, same vulnerability, same package — only the installed
    // version has moved past `<3.4.0`.
    const applied = applyVexStatements(bumped.vulnerabilities, [statement()]);

    const reopened = applied.reopened;
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.vulnerability.primaryId).toBe(SHARED_VULN);
    expect(reopened[0]!.verdict.status).toBe('under_investigation');
    expect(reopened[0]!.verdict.suppressed).toBe(false);
    // The row is still named, so a reader can see WHICH decision lapsed rather
    // than watching a finding reappear for no stated reason.
    expect(reopened[0]!.verdict.statement?.id).toBe(1);
    expect(reopened[0]!.verdict.reason).toMatch(/does not describe the version installed now/);
  });

  it('re-files the reopened vulnerability as a finding', () => {
    const applied = applyVexStatements(bumped.vulnerabilities, [statement()]);
    expect(applied.reportable.map((e) => e.vulnerability.primaryId)).toContain(SHARED_VULN);
  });

  it("a '*' statement survives the bump, because its author claimed every version", () => {
    // The other half of the same rule: reopening is not about the version
    // changing, it is about leaving the range someone examined.
    const applied = applyVexStatements(bumped.vulnerabilities, [statement({ versionRange: '*' })]);
    expect(applied.reopened).toHaveLength(0);
    expect(applied.suppressed.map((e) => e.vulnerability.primaryId)).toEqual([SHARED_VULN]);
  });

  it('prefers the most recent statement when two cover the same version', () => {
    const older = statement({ id: 1, versionRange: '*', createdAt: new Date('2026-01-01') });
    const correction = statement({
      id: 2,
      versionRange: '*',
      status: 'affected',
      justification: null,
      createdAt: new Date('2026-08-01'),
    });
    const applied = applyVexStatements(bumped.vulnerabilities, [older, correction]);
    // A correction must outrank the dismissal it replaces, or a mistake is
    // permanent.
    expect(applied.suppressed).toHaveLength(0);
    expect(
      applied.all.find((e) => e.vulnerability.primaryId === SHARED_VULN)?.verdict.statement?.id,
    ).toBe(2);
  });
});

describe('an affected statement never suppresses', () => {
  it('keeps the finding reportable', () => {
    const applied = applyVexStatements(covered.vulnerabilities, [
      statement({ status: 'affected', justification: null, versionRange: '*' }),
    ]);
    expect(applied.suppressed).toHaveLength(0);
    expect(applied.reportable).toHaveLength(covered.vulnerabilities.length);
  });
});

describe('the funnel reconciles (FR-SEC-15)', () => {
  it('partitions the deduped population across the triage buckets', () => {
    const applied = applyVexStatements(covered.vulnerabilities, [statement()]);
    const funnel = vexFunnel(covered.funnel, applied);

    expect(funnel.raw).toBe(covered.funnel.raw);
    expect(funnel.deduped).toBe(covered.vulnerabilities.length);
    // The buckets are a PARTITION of deduped, never a narrowing of it — that
    // is the honesty rule this whole shape exists to hold.
    expect(funnel.affected + funnel.notAffected + funnel.fixed + funnel.underInvestigation).toBe(
      funnel.deduped,
    );
    expect(funnel.scoped + funnel.unscoped).toBe(funnel.deduped);
    expect(funnel.notAffected).toBe(1);
    expect(funnel.byJustification.vulnerable_code_not_in_execute_path).toBe(1);
  });

  it('counts every justification key, including the zeroes', () => {
    // A missing key and a zero read differently in a UI: an absent bucket looks
    // like a justification nobody may use.
    const funnel = vexFunnel(covered.funnel, applyVexStatements(covered.vulnerabilities, []));
    expect(Object.keys(funnel.byJustification)).toHaveLength(5);
    expect(funnel.underInvestigation).toBe(funnel.deduped);
  });

  it('keeps machine PROPOSALS out of the decided counts', () => {
    const applied = applyVexStatements(covered.vulnerabilities, []);
    const funnel = vexFunnel(covered.funnel, applied);
    // Proposals sit beside the decisions and are never added to them: only a
    // person confirming moves a finding into notAffected.
    expect(funnel.notAffected).toBe(0);
    expect(funnel.proposedNotAffected).toEqual(covered.funnel.proposed);
  });

  it('counts the reopened separately inside under_investigation', () => {
    const funnel = vexFunnel(
      bumped.funnel,
      applyVexStatements(bumped.vulnerabilities, [statement()]),
    );
    expect(funnel.reopened).toBe(1);
    expect(funnel.underInvestigation).toBeGreaterThanOrEqual(funnel.reopened);
  });
});

// ── The exports, validated against the published schemas ─────────────────────

const registry = schemaRegistry();

describe('the vendored schemas are the published ones', () => {
  it('parses every file the registry claims', () => {
    for (const schema of VENDORED_SCHEMAS) expect(registry[schema.file]).toBeTypeOf('object');
    expect(registry[OPENVEX_SCHEMA]!['$id']).toBe(
      'https://github.com/openvex/spec/openvex_json_schema_0.2.0.json',
    );
    // The version syft emits, not the version we assumed — see schemas.ts.
    expect(registry[CYCLONEDX_SCHEMA]!['$id']).toContain('bom-1.7.schema.json');
  });
});

describe('the schema evaluator actually rejects things', () => {
  // Without these, every "the export is valid" test below would pass against a
  // validator that returns [] unconditionally, and prove nothing at all.
  it('rejects an OpenVEX document missing a required field', () => {
    const doc = openVexDocument([statement()], {
      author: 'ada@example.com',
      documentId: 'https://repopulse.invalid/vex/1',
      timestamp: new Date('2026-08-20T00:00:00.000Z'),
    });
    delete (doc as Record<string, unknown>)['author'];
    const violations = validateAgainstSchema(registry, OPENVEX_SCHEMA, doc);
    expect(violations.some((v) => v.keyword === 'required')).toBe(true);
  });

  it('rejects a status outside the OpenVEX enum', () => {
    const doc = openVexDocument([statement()], {
      author: 'ada@example.com',
      documentId: 'https://repopulse.invalid/vex/1',
      timestamp: new Date('2026-08-20T00:00:00.000Z'),
    });
    (doc['statements'] as Record<string, unknown>[])[0]!['status'] = 'probably_fine';
    expect(validateAgainstSchema(registry, OPENVEX_SCHEMA, doc).length).toBeGreaterThan(0);
  });

  it("rejects a not_affected statement with no justification — the spec's own gate", () => {
    // The 400 the triage route returns is the SAME rule the schema enforces:
    // an unjustified dismissal cannot leave this system by either door.
    const doc = openVexDocument([statement()], {
      author: 'ada@example.com',
      documentId: 'https://repopulse.invalid/vex/1',
      timestamp: new Date('2026-08-20T00:00:00.000Z'),
    });
    delete (doc['statements'] as Record<string, unknown>[])[0]!['justification'];
    const violations = validateAgainstSchema(registry, OPENVEX_SCHEMA, doc);
    expect(violations.some((v) => v.keyword === 'anyOf')).toBe(true);
  });

  it('rejects a malformed date-time', () => {
    const doc = openVexDocument([statement()], {
      author: 'ada@example.com',
      documentId: 'https://repopulse.invalid/vex/1',
      timestamp: new Date('2026-08-20T00:00:00.000Z'),
    });
    doc['timestamp'] = '20th August 2026';
    expect(
      validateAgainstSchema(registry, OPENVEX_SCHEMA, doc).some((v) => v.keyword === 'format'),
    ).toBe(true);
  });

  it('throws rather than ignoring a keyword it does not implement', () => {
    // The honesty guard from jsonschema.ts. A partial validator that skipped
    // the unknown would accept every document it was ever given.
    const local = { 'x.json': { type: 'object', patternProperties: { '^a': { type: 'string' } } } };
    expect(() => validateAgainstSchema(local, 'x.json', { ab: 1 })).toThrow(/not implemented/);
  });

  it('rejects a CycloneDX BOM with a bad analysis state', () => {
    const sbom = JSON.parse(readVex('jquery-331-sbom.cyclonedx.json')) as Record<string, unknown>;
    const { document } = embedVex(sbom, [statement()]);
    const vulns = document['vulnerabilities'] as Record<string, unknown>[];
    (vulns[0]!['analysis'] as Record<string, unknown>)['state'] = 'not_affected_probably';
    expect(validateAgainstSchema(registry, CYCLONEDX_SCHEMA, document).length).toBeGreaterThan(0);
  });

  it('rejects an OpenVEX justification emitted into the CycloneDX field', () => {
    // The exact bug the lossy mapping in cyclonedx.ts exists to prevent. The
    // two enums are different vocabularies, and this is what catches a lapse.
    const sbom = JSON.parse(readVex('jquery-331-sbom.cyclonedx.json')) as Record<string, unknown>;
    const { document } = embedVex(sbom, [statement()]);
    const vulns = document['vulnerabilities'] as Record<string, unknown>[];
    (vulns[0]!['analysis'] as Record<string, unknown>)['justification'] =
      'vulnerable_code_not_in_execute_path';
    expect(validateAgainstSchema(registry, CYCLONEDX_SCHEMA, document).length).toBeGreaterThan(0);
  });
});

describe('OpenVEX export', () => {
  const statements = [
    statement(),
    statement({ id: 2, vulnId: 'GHSA-jpcq-cgw6-v4j6', status: 'fixed', justification: null }),
    statement({
      id: 3,
      vulnId: 'GHSA-6c3j-c64m-qhgq',
      status: 'affected',
      justification: null,
      statusNotes: 'Upgrade to 3.5.0 is scheduled for the next release train.',
    }),
    statement({
      id: 4,
      vulnId: 'CVE-2020-11023',
      justification: 'vulnerable_code_cannot_be_controlled_by_adversary',
      versionRange: '*',
    }),
  ];

  it('validates against the published OpenVEX schema', () => {
    const doc = openVexDocument(statements, {
      author: 'security@repopulse.invalid',
      documentId: 'https://repopulse.invalid/vex/repo/7',
      timestamp: new Date('2026-08-20T10:00:00.000Z'),
    });
    expect(validateAgainstSchema(registry, OPENVEX_SCHEMA, doc)).toEqual([]);
  });

  it('identifies the product by a RESOLVABLE purl, not by a range', () => {
    // The bug this pins. The first draft wrote the range into the purl's
    // version position — `pkg:npm/jquery@>=3.0.0 <3.4.0` — which is neither a
    // valid IRI (the field's declared format) nor anything a consumer can
    // resolve. OpenVEX has no range field; the range belongs in prose.
    const doc = openVexDocument([statement()], {
      author: 'ada@example.com',
      documentId: 'https://repopulse.invalid/vex/1',
      timestamp: new Date('2026-08-20T10:00:00.000Z'),
    });
    const first = (doc['statements'] as Record<string, unknown>[])[0]!;
    const product = (first['products'] as { '@id': string; identifiers: { purl: string } }[])[0]!;
    expect(product['@id']).toBe('pkg:npm/jquery');
    expect(product.identifiers.purl).toBe('pkg:npm/jquery');
    expect(product['@id']).not.toMatch(/[\s<>]/);
    // And the range is still stated, because a statement whose covered versions
    // are invisible reads as covering all of them.
    expect(first['status_notes']).toContain('>=3.0.0 <3.4.0');
    expect(validateAgainstSchema(registry, OPENVEX_SCHEMA, doc)).toEqual([]);
  });

  it('rejects a product id with a character no IRI may hold', () => {
    // Proves the check above is the validator's and not just the exporter's.
    const doc = openVexDocument([statement()], {
      author: 'ada@example.com',
      documentId: 'https://repopulse.invalid/vex/1',
      timestamp: new Date('2026-08-20T10:00:00.000Z'),
    });
    const first = (doc['statements'] as Record<string, unknown>[])[0]!;
    (first['products'] as Record<string, unknown>[])[0]!['@id'] = 'pkg:npm/jquery@>=3.0.0 <3.4.0';
    const violations = validateAgainstSchema(registry, OPENVEX_SCHEMA, doc);
    expect(violations.some((v) => v.keyword === 'format')).toBe(true);
  });

  it('gives an affected statement the action statement the schema demands', () => {
    // "This is real" is not a finished thought — the spec insists the author
    // also say what happens next.
    const doc = openVexDocument([statements[2]!], {
      author: 'ada@example.com',
      documentId: 'https://repopulse.invalid/vex/1',
      timestamp: new Date('2026-08-20T10:00:00.000Z'),
    });
    const first = (doc['statements'] as Record<string, unknown>[])[0]!;
    expect(first['action_statement']).toContain('next release train');
    // The note carries both the author's own words and the covered range.
    expect(first['status_notes']).toContain('next release train');
    expect(first['status_notes']).toContain('>=3.0.0 <3.4.0');
    expect(validateAgainstSchema(registry, OPENVEX_SCHEMA, doc)).toEqual([]);
  });
});

describe('CycloneDX-embedded VEX export', () => {
  const sbom = () =>
    JSON.parse(readVex('jquery-331-sbom.cyclonedx.json')) as Record<string, unknown>;

  it('validates against the published CycloneDX 1.7 schema', () => {
    const { document } = embedVex(sbom(), [
      statement(),
      statement({ id: 2, vulnId: 'GHSA-jpcq-cgw6-v4j6', status: 'fixed', justification: null }),
      statement({ id: 3, vulnId: 'GHSA-6c3j-c64m-qhgq', status: 'affected', justification: null }),
    ]);
    expect(validateAgainstSchema(registry, CYCLONEDX_SCHEMA, document)).toEqual([]);
  });

  it('leaves the stored SBOM itself valid and unmodified', () => {
    // The stored document is the evidence a finding was computed against; an
    // exporter that edited it in place would make the record depend on who had
    // asked for a download.
    const original = sbom();
    const snapshot = JSON.stringify(original);
    const { document } = embedVex(original, [statement()]);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(document).not.toBe(original);
    expect(validateAgainstSchema(registry, CYCLONEDX_SCHEMA, original)).toEqual([]);
  });

  it('points affects[].ref at a bom-ref that is really in the document', () => {
    const { document } = embedVex(sbom(), [statement()]);
    const refs = new Set(
      (document['components'] as { 'bom-ref': string }[]).map((c) => c['bom-ref']),
    );
    const affects = (document['vulnerabilities'] as { affects: { ref: string }[] }[])[0]!.affects;
    expect(affects.length).toBeGreaterThan(0);
    for (const entry of affects) expect(refs.has(entry.ref)).toBe(true);
  });

  it('maps the OpenVEX enum onto CycloneDX and keeps the original in detail', () => {
    const { document } = embedVex(sbom(), [
      statement({ justification: 'vulnerable_code_cannot_be_controlled_by_adversary' }),
    ]);
    const analysis = (document['vulnerabilities'] as { analysis: Record<string, string> }[])[0]!
      .analysis;
    expect(analysis['justification']).toBe('protected_by_mitigating_control');
    // The mapping is lossy in both directions, so the verbatim term has to
    // survive somewhere a consumer can read it.
    expect(analysis['detail']).toContain('vulnerable_code_cannot_be_controlled_by_adversary');
    expect(analysis['detail']).toContain('not an exact twin');
  });

  it('reports a statement whose package is not in this SBOM instead of dangling', () => {
    const { document, unmatched } = embedVex(sbom(), [
      statement({ id: 9, packagePurl: 'pkg:npm/left-pad' }),
    ]);
    expect(unmatched.map((s) => s.id)).toEqual([9]);
    expect(document['vulnerabilities']).toHaveLength(0);
    // And the document it did produce is still valid — a dangling ref would
    // have failed the schema, which is why they are dropped and reported.
    expect(validateAgainstSchema(registry, CYCLONEDX_SCHEMA, document)).toEqual([]);
  });
});

describe('the enum guards the route relies on', () => {
  it('accepts only the published vocabularies', () => {
    expect(isVexStatus('not_affected')).toBe(true);
    expect(isVexStatus('under_investigation')).toBe(true);
    expect(isVexStatus('probably_fine')).toBe(false);
    expect(isVexJustification('vulnerable_code_not_present')).toBe(true);
    expect(isVexJustification('we_looked_at_it')).toBe(false);
  });
});
