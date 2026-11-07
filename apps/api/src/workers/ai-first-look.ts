import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { facts, isConstraintViolation, read, type Database } from '@repopulse/shared';
import { passEgress, PASS_ROLES } from '../lib/ai-pass-egress.js';
import { isAiPaused } from '../lib/ai-pause.js';
import { FIRST_LOOK_MAX_CALLS } from './ai-pass-processor.js';
import { AI_PASS_READABLE } from './ai-pass-sources.js';
import { isTestPath } from './code-kind.js';
import { MIN_CALLS_TO_START, monthlyCallsUsed, monthlyCap } from './ai-pass-scheduler.js';
import type { EgressOf } from './ai-judge.js';

// W25-01: the AI's FIRST LOOK for code issues, queued after a repository's
// first scan.
//
// WHY. On the 0.2.0 install the first scan ran every mechanical scanner and
// then only two things used the model: the CVE verify step inside the
// dependency scan, and the judge over rule hits. The specialists (security,
// performance, best practices, slop, ...) that FIND issues no rule knows about
// ran only when a person pressed the button on the AI review tab or saved a
// schedule, so a fresh install showed 0 AI-raised code findings and the AI
// review tab read "Not yet run" on every repository.
//
// WHAT. One ordinary `paths` pass per repository, trigger `after_scan`, over
// the files the first scan ranked worst: most open findings (weighted by
// severity), then most churn. It is the same pass a person starts, with the
// same caps (40 files, 400 KB, 30 calls) and the same "never writes, never
// dismisses" rules; the row says which files it read. It waits for the
// repository's scans like the judge does, and it uses the FOREGROUND gateway,
// so on a one-slot local model it is served before the judge's background
// calls.
//
// WHEN. Local models: on by default (nothing leaves the network, the same
// rule as the judge, decision 1 of CLOSE_THE_LOOP.md). A model off the network:
// only for a repository an admin opted in to scheduled passes, with the
// acknowledged routing still matching (W19-12). Always within the monthly call
// cap. AI_FIRST_LOOK=off removes it from the server; "AI off" stops it.
// Once per repository: at most FIRST_LOOK_ATTEMPTS rows, and none while one
// is queued, running or has succeeded.

/** Most first-look rows per repository (a failed one may be tried again on a later scan). */
export const FIRST_LOOK_ATTEMPTS = 3;
/** Ranked candidates handed to the loader, which reads them in order up to the pass caps. */
export const FIRST_LOOK_CANDIDATES = 120;
/** Churn window for the ranking's second key. */
const CHURN_DAYS = 180;
/** Paths a first look never spends a model call on. */
const NOT_SOURCE =
  /(^|\/)(node_modules|vendor|third_party|dist|build|out|target|\.git|__snapshots__|fixtures?|testdata)\/|\.min\.(js|css)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

export interface FirstLookConfig {
  enabled: boolean;
}

export function firstLookConfigFromEnv(env: Record<string, string | undefined>): FirstLookConfig {
  return { enabled: (env.AI_FIRST_LOOK ?? 'on') !== 'off' };
}

export type QueueFirstLookResult =
  { queued: true; runId: number } | { queued: false; code: string };

/**
 * After a scan: queue the repository's first-look pass when it has not had one
 * and policy allows it. Writes no row when it does not queue (the reason is for
 * the worker's log), like queueJudgeAfterScan.
 */
