import { z } from 'zod';
import type { ExternalResult } from './map.js';

// SARIF 2.1.0 intake (W18-24).
//
// A SARIF file is UNTRUSTED INPUT from whoever holds an admin session — the
// same standing as a repository's contents. Three rules follow:
//
//   NOTHING IN IT IS EXECUTED OR FOLLOWED. URIs are read as strings and turned
//   into repo-relative paths; nothing is fetched, opened or resolved against
//   the filesystem, and `..` is refused rather than normalised away.
//
//   ONLY WHAT WE MAP IS KEPT. The zod schema below is the subset of the OASIS
//   2.1.0 schema we read, and zod strips every key it does not name. Snippets,
//   code flows, graphs, fixes, invocations (which carry command lines and
//   environment) and attachments are never read, so they are never stored.
//
//   BOUNDED. The HTTP layer caps the body; this caps runs, results and the
//   strings we keep, so a well-formed file cannot ask for unbounded work.

export const SARIF_VERSION = '2.1.0';
export const MAX_RUNS = 20;
export const MAX_RESULTS = 20_000;
const MAX_RULES_PER_COMPONENT = 10_000;

const text = z.string().max(100_000);
const message = z
  .object({
    text: text.optional(),
    markdown: text.optional(),
    id: z.string().max(200).optional(),
    arguments: z.array(z.string().max(2_000)).max(50).optional(),
  })
  .optional();

const propertyBag = z
  .object({
    tags: z.array(z.string().max(200)).max(100).optional(),
    // GitHub's documented property: a string holding a 0.0-10.0 number.
    'security-severity': z.union([z.string().max(20), z.number()]).optional(),
    precision: z.string().max(40).optional(),
  })
  .optional();

const rule = z.object({
  id: z.string().min(1).max(500),
  name: z.string().max(500).optional(),
  shortDescription: z.object({ text: text.optional() }).optional(),
  fullDescription: z.object({ text: text.optional() }).optional(),
  messageStrings: z.record(z.string().max(200), z.object({ text: text.optional() })).optional(),
  defaultConfiguration: z
    .object({ level: z.enum(['none', 'note', 'warning', 'error']).optional() })
    .optional(),
  properties: propertyBag,
});

const toolComponent = z.object({
  name: z.string().min(1).max(200),
  version: z.string().max(200).optional(),
  semanticVersion: z.string().max(200).optional(),
  rules: z.array(rule).max(MAX_RULES_PER_COMPONENT).optional(),
});

const artifactLocation = z
  .object({
    uri: z.string().max(4_000).optional(),
    uriBaseId: z.string().max(200).optional(),
    index: z.number().int().min(0).optional(),
  })
  .optional();

