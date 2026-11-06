import { and, eq } from 'drizzle-orm';
import {
  buildVerifyPrompt,
  chooseVerifierHost,
  parseVerifyAnswer,
  verifyDimension,
  type AnalysisGateway,
  type SecondModelVerify,
  type T2Host,
  type VerifyOutcome,
  type VerifyRefusal,
} from '@repopulse/analysis';
import { core, read, safeErrorText, type Database } from '@repopulse/shared';
import { recordVerdicts } from '@repopulse/insights';
import {
  DEFAULT_BUDGET,
  runVerifyPass,
  VERIFY_TOP_N,
  verifySubject,
  type CveVerifySummary,
  type VerifyCandidate,
} from '@repopulse/security';
import { isAiPaused } from '../lib/ai-pause.js';
import { describeEndpoint, loadStoredRouting, providersFor } from '../lib/llm-routing.js';
import { monthlyCallsUsed, monthlyCap } from './ai-pass-scheduler.js';

// The second-model verify in production (W21-03, FR-ANALYSIS-9, D9).
//
// passes/verify.ts held the rule (the judge is never the maker) and the
// refute-first prompt since W6-05, and the scanners took a `verify` hook — and
// the worker never passed one, so every AI-raised finding stayed `unverified`
// and "verified by a second model" was a column nothing wrote.
//
// What this enforces, at the moment code would be sent (W20 decision AI-14):
//   - AI off stops it (AI-77): nothing is asked, the finding says so.
//   - It counts against the monthly AI call cap, and stops at it.
//   - A connection off the network is used only when the repository is opted
//     in to Tier 3 and local-only is off; a local one is always preferred.
//   - The verifier is a different connection on a different host from the
//     model that raised the finding; when that cannot be known, nobody is asked.
//   - Calls go through a gateway pinned to that one connection, so the token
//     cap, warm-up, retries and the egress audit row all apply (Law 8).
//
// A verdict MARKS a finding: `contradicted` never changes its status.

export const VERIFY_CHECKLIST_VERSION = 'second-model-verify.v1';
const INITIATOR = 'second-model-verify';

export const AI_OFF_REASON =
  'AI analysis is switched off for this workspace, so no second opinion was asked for.';
export const CAP_REASON =
  "This month's AI call cap is used up, so no second opinion was asked for. It resets on the 1st, or an admin can raise it in Settings → Analysis.";

export interface SecondModelVerifier {
  verify: SecondModelVerify;
  /** Calls made so far (each counts against the month). */
  calls(): number;
  /**
   * For a finding a TOOL raised (a dependency CVE): one pinned gateway on an
   * eligible connection and how many calls are left, or why there is none.
   */
  toolVerifier(): Promise<
    { gateway: AnalysisGateway; host: T2Host; remaining: number } | { refused: string }
  >;
  /**
   * Writes the analysis_runs row (pass_kind 'verify', chunk_count = calls)
   * that puts these calls on the monthly cap, when `ledger` is 'own'. A no-op
   * when no call was made.
   */
  finish(): Promise<void>;
}

export interface SecondModelOptions {
  db: Database;
  workspaceId: number;
  repoId: number;
  /** The workspace's configured hosts — the finder's among them. */
  hosts: readonly T2Host[];
  /** A gateway on ONE connection and model (buildWorkerGateway's pin). */
  pinned: (pin: {
    providerId: number;
    model: string;
  }) => Promise<{ gateway: AnalysisGateway } | null>;
  /**
   * Who records these calls on the monthly cap: 'own' writes an analysis_runs
   * verify row in finish(); 'caller' means they ride an AI pass whose row
   * counts them (ai_pass_runs.calls).
   */
  ledger: 'own' | 'caller';
  /** A lower cap than what is left of the month (an AI pass's own call cap). */
  maxCalls?: number;
  /** Wraps each pinned gateway (an AI pass's cancel check and call counter). */
  wrap?: (g: AnalysisGateway) => AnalysisGateway;
  now?: () => Date;
}

interface Facts {
  paused: boolean;
  remaining: number;
  offNetworkAllowed: boolean;
  leaves: (h: T2Host) => boolean;
}