export async function queueFirstLookAfterScan(
  deps: {
    db: Database;
    config: FirstLookConfig;
    enqueue: (data: { workspaceId: number; runId: number; maxCalls: number }) => Promise<void>;
    now?: () => Date;
    egress?: EgressOf;
  },
  target: { workspaceId: number; repoId: number },
): Promise<QueueFirstLookResult> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const { workspaceId: ws, repoId } = target;
  if (!deps.config.enabled) return { queued: false, code: 'disabled' };
  if (await isAiPaused(db, ws)) return { queued: false, code: 'ai_paused' };

  const earlier = await db
    .select({ status: read.aiPassRuns.status })
    .from(read.aiPassRuns)
    .where(
      and(
        eq(read.aiPassRuns.workspaceId, ws),
        eq(read.aiPassRuns.repoId, repoId),
        eq(read.aiPassRuns.mode, 'paths'),
        eq(read.aiPassRuns.trigger, 'after_scan'),
      ),
    );
  if (earlier.some((r) => ['pending', 'running', 'succeeded'].includes(r.status))) {
    return { queued: false, code: 'already_done' };
  }
  if (earlier.length >= FIRST_LOOK_ATTEMPTS) return { queued: false, code: 'attempts_used' };

  const egress = await (deps.egress ?? passEgress)(db, ws, PASS_ROLES);
  if (egress.destinations.length === 0) return { queued: false, code: 'no_gateway' };
  if (egress.leaves_network) {
    if (egress.local_only) return { queued: false, code: 'local_only_forbids' };
    const [schedule] = await db
      .select({ digest: read.aiPassSchedules.egressDigest })
      .from(read.aiPassSchedules)
      .where(
        and(
          eq(read.aiPassSchedules.workspaceId, ws),
          eq(read.aiPassSchedules.repoId, repoId),
          eq(read.aiPassSchedules.enabled, true),
        ),
      )
      .limit(1);
    if (!schedule) return { queued: false, code: 'not_opted_in' };
    if (schedule.digest !== egress.digest) return { queued: false, code: 'routing_changed' };
  }

  const remaining = (await monthlyCap(db, ws)) - (await monthlyCallsUsed(db, ws, now));
  if (remaining < MIN_CALLS_TO_START) return { queued: false, code: 'cap_reached' };

  let runId: number;
  try {
    const [run] = await db
      .insert(read.aiPassRuns)
      .values({
        workspaceId: ws,
        repoId,
        // Chosen when the pass STARTS (rankFirstLookPaths), after the scans
        // it waits for have written their findings.
        paths: [],
        mode: 'paths',
        trigger: 'after_scan',
        createdAt: now,
      })
      .returning({ id: read.aiPassRuns.id });
    runId = run!.id;
  } catch (err) {
    // A person's pass (or a scheduled one) is already active: it reviews the
    // repository; the first look tries again after a later scan.
    if (isConstraintViolation(err, 'ai_pass_runs_one_active_key')) {
      return { queued: false, code: 'active_pass' };
    }
    throw err;
  }
  await deps.enqueue({
    workspaceId: ws,
    runId,
    maxCalls: Math.min(FIRST_LOOK_MAX_CALLS, remaining),
  });
  return { queued: true, runId };
}

/** True when a pass row is a first look (its paths are ranked when it starts). */
export function isFirstLook(run: { mode: string; trigger: string }): boolean {
  return run.mode === 'paths' && run.trigger === 'after_scan';
}

/**
 * The files a first look reads, best first (production source before config
 * before tests, W25-09; see rankPaths): open findings on the file
 * (severity-weighted, shadow rules left out), then commits that touched it in
 * the last CHURN_DAYS, then definitions in the code map. Only file types a pass reads, never vendored or built
 * paths. Workspace- and repository-filtered (Law 5); reads only our database.
 */
