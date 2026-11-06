import type { AntiSlopDeps, AntiSlopJudgement } from '@repopulse/security';

// W27-02: anti-slop's model judgement, out of the scan job.
//
// The judgement of up to 200 shadow candidates ran INSIDE the anti_slop scan
// job on the foreground gateway, so the repository's scans counted as running
// for the whole of it (24-30 min on outline) and the first look and the judge
// waited behind it. Now the scan saves its rule findings, closes its run and
// hands the judgement here: it runs on the background gateway (the caller
// builds it), so foreground calls go first on a one-slot model, and the job
// ends at once. The same move W25-12 made for the CVE second opinion.
//
// ONE AT A TIME PER REPOSITORY. A push can start the next scan while the last
// judgement is still going; the two would send the same candidates. Chained,
// the second starts after the first and skips what it already answered
// (verdict memory, re-read before every call).

export type JudgementOutcome =
  { scanRunId: number; summary: AntiSlopJudgement } | { scanRunId: number; err: unknown };

export interface JudgementLane {
  /**
   * A `deferJudgement` for one repository's scan. `finish` runs after the
   * judgement whatever happens (the second-model verifier's cap row).
   */
  deferFor(opts: {
    workspaceId: number;
    repoId: number;
    finish?: () => Promise<void>;
    report: (outcome: JudgementOutcome) => void;
  }): NonNullable<AntiSlopDeps['deferJudgement']>;
  /** Resolves when every queued judgement has ended (tests, shutdown). */
  idle(): Promise<void>;
}

export function createJudgementLane(): JudgementLane {
  const tails = new Map<string, Promise<void>>();
  return {
    deferFor: ({ workspaceId, repoId, finish, report }) => {
      const key = `${workspaceId}:${repoId}`;
      return (judge, { scanRunId }) => {
        const run = async (): Promise<void> => {
          try {
            report({ scanRunId, summary: await judge() });
          } catch (err) {
            // judge() records its own failures; this is the unexpected rest.
            report({ scanRunId, err });
          } finally {
            await finish?.().catch((err: unknown) => report({ scanRunId, err }));
          }
        };
        const next = (tails.get(key) ?? Promise.resolve()).then(run);
        tails.set(key, next);
        void next.finally(() => {
          if (tails.get(key) === next) tails.delete(key);
        });
      };
    },
    idle: async () => {
      while (tails.size > 0) await Promise.all([...tails.values()]);
    },
  };
}