export function createSecondModelVerifier(opts: SecondModelOptions): SecondModelVerifier {
  const { db, workspaceId, repoId } = opts;
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  let calls = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  const models = new Set<string>();
  const gateways = new Map<number, AnalysisGateway | null>();
  let facts: Promise<Facts> | null = null;

  // Read once per verifier (one scan run or one pass): a scan's findings are
  // judged against the same switches, and forty findings must not mean forty
  // reads of the same four rows.
  const loadFacts = (): Promise<Facts> =>
    (facts ??= (async () => {
      const paused = await isAiPaused(db, workspaceId);
      const left = Math.max(
        0,
        (await monthlyCap(db, workspaceId)) - (await monthlyCallsUsed(db, workspaceId, now())),
      );
      const remaining = Math.min(left, opts.maxCalls ?? Number.POSITIVE_INFINITY);
      const { localOnly } = await loadStoredRouting(db, workspaceId);
      const [repo] = await db
        .select({ optIn: core.repos.tier3OptIn })
        .from(core.repos)
        .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
        .limit(1);
      // The same definition as the egress audit and the Models screen.
      const rows = await providersFor(db, workspaceId);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const leaves = (h: T2Host): boolean => {
        if (h.transport === 'claude_cli') return true;
        const row = h.providerId === undefined ? undefined : byId.get(h.providerId);
        return row ? describeEndpoint(row.kind, row.baseUrl).leavesNetwork : true;
      };
      return { paused, remaining, offNetworkAllowed: !localOnly && repo?.optIn === true, leaves };
    })());

  const pinnedGateway = async (host: T2Host): Promise<AnalysisGateway | null> => {
    const id = host.providerId!;
    if (!gateways.has(id)) {
      const built = await opts.pinned({ providerId: id, model: host.modelSlot });
      gateways.set(id, built ? (opts.wrap ? opts.wrap(built.gateway) : built.gateway) : null);
    }
    return gateways.get(id) ?? null;
  };

  const refuse = (reason: string): VerifyRefusal => ({ unverified: true, reason });

  const verify: SecondModelVerify = async (req) => {
    const f = await loadFacts();
    if (f.paused) return refuse(AI_OFF_REASON);
    if (calls >= f.remaining) return refuse(CAP_REASON);
    const chosen = chooseVerifierHost(opts.hosts, req.finder, {
      offNetworkAllowed: f.offNetworkAllowed,
      leavesNetwork: f.leaves,
    });
    if ('refused' in chosen) return refuse(chosen.refused);
    const host = chosen.host;
    const gateway = await pinnedGateway(host);
    if (!gateway) {
      return refuse(
        `The second AI connection (${host.name ?? 'unnamed'}) could not be used, so no second opinion was asked for. See Settings → Models.`,
      );
    }

    const prompt = buildVerifyPrompt(
      {
        id: 0,
        severity: req.severity,
        dimension: req.dimension,
        file: req.file,
        title: req.title,
        evidenceQuote: req.evidenceQuote,
        rationale: req.rationale,
        finderHostUrl: '',
      },
      req.excerpt,
    );
    let text: string;
    let model: string;
    try {
      const result = await gateway.complete(prompt, {
        tier: 'T2',
        maxTokens: 45_000,
        expectJson: true,
        meta: {
          repoId: String(repoId),
          prNumber: 0,
          dimension: verifyDimension(req.dimension),
          checklistVersion: VERIFY_CHECKLIST_VERSION,
          initiator: INITIATOR,
          // A pinned gateway routes the triage role only.
          role: 'triage',
        },
      });
      text = result.text;
      model = result.model;
      models.add(result.model);
      promptTokens += result.tokensIn;
      outputTokens += result.tokensOut;
    } catch (err) {
      // An AI pass that was cancelled stops here, not on the next finding.
      if (err instanceof Error && err.name === 'PassCancelledError') throw err;
      return refuse(
        `The second model (${host.name ?? host.modelSlot}) did not answer: ${safeErrorText(err).slice(0, 300)}`,
      );
    } finally {
      calls += 1;
    }
    const answer = parseVerifyAnswer(text);
    if (!answer) {
      return refuse(
        `The second model (${model}) gave an answer that could not be read, so this finding stays unverified.`,
      );
    }
    const outcome: VerifyOutcome = {
      refuted: answer.refuted,
      reason: answer.reason,
      verifier: { model, providerId: host.providerId ?? null, connection: host.name ?? null },
    };
    return outcome;
  };

  return {
    verify,
    calls: () => calls,
    async toolVerifier() {
      const f = await loadFacts();
      if (f.paused) return { refused: AI_OFF_REASON };
      const remaining = f.remaining - calls;
      if (remaining <= 0) return { refused: CAP_REASON };
      const chosen = chooseVerifierHost(opts.hosts, null, {
        offNetworkAllowed: f.offNetworkAllowed,
        leavesNetwork: f.leaves,
      });
      if ('refused' in chosen) return chosen;
      const gateway = await pinnedGateway(chosen.host);
      if (!gateway) {
        return {
          refused: `The AI connection (${chosen.host.name ?? 'unnamed'}) could not be used. See Settings → Models.`,
        };
      }
      return { gateway, host: chosen.host, remaining };
    },
    async finish() {
      if (opts.ledger !== 'own' || calls === 0) return;
      await db.insert(read.analysisRuns).values({
        workspaceId,
        repoId,
        tier: 2,
        dimension: 'code_health',
        checklistVersion: VERIFY_CHECKLIST_VERSION,
        modelId: [...models][0] ?? 'unknown',
        status: 'succeeded',
        passKind: 'verify',
        // monthlyCallsUsed sums this for verify rows: these calls are on the cap.
        chunkCount: calls,
        promptTokens,
        outputTokens,
        startedAt,
        finishedAt: now(),
      });
    },
  };
}