export async function rankFirstLookPaths(
  db: Database,
  workspaceId: number,
  repoId: number,
  now: Date,
  limit = FIRST_LOOK_CANDIDATES,
): Promise<string[]> {
  const byFindings = await db
    .select({
      file: read.findings.file,
      weight: sql<number>`sum(${read.findings.severity})::int`,
    })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        eq(read.findings.repoId, repoId),
        eq(read.findings.status, 'open'),
        eq(read.findings.experimental, false),
        isNotNull(read.findings.file),
      ),
    )
    .groupBy(read.findings.file)
    .orderBy(desc(sql`sum(${read.findings.severity})`), read.findings.file)
    .limit(limit * 4);

  const since = new Date(now.getTime() - CHURN_DAYS * 24 * 60 * 60 * 1000);
  const byChurn = await db
    .select({ path: facts.commitFiles.path, n: sql<number>`count(*)::int` })
    .from(facts.commitFiles)
    .innerJoin(facts.commits, eq(facts.commits.id, facts.commitFiles.commitId))
    .where(
      and(
        eq(facts.commitFiles.workspaceId, workspaceId),
        eq(facts.commitFiles.repoId, repoId),
        inArray(facts.commitFiles.status, ['added', 'modified', 'renamed']),
        gte(facts.commits.committedAt, since),
      ),
    )
    .groupBy(facts.commitFiles.path)
    .orderBy(desc(sql`count(*)`), facts.commitFiles.path)
    .limit(limit * 4);

  // W25-09: third key, definitions per file from the code map (W22-01). A
  // mirror with no recent commits and few findings on source (gin) still has
  // its core files: the ones that define the most functions and types.
  const byDefs = await db
    .select({ path: read.codeIndexDefs.path, n: sql<number>`count(*)::int` })
    .from(read.codeIndexDefs)
    .innerJoin(
      read.codeIndexes,
      and(
        eq(read.codeIndexes.id, read.codeIndexDefs.indexId),
        eq(read.codeIndexes.workspaceId, read.codeIndexDefs.workspaceId),
      ),
    )
    .where(
      and(eq(read.codeIndexDefs.workspaceId, workspaceId), eq(read.codeIndexes.repoId, repoId)),
    )
    .groupBy(read.codeIndexDefs.path)
    .orderBy(desc(sql`count(*)`), read.codeIndexDefs.path)
    .limit(limit * 4);

  return rankPaths(
    byFindings.map((r) => ({ path: r.file ?? '', weight: Number(r.weight) })),
    byChurn.map((r) => ({ path: r.path, weight: Number(r.n) })),
    limit,
    byDefs.map((r) => ({ path: r.path, weight: Number(r.n) })),
  );
}

// W25-09. Test files collect the most rule hits (fixtures, fake secrets,
// copy-paste setups), so ranking by findings alone made them the first look's
// favourite: on gin 13 of 17 files read were tests or config (go.mod,
// a CI yml, doc.go) and 4 were production code. A first look is for the
// code that runs, so it is ranked in tiers: production source, then config
// and other readable non-code, then tests, each tier findings-then-churn.
// Tests stay as the fallback for a repository that is mostly tests. What
// counts as a test is code-kind.ts (W25-16), shared with the judge.
/** Readable but not code that runs: manifests, CI and tool config, package docs, generated code. */
const NOT_RUNTIME =
  /\.(ya?ml)$|(^|\/)(go\.mod|doc\.go)$|(\.pb\.go|_gen\.go|\.generated\.[a-z]+|\.d\.ts)$|(^|\/)(examples?|docs?|scripts)\//;

/** 0 production source, 1 config and other non-runtime files, 2 tests. Pure, for tests. */
export function pathTier(path: string): 0 | 1 | 2 {
  if (isTestPath(path)) return 2;
  if (NOT_RUNTIME.test(path)) return 1;
  return 0;
}

/**
 * Production source first, then non-runtime files, then tests; within a tier
 * findings, then churn, then definitions in the code map; readable source only; no duplicates. Pure, for tests.
 */
export function rankPaths(
  byFindings: readonly { path: string; weight: number }[],
  byChurn: readonly { path: string; weight: number }[],
  limit = FIRST_LOOK_CANDIDATES,
  byDefs: readonly { path: string; weight: number }[] = [],
): string[] {
  const tiers: string[][] = [[], [], []];
  const seen = new Set<string>();
  for (const list of [byFindings, byChurn, byDefs]) {
    for (const { path } of list) {
      const clean = path.replace(/^\.?\/+/, '');
      if (!clean || seen.has(clean)) continue;
      const base = clean.split('/').pop() ?? clean;
      if (!AI_PASS_READABLE.test(base) || NOT_SOURCE.test(clean)) continue;
      seen.add(clean);
      tiers[pathTier(clean)]!.push(clean);
    }
  }
  return tiers.flat().slice(0, limit);
}