const location = z.object({
  physicalLocation: z
    .object({
      artifactLocation,
      region: z
        .object({
          startLine: z.number().int().min(1).optional(),
          endLine: z.number().int().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
});

const result = z.object({
  ruleId: z.string().max(500).optional(),
  ruleIndex: z.number().int().min(0).optional(),
  rule: z
    .object({
      id: z.string().max(500).optional(),
      index: z.number().int().min(0).optional(),
      toolComponent: z.object({ index: z.number().int().min(0).optional() }).optional(),
    })
    .optional(),
  kind: z.enum(['notApplicable', 'pass', 'fail', 'review', 'open', 'informational']).optional(),
  level: z.enum(['none', 'note', 'warning', 'error']).optional(),
  message: message,
  locations: z.array(location).max(100).optional(),
  partialFingerprints: z.record(z.string().max(200), z.string().max(500)).optional(),
  fingerprints: z.record(z.string().max(200), z.string().max(500)).optional(),
  baselineState: z.enum(['new', 'unchanged', 'updated', 'absent']).optional(),
  suppressions: z
    .array(
      z.object({
        kind: z.string().max(40).optional(),
        status: z.enum(['accepted', 'underReview', 'rejected']).optional(),
      }),
    )
    .max(20)
    .optional(),
  properties: propertyBag,
});

const run = z.object({
  tool: z.object({
    driver: toolComponent,
    extensions: z.array(toolComponent).max(200).optional(),
  }),
  results: z.array(result).max(MAX_RESULTS).optional(),
  artifacts: z
    .array(z.object({ location: z.object({ uri: z.string().max(4_000).optional() }).optional() }))
    .max(MAX_RESULTS)
    .optional(),
  originalUriBaseIds: z
    .record(z.string().max(200), z.object({ uri: z.string().max(4_000).optional() }))
    .optional(),
  versionControlProvenance: z
    .array(z.object({ revisionId: z.string().max(100).optional() }))
    .max(20)
    .optional(),
});

export const sarifLogSchema = z.object({
  // Exactly 2.1.0. Earlier drafts (2.0.0, the 2.1.0 RTMs) moved fields around,
  // and reading one as the other would map the wrong value into severity.
  version: z.literal(SARIF_VERSION),
  $schema: z.string().max(500).optional(),
  runs: z.array(run).min(1).max(MAX_RUNS),
});

export type SarifLog = z.infer<typeof sarifLogSchema>;
type SarifRun = SarifLog['runs'][number];
type SarifResult = NonNullable<SarifRun['results']>[number];
type SarifRule = z.infer<typeof rule>;

export type SarifParse =
  { ok: true; log: SarifLog } | { ok: false; errors: { path: string; message: string }[] };

/** Validates a parsed JSON value against the SARIF subset we accept. */
export function parseSarif(input: unknown): SarifParse {
  const parsed = sarifLogSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }
  const total = parsed.data.runs.reduce((n, r) => n + (r.results?.length ?? 0), 0);
  if (total > MAX_RESULTS) {
    return {
      ok: false,
      errors: [{ path: 'runs', message: `more than ${MAX_RESULTS} results across all runs` }],
    };
  }
  return { ok: true, log: parsed.data };
}

/** Why a result in a valid file was not turned into a finding. */
export type SkipReason =
  'not_a_failure' | 'suppressed' | 'absent_from_baseline' | 'unusable_path' | 'no_rule_id';

export interface SarifExtraction {
  results: ExternalResult[];
  skipped: Partial<Record<SkipReason, number>>;
  /** The commit the producing tool says it analysed, when it said so. */
  revisionId: string | null;
}

/**
 * Checkout roots of the hosted CI runners SARIF most often comes from. A tool
 * that writes absolute `file://` URIs without originalUriBaseIds (the ESLint
 * SARIF formatter does) is still unambiguous on these: GitHub Actions checks
 * out to /home/runner/work/<repo>/<repo>/ and container actions see it as
 * /github/workspace/. Anything else needs `sourceRoot` from the uploader.
 */
const KNOWN_CI_ROOTS = [/^\/home\/runner\/work\/[^/]+\/[^/]+\//, /^\/github\/workspace\//];

const isAbsolute = (p: string): boolean => p.startsWith('/') || /^[a-z]:[\\/]/i.test(p);
const stripFileScheme = (p: string): string => p.replace(/^file:(\/\/)?/i, '');

/**
 * Turns a URI into a repo-relative path, or says it cannot.
 *
 * `undefined`: not a file in the repository (an http URL, no URI at all) — the
 * finding is then repository-level. `null`: unusable — it climbs out with
 * `..`, or it is absolute under a root nobody told us about. Those results are
 * dropped and counted, because a guessed prefix sends a reader to a file that
 * does not exist and a stripped one invents a path.
 */
export function repoRelativePath(
  uri: string | undefined,
  uriBaseId: string | undefined,
  baseIds: Record<string, { uri?: string | undefined }> | undefined,
  sourceRoots: readonly string[] = [],
): string | null | undefined {
  if (!uri) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(uri);
  } catch {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^file:/i.test(path)) return undefined;
  path = stripFileScheme(path).replace(/\\/g, '/');

  // A relative uri under a RELATIVE base id is joined; under an absolute one
  // it is already repo-relative, which is how CodeQL writes %SRCROOT%.
  const base = uriBaseId ? baseIds?.[uriBaseId]?.uri : undefined;
  if (base && !isAbsolute(path)) {
    const decodedBase = stripFileScheme(safeDecode(base)).replace(/\\/g, '/');
    if (!isAbsolute(decodedBase)) path = `${decodedBase.replace(/\/?$/, '/')}${path}`;
  }

  if (isAbsolute(path)) {
    const roots = [
      ...sourceRoots,
      ...Object.values(baseIds ?? {}).map((b) => (b.uri ? stripFileScheme(safeDecode(b.uri)) : '')),
    ]
      .map((r) => r.replace(/\\/g, '/'))
      .filter(isAbsolute)
      .map((r) => (r.endsWith('/') ? r : `${r}/`))
      .sort((a, b) => b.length - a.length);
    const root = roots.find((r) => path.startsWith(r));
    if (root) path = path.slice(root.length);
    else {
      const ci = KNOWN_CI_ROOTS.find((re) => re.test(path));
      if (!ci) return null;
      path = path.replace(ci, '');
    }
  }

  path = path.replace(/^(\.\/)+/, '');
  if (path === '' || isAbsolute(path) || path.split('/').some((seg) => seg === '..')) return null;
  return path;
}

function safeDecode(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

function ruleFor(r: SarifRun, res: SarifResult): SarifRule | undefined {
  const componentIndex = res.rule?.toolComponent?.index;
  const component =
    componentIndex === undefined ? r.tool.driver : r.tool.extensions?.[componentIndex];
  const index = res.rule?.index ?? res.ruleIndex;
  if (component && index !== undefined && component.rules?.[index]) {
    return component.rules[index];
  }
  // CodeQL puts its query metadata in tool.extensions (the query packs), not
  // the driver, so an id lookup has to search every component.
  const id = res.ruleId ?? res.rule?.id;
  if (!id) return undefined;
  for (const c of [r.tool.driver, ...(r.tool.extensions ?? [])]) {
    const hit = c.rules?.find((x) => x.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** SARIF §3.11.5: message strings may be templated with {0}, {1}, … */
function messageText(res: SarifResult, ruleDef: SarifRule | undefined): string {
  const m = res.message;
  if (m?.text) return m.text;
  if (m?.markdown) return m.markdown;
  if (m?.id) {
    const template = ruleDef?.messageStrings?.[m.id]?.text;
    if (template) {
      return template.replace(/\{(\d+)\}/g, (_all, n: string) => m.arguments?.[Number(n)] ?? '');
    }
  }
  return ruleDef?.shortDescription?.text ?? ruleDef?.fullDescription?.text ?? '';
}

function fingerprintOf(res: SarifResult): string | null {
  const prints = res.partialFingerprints ?? res.fingerprints;
  if (!prints) return null;
  const keys = Object.keys(prints).sort();
  if (keys.length === 0) return null;
  return keys.map((k) => `${k}=${prints[k]}`).join('|');
}

function securitySeverity(...bags: (z.infer<typeof propertyBag> | undefined)[]): number | null {
  for (const bag of bags) {
    const raw = bag?.['security-severity'];
    if (raw === undefined) continue;
    const n = typeof raw === 'number' ? raw : Number.parseFloat(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 10) return n;
  }
  return null;
}

/** Every result of a validated log, normalised, with what was skipped and why. */
export function extractSarifResults(
  log: SarifLog,
  opts: { sourceRoots?: readonly string[] } = {},
): SarifExtraction {
  const results: ExternalResult[] = [];
  const skipped: Partial<Record<SkipReason, number>> = {};
  const skip = (why: SkipReason) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };
  let revisionId: string | null = null;

  for (const r of log.runs) {
    const driver = r.tool.driver;
    revisionId ??= r.versionControlProvenance?.find((v) => v.revisionId)?.revisionId ?? null;

    for (const res of r.results ?? []) {
      // `kind` defaults to 'fail'. A pass, a not-applicable or an
      // informational note is the tool saying "nothing wrong here", and storing
      // it as a finding would invent a defect.
      const kind = res.kind ?? 'fail';
      if (kind !== 'fail' && kind !== 'review' && kind !== 'open') {
        skip('not_a_failure');
        continue;
      }
      if (res.baselineState === 'absent') {
        skip('absent_from_baseline');
        continue;
      }
      // A suppression with no status is accepted (§3.34.3). Someone already
      // decided about this result in the tool that produced it.
      if (res.suppressions?.some((s) => s.status === undefined || s.status === 'accepted')) {
        skip('suppressed');
        continue;
      }
      const ruleDef = ruleFor(r, res);
      const ruleId = res.ruleId ?? res.rule?.id ?? ruleDef?.id;
      if (!ruleId) {
        skip('no_rule_id');
        continue;
      }

      const physical = res.locations?.[0]?.physicalLocation;
      const loc = physical?.artifactLocation;
      const uri =
        loc?.uri ??
        (loc?.index !== undefined ? r.artifacts?.[loc.index]?.location?.uri : undefined);
      const file = repoRelativePath(uri, loc?.uriBaseId, r.originalUriBaseIds, opts.sourceRoots);
      if (file === null) {
        skip('unusable_path');
        continue;
      }
      const startLine = file === undefined ? null : (physical?.region?.startLine ?? null);
      const endLine =
        startLine === null ? null : Math.max(physical?.region?.endLine ?? startLine, startLine);

      const tags = [...(ruleDef?.properties?.tags ?? []), ...(res.properties?.tags ?? [])];
      results.push({
        tool: driver.name,
        toolVersion: driver.semanticVersion ?? driver.version ?? null,
        ruleId,
        ruleTitle: ruleDef?.shortDescription?.text ?? ruleDef?.name ?? null,
        level: res.level ?? ruleDef?.defaultConfiguration?.level ?? null,
        securitySeverity: securitySeverity(res.properties, ruleDef?.properties),
        precision: ruleDef?.properties?.precision ?? res.properties?.precision ?? null,
        tags: [...new Set(tags)],
        file: file ?? null,
        lineStart: startLine,
        lineEnd: endLine,
        message: messageText(res, ruleDef),
        fingerprint: fingerprintOf(res),
      });
    }
  }
  return { results, skipped, revisionId };
}
