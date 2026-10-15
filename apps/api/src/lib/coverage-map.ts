import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import { core, facts, read, security, type Database } from '@repopulse/shared';
import {
  ANTI_SLOP_SCANNER_KEY,
  CODE_HEALTH_PACK_DIR,
  PERF_PACK_DIR,
  SCANNER_DEFAULTS,
  SEMGREP_RULEPACK_DIR,
  UNSUPPORTED_TOOLS,
  isEnabled,
  listScanners,
} from '@repopulse/security';
import { UNSUPPORTED_CAPABILITIES } from './capability.js';
import { SHIPPED_SHADOW_RULES } from './rule-precision.js';

// The repository coverage map (W18-22): what RepoPulse did NOT look at here.
//
// Every other screen reports what was found. This one reports the four holes a
// reader cannot see from a findings list — languages no rule pack reads, files
// the reader skipped, scanners that are off or absent from the build, and
// rules whose findings are in shadow — because "no findings" over a
// repository that is mostly Go says nothing about the Go.
//
// NEVER AN EMPTY GREEN PANEL (D15). Each section carries a `checked` sentence
// saying what was examined and from which source, so an empty list reads as
// "looked, nothing to report" with its evidence, and a section with no
// evidence at all says `unknown` rather than collapsing to empty. There is no
// overall verdict, score or grade (N-9): four lists, each with its source.
//
// READS ONLY OUR OWN DATA (Law 4): file paths from synced commit history,
// scanner state from scan_runs and repo_scanner_config, rule state from the
// registry and the findings table, pack languages from the shipped YAML.

/** File extension → the language name rule packs use in `languages:`. */
const EXTENSION_LANGUAGE: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  rb: 'ruby',
  rs: 'rust',
  php: 'php',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  swift: 'swift',
  scala: 'scala',
  sh: 'bash',
  bash: 'bash',
  tf: 'terraform',
  hcl: 'terraform',
};

/** Pack spellings that name the same language. */
const LANGUAGE_ALIAS: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  golang: 'go',
  'c#': 'csharp',
  'c++': 'cpp',
  hcl: 'terraform',
  sh: 'bash',
};

export interface PackLanguage {
  language: string;
  /** Pack file names, e.g. "bpm-baseline.v1.yaml". */
  packs: string[];
  rules: number;
}

/**
 * The languages the shipped YAML packs declare, read from the files.
 *
 * Read rather than listed so a new language pack counts the moment it ships —
 * the alternative is a table here that says Go is uncovered a release after a
 * Go pack landed. Line-level like semgrep/scanner.ts's readRulepack: the only
 * fields needed are each rule's `languages`, in either YAML list form.
 */
export function packLanguages(
  dirs: readonly string[] = [SEMGREP_RULEPACK_DIR, CODE_HEALTH_PACK_DIR, PERF_PACK_DIR],
): PackLanguage[] {
  const byLanguage = new Map<string, { packs: Set<string>; rules: number }>();
  const add = (language: string, pack: string) => {
    const name = LANGUAGE_ALIAS[language] ?? language;
    // `generic` and `regex` match text, not a language: they cover nothing.
    if (name === 'generic' || name === 'regex' || name === 'none') return;
    const entry = byLanguage.get(name) ?? { packs: new Set<string>(), rules: 0 };
    entry.packs.add(pack);
    entry.rules += 1;
    byLanguage.set(name, entry);
  };

  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    } catch {
      continue; // a pack directory absent from this build covers nothing
    }
    for (const file of files) {
      const lines = readFileSync(path.join(dir, file), 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const inline = /^\s*languages:\s*\[([^\]]*)\]/.exec(lines[i]!);
        if (inline) {
          for (const lang of inline[1]!.split(',')) {
            const name = lang
              .trim()
              .replace(/^['"]|['"]$/g, '')
              .toLowerCase();
            if (name) add(name, file);
          }
          continue;
        }
        if (/^\s*languages:\s*$/.test(lines[i]!)) {
          for (let j = i + 1; j < lines.length; j += 1) {
            const item = /^\s*-\s*['"]?([\w#+-]+)['"]?\s*$/.exec(lines[j]!);
            if (!item) break;
            add(item[1]!.toLowerCase(), file);
          }
        }
      }
    }
  }

  return [...byLanguage.entries()]
    .map(([language, v]) => ({ language, packs: [...v.packs].sort(), rules: v.rules }))
    .sort((a, b) => a.language.localeCompare(b.language));
}

