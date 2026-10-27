// Per-host call slots shared by every T2Client in a process.
//
// WHY THIS EXISTS. The concurrency cap (FR-ANALYSIS-8) was counted per
// T2Client, and the worker builds several: one gateway per workspace, plus a
// pinned one for every second-opinion check. On the 2026-10-27 walkthrough
// four scans sent completions to ONE LM Studio at once — each "within the cap"
// of its own client — and the host served them in turn, so every request's
// 20-minute timeout was mostly spent queued behind the others. A 2-call CVE
// check took 15 minutes and the anti-slop review of the largest repository
// was abandoned at 1200s.
//
// WAITING, NOT PARKING. pickHost()'s null-means-park contract still holds
// within one client. Across clients a call waits here for its turn instead,
// because a multi-call scan cannot be parked between calls: anti-slop judges
// batch 2 after batch 1 is already stored, and re-queueing it would redo
// batch 1. The wait is bounded (queueTimeoutMs) and fails BY NAME, so a busy
// host reads as busy rather than as a slow model.

export class HostBusyError extends Error {
  constructor(host: string, waitedMs: number, ahead: number) {
    super(
      `waited ${Math.round(waitedMs / 1000)}s for ${host}, which was busy with other ` +
        `analysis (${ahead} call${ahead === 1 ? '' : 's'} ahead) — nothing was sent to the model; ` +
        'run it again later, add a second model host, or raise LMSTUDIO_QUEUE_TIMEOUT_MS',
    );
    this.name = 'HostBusyError';
  }
}

interface Slot {
  active: number;
  waiters: { grant: () => void }[];
}

export class HostSlots {
  private readonly slots = new Map<string, Slot>();

  private slot(host: string): Slot {
    let s = this.slots.get(host);
    if (!s) {
      s = { active: 0, waiters: [] };
      this.slots.set(host, s);
    }
    return s;
  }

  /** Calls holding a slot on `host` right now. */
  active(host: string): number {
    return this.slots.get(host)?.active ?? 0;
  }

  /**
   * Resolves with a release function once fewer than `cap` calls hold `host`.
   * First come, first served. Rejects with HostBusyError after `maxWaitMs`.
   */
  acquire(host: string, cap: number, maxWaitMs: number): Promise<() => void> {
    const s = this.slot(host);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      s.active -= 1;
      const next = s.waiters.shift();
      if (next) next.grant();
    };
    if (s.active < cap && s.waiters.length === 0) {
      s.active += 1;
      return Promise.resolve(release);
    }
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          clearTimeout(timer);
          s.active += 1;
          resolve(release);
        },
      };
      const timer = setTimeout(() => {
        const at = s.waiters.indexOf(waiter);
        if (at >= 0) s.waiters.splice(at, 1);
        reject(new HostBusyError(host, Date.now() - started, s.active + Math.max(0, at)));
      }, maxWaitMs);
      s.waiters.push(waiter);
    });
  }
}

/** The process-wide table every T2Client uses unless a test injects its own. */
export const SHARED_HOST_SLOTS = new HostSlots();