/**
 * The V5 second opinion on a dependency scan's CVEs (W8-15, wired in W21-03).
 * grype is the maker, so any eligible connection may judge — still pinned,
 * still on the network unless Tier-3 allows otherwise, still on the cap: the
 * pass writes its own analysis_runs verify row (chunk_count = calls), which
 * monthlyCallsUsed counts. Top-N by price, at most what is left of the month.
 *
 * `applies: false` MARKS the finding contradicted with the model's statement;
 * the VEX proposal stays a proposal for a person, and nothing is dismissed.
 */
export function cveVerifyHook(deps: {
  db: Database;
  workspaceId: number;
  repoId: number;
  verifier: Pick<SecondModelVerifier, 'toolVerifier'>;
  runVerify?: typeof runVerifyPass;
}): (args: {
  candidates: VerifyCandidate[];
  scanRunId: number;
  commitSha: string;
}) => Promise<CveVerifySummary> {
  const run = deps.runVerify ?? runVerifyPass;
  return async ({ candidates, scanRunId, commitSha }) => {
    const tv = await deps.verifier.toolVerifier();
    if ('refused' in tv) return { asked: 0, confirmed: 0, contradicted: 0, refused: tv.refused };
    const result = await run({
      db: deps.db,
      gateway: tv.gateway,
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      commitSha,
      candidates,
      budget: { llmTokens: DEFAULT_BUDGET.llmTokens },
      limit: Math.min(VERIFY_TOP_N, tv.remaining),
      scanRunId,
    });
    const verdicts = result.proposals.map((p) => ({
      dedupKey: p.dedupKey,
      // W27-03: the question this verdict answers, so the next scan of an
      // unchanged manifest does not ask it again.
      subject: verifySubject(p),
      verify: {
        status: p.applies ? ('confirmed' as const) : ('contradicted' as const),
        model: p.model,
        providerId: tv.host.providerId ?? null,
        connection: tv.host.name ?? null,
        reason: p.applies
          ? 'A second model checked the evidence and could not show this does not apply.'
          : (p.proposal?.statement ?? 'A second model judged that this does not apply here.'),
      },
    }));
    await recordVerdicts(deps.db, {
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      verdicts,
    });
    return {
      asked: result.funnel.verified,
      alreadyVerified: result.funnel.skipped.already_verified,
      confirmed: verdicts.filter((v) => v.verify.status === 'confirmed').length,
      contradicted: verdicts.filter((v) => v.verify.status === 'contradicted').length,
      ...(result.error ? { error: result.error } : {}),
    };
  };
}

/**
 * W25-12: run the CVE second opinion WITHOUT holding the scan job.
 *
 * The run row was already closed before the check (W21-03), but the scan JOB
 * still awaited it, so the repository's scans counted as running for the whole
 * check: about 2h50 on saleor and outline with a local model (10 CVEs, minutes
 * each), and the first look and the judge waited behind it. Now the check is
 * started and the job ends at once; it uses the background gateway (the caller
 * builds it), so the first look's calls go first on a one-slot model. Verdicts
 * land on the stored findings when each call returns; a worker that stops
 * mid-check leaves the rest "not independently verified", as before.
 */
export function inBackground(
  hook: (args: {
    candidates: VerifyCandidate[];
    scanRunId: number;
    commitSha: string;
  }) => Promise<CveVerifySummary>,
  report: (outcome: { summary?: CveVerifySummary; err?: unknown; scanRunId: number }) => void,
): (args: {
  candidates: VerifyCandidate[];
  scanRunId: number;
  commitSha: string;
}) => Promise<CveVerifySummary> {
  return async (args) => {
    void hook(args).then(
      (summary) => report({ summary, scanRunId: args.scanRunId }),
      (err: unknown) => report({ err, scanRunId: args.scanRunId }),
    );
    return { asked: 0, confirmed: 0, contradicted: 0, deferred: true };
  };
}