/**
 * Languages the in-process fast lane reads without a YAML pack: the anti-slop
 * graph checks resolve JS/TS modules only (anti-slop/source-graph.ts).
 */
const FAST_LANE_LANGUAGES = ['javascript', 'typescript'];

export interface CoverageSection<T> {
  /** What was examined, from which source. Always present. */
  checked: string;
  /**
   * `known` = the source exists and the list is the answer (possibly empty).
   * `unknown` = no evidence to answer from; the list is empty for that reason.
   */
  evidence: 'known' | 'unknown';
  items: T[];
}

export interface LanguageGap {
  language: string;
  /** Distinct file paths of this language seen in synced commit history. */
  files: number;
}

export interface SkippedFiles {
  scannerKey: string;
  runId: number;
  at: string | null;
  /** True when the reader hit a size or count cap on that run. */
  partial: boolean;
  /** Not stored by this release (see the coverage-map note in plan.json). */
  count: null;
}

export interface ScannerGap {
  key: string;
  label: string;
  reason: 'not_in_build' | 'not_supported' | 'disabled' | 'never_run' | 'last_run_failed';
  detail: string;
}

export interface ShadowRule {
  ruleId: string;
  source: 'registry' | 'shipped default' | 'observed shadow findings';
  /** Open or confirmed experimental findings on THIS repository. */
  openShadowFindings: number;
}

export interface CoverageMap {
  repoId: number;
  languages: CoverageSection<LanguageGap> & {
    /** Every language seen, with the packs that read it — the denominator. */
    present: (LanguageGap & { packs: string[]; fastLane: boolean })[];
  };
  skippedFiles: CoverageSection<SkippedFiles>;
  scanners: CoverageSection<ScannerGap>;
  shadowRules: CoverageSection<ShadowRule>;
}

export interface CoverageMapOptions {
  packs?: PackLanguage[];
}

