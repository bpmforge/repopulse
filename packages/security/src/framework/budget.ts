import type { ScanBudget, ScanRunResult, ScanRunStatus, Scanner, ScannerContext } from './types.js';

// Budget enforcement and failure isolation (W8-01, §1.2, NFR-15).

export const DEFAULT_BUDGET: ScanBudget = {
  wallClockMs: 5 * 60_000,
  forgeCalls: 50,
  llmTokens: 100_000,
  cpuMillis: 120_000,
  memoryMb: 1024,
};

export class BudgetExceededError extends Error {
  constructor(readonly limit: keyof ScanBudget) {
    super(`Scan budget exceeded: ${limit}`);
    this.name = 'BudgetExceededError';
  }
}

/** Counts what a scanner spends, so the framework can stop it rather than trust it. */
export class BudgetMeter {
  private forgeCalls = 0;
  private llmTokens = 0;

  constructor(readonly budget: ScanBudget) {}

  chargeForgeCall(): void {
    this.forgeCalls += 1;
    if (this.forgeCalls > this.budget.forgeCalls) throw new BudgetExceededError('forgeCalls');
  }

  chargeTokens(n: number): void {
    this.llmTokens += n;
    if (this.llmTokens > this.budget.llmTokens) throw new BudgetExceededError('llmTokens');
  }

  spent(): { forgeCalls: number; llmTokens: number } {
    return { forgeCalls: this.forgeCalls, llmTokens: this.llmTokens };
  }
}

/**
 * Runs one scanner under its budget, isolating every failure.
 *
 * A scanner is third-party code by construction, so this function's job is to
 * make sure the worst it can do is produce no findings. It never rethrows:
 * a crashing scanner returns a failed result and the caller moves to the next
 * one, because NFR-15 says a poison scanner must not take ingestion, Tier-1
 * dashboards, or its neighbours down with it.
 */
export async function runScanner(
  scanner: Scanner,
  ctx: ScannerContext,
  now: () => number = Date.now,
): Promise<ScanRunResult> {
  const started = now();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new BudgetExceededError('wallClockMs')), ctx.budget.wallClockMs).unref?.(),
  );

  try {
    const findings = await Promise.race([scanner.run(ctx), timeout]);
    return {
      scannerKey: scanner.key,
      status: 'succeeded',
      findings,
      partial: false,
      durationMs: now() - started,
    };
  } catch (error) {
    const budgetHit = error instanceof BudgetExceededError;
    const status: ScanRunStatus = budgetHit ? 'budget_exceeded' : 'failed';
    return {
      scannerKey: scanner.key,
      status,
      // Partial findings are KEPT and flagged (§1.2). A timeout after finding
      // three real secrets should not throw the secrets away — but the set must
      // be labelled partial, or an incomplete scan reads as a clean one.
      findings: [],
      partial: budgetHit,
      durationMs: now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