/** The coverage map for one repository; null for another tenant's repo. */
export async function repoCoverageMap(
  db: Database,
  workspaceId: number,
  repoId: number,
  opts: CoverageMapOptions = {},
): Promise<CoverageMap | null> {
  const [repo] = await db
    .select({ id: core.repos.id })
    .from(core.repos)
    .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
    .limit(1);
  if (!repo) return null;

  // ---- languages -----------------------------------------------------------
  // From paths in synced commit history: the only file list this product
  // keeps (C1, no clones). A language whose files were never touched in the
  // synced window is invisible here, and the `checked` sentence says so.
  const extRows = await db
    .select({
      ext: sql<
        string | null
      >`lower(substring(${facts.commitFiles.path} from '\\.([A-Za-z0-9]+)$'))`,
      files: sql<number>`count(distinct ${facts.commitFiles.path})::int`,
    })
    .from(facts.commitFiles)
    .where(
      and(eq(facts.commitFiles.workspaceId, workspaceId), eq(facts.commitFiles.repoId, repoId)),
    )
    .groupBy(sql`1`);

  const filesByLanguage = new Map<string, number>();
  let pathsSeen = 0;
  for (const row of extRows) {
    pathsSeen += row.files;
    const language = row.ext ? EXTENSION_LANGUAGE[row.ext] : undefined;
    if (language) filesByLanguage.set(language, (filesByLanguage.get(language) ?? 0) + row.files);
  }
  const packs = opts.packs ?? packLanguages();
  const packByLanguage = new Map(packs.map((p) => [p.language, p]));
  const present = [...filesByLanguage.entries()]
    .map(([language, files]) => ({
      language,
      files,
      packs: packByLanguage.get(language)?.packs ?? [],
      fastLane: FAST_LANE_LANGUAGES.includes(language),
    }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));

  const languages: CoverageMap['languages'] = {
    evidence: pathsSeen === 0 ? 'unknown' : 'known',
    checked:
      pathsSeen === 0
        ? 'No commit history with file lists has been synced for this repository, so which languages it contains is not known yet.'
        : `File extensions of ${pathsSeen} distinct paths changed in synced commit history, against the languages the shipped rule packs declare. Files never changed in the synced window are not seen. Secret scanning reads every text file regardless of language and is not counted here.`,
    items: present
      .filter((l) => l.packs.length === 0 && !l.fastLane)
      .map(({ language, files }) => ({ language, files })),
    present,
  };

  // ---- skipped files -------------------------------------------------------
  // The snapshot reader (snapshot/sources.ts) skips files over 512 KB and stops
  // at its file/byte caps. It COUNTS what it skipped, but no column stores the
  // count, so the only recorded trace is scan_runs.partial on the run that
  // read the tree. Reported as exactly that: whether the latest read was
  // partial, never an invented number.
  const [latestRead] = await db
    .select({
      id: security.scanRuns.id,
      partial: security.scanRuns.partial,
      status: security.scanRuns.status,
      finishedAt: security.scanRuns.finishedAt,
    })
    .from(security.scanRuns)
    .where(
      and(
        eq(security.scanRuns.workspaceId, workspaceId),
        eq(security.scanRuns.repoId, repoId),
        eq(security.scanRuns.scannerKey, ANTI_SLOP_SCANNER_KEY),
        eq(security.scanRuns.status, 'succeeded'),
      ),
    )
    .orderBy(desc(security.scanRuns.startedAt))
    .limit(1);

  const skippedFiles: CoverageMap['skippedFiles'] = latestRead
    ? {
        evidence: 'known',
        checked: latestRead.partial
          ? 'The latest whole-tree read skipped files: some were over the 512 KB per-file limit or past the read cap (2,000 files / total bytes). How many is counted at scan time but not stored by this release.'
          : 'The latest whole-tree read reached every source file it looks for (JS/TS, Python, Go, Ruby, Java, Kotlin, C#, PHP, Rust): none over the 512 KB per-file limit, read cap not reached.',
        items: latestRead.partial
          ? [
              {
                scannerKey: ANTI_SLOP_SCANNER_KEY,
                runId: latestRead.id,
                at: latestRead.finishedAt?.toISOString() ?? null,
                partial: true,
                count: null,
              },
            ]
          : [],
      }
    : {
        evidence: 'unknown',
        checked:
          'No whole-tree read has completed for this repository, so whether any files are too large or past the read cap is not known yet.',
        items: [],
      };

  // ---- scanners ------------------------------------------------------------
  const stored = await db
    .select({
      scannerKey: security.repoScannerConfig.scannerKey,
      enabled: security.repoScannerConfig.enabled,
    })
    .from(security.repoScannerConfig)
    .where(
      and(
        eq(security.repoScannerConfig.workspaceId, workspaceId),
        eq(security.repoScannerConfig.repoId, repoId),
      ),
    );
  const storedByKey = new Map(stored.map((r) => [r.scannerKey, { enabled: r.enabled }]));

  const runs = await db
    .select({
      scannerKey: security.scanRuns.scannerKey,
      latestStatus: sql<
        string | null
      >`(array_agg(${security.scanRuns.status} order by ${security.scanRuns.startedAt} desc))[1]`,
    })
    .from(security.scanRuns)
    .where(
      and(eq(security.scanRuns.workspaceId, workspaceId), eq(security.scanRuns.repoId, repoId)),
    )
    .groupBy(security.scanRuns.scannerKey);
  const latestStatus = new Map(runs.map((r) => [r.scannerKey, r.latestStatus]));

  const registered = new Map(listScanners().map((s) => [s.key, s]));
  const keys = [...new Set([...registered.keys(), ...SCANNER_DEFAULTS.map((d) => d.key)])].sort();
  const scannerGaps: ScannerGap[] = [];
  for (const key of keys) {
    const label = registered.get(key)?.displayName ?? key;
    if (!registered.has(key)) {
      scannerGaps.push({
        key,
        label,
        reason: 'not_in_build',
        detail: 'Documented, but no code for this scanner ships in this build.',
      });
      continue;
    }
    if (!isEnabled(key, storedByKey.get(key))) {
      scannerGaps.push({
        key,
        label,
        reason: 'disabled',
        detail: 'Turned off for this repository.',
      });
      continue;
    }
    const status = latestStatus.get(key);
    if (status === undefined) {
      scannerGaps.push({
        key,
        label,
        reason: 'never_run',
        detail: 'Enabled, but has never run here.',
      });
    } else if (status === 'failed' || status === 'budget_exceeded') {
      scannerGaps.push({
        key,
        label,
        reason: 'last_run_failed',
        detail:
          status === 'failed'
            ? 'The latest run failed; anything it would have found since is unseen.'
            : 'The latest run hit its budget and stopped early.',
      });
    }
  }
  for (const [key, detail] of Object.entries(UNSUPPORTED_CAPABILITIES)) {
    scannerGaps.push({ key, label: key.replace('_', ' '), reason: 'not_supported', detail });
  }
  for (const tool of UNSUPPORTED_TOOLS) {
    scannerGaps.push({
      key: tool.tool,
      label: tool.tool,
      reason: 'not_in_build',
      detail: tool.reason,
    });
  }

  const scanners: CoverageMap['scanners'] = {
    evidence: 'known',
    checked: `${keys.length} scanners in the catalogue, checked for being in this build, enabled for this repository and run successfully; plus the capabilities and tools this release does not ship.`,
    items: scannerGaps,
  };

  // ---- rules in shadow -----------------------------------------------------
  const registryRows = await db
    .select({ ruleId: security.ruleRegistry.ruleId, status: security.ruleRegistry.status })
    .from(security.ruleRegistry)
    .where(eq(security.ruleRegistry.workspaceId, workspaceId));
  const registry = new Map(registryRows.map((r) => [r.ruleId, r.status]));

  const shadowCounts = await db
    .select({
      ruleId: read.findings.ruleId,
      open: sql<number>`count(*) filter (where ${read.findings.status} in ('open','confirmed'))::int`,
    })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        eq(read.findings.repoId, repoId),
        eq(read.findings.experimental, true),
      ),
    )
    .groupBy(read.findings.ruleId);
  const openByRule = new Map(
    shadowCounts.filter((r) => r.ruleId !== null).map((r) => [r.ruleId!, r.open]),
  );

  const shadow = new Map<string, ShadowRule['source']>();
  for (const [ruleId, status] of registry)
    if (status === 'candidate') shadow.set(ruleId, 'registry');
  for (const ruleId of SHIPPED_SHADOW_RULES) {
    const status = registry.get(ruleId);
    // Promoted or retired by an admin: no longer in shadow.
    if (status !== 'active' && status !== 'deprecated' && !shadow.has(ruleId)) {
      shadow.set(ruleId, 'shipped default');
    }
  }
  for (const ruleId of openByRule.keys()) {
    if (!shadow.has(ruleId) && registry.get(ruleId) !== 'active') {
      shadow.set(ruleId, 'observed shadow findings');
    }
  }

  const shadowRules: CoverageMap['shadowRules'] = {
    evidence: 'known',
    checked:
      'Rules running in shadow: their findings are shown and triageable here but count towards no score, banner, plan or report until an admin promotes them.',
    items: [...shadow.entries()]
      .map(([ruleId, source]) => ({
        ruleId,
        source,
        openShadowFindings: openByRule.get(ruleId) ?? 0,
      }))
      .sort(
        (a, b) => b.openShadowFindings - a.openShadowFindings || a.ruleId.localeCompare(b.ruleId),
      ),
  };

  return { repoId, languages, skippedFiles, scanners, shadowRules };
}
