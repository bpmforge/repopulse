import { useCallback, useEffect, useRef, useState } from 'react';

// Following a manual scan to the end (W17-20).
//
// "Run scans now" (W16-10) returned 202 and stopped watching. The coverage
// table was refetched once, at the moment of the 202 — before the worker had
// inserted its scan_run row — so it went on saying "has never run" until the
// person reloaded the page, and if they DID reload mid-scan it said "◐ running
// now" for ever after, because nothing ever asked again. A spinner that
// outlives the job it describes is the failure this hook exists to prevent.
//
// The rules:
//
//   - poll while the table shows a scan in flight, and stop the moment it
//     does not: a terminal state (ok / error / partial / stale / …) ends the
//     poll by construction, so no spinner can outlive it;
//   - poll after a 202 until the job has been SEEN — a row goes to running,
//     or a run newer than any known at the click appears — because a fast
//     scan can finish between two polls without ever being observed running;
//   - give up waiting for pickup after a bounded time and SAY SO, because a
//     queue with no worker behind it must not read as "queued…" for an hour.

/** The slice of a coverage payload this hook reads. */
export interface ScanRow {
  key: string;
  state: string;
  last_run_at: string | null;
}

export interface ScanPayload {
  scanners: ScanRow[];
}

/** Poll interval while a scan is in flight or freshly queued. */
export const SCAN_POLL_MS = 4_000;

/**
 * How long a 202 may go unobserved before "queued" becomes "nobody picked it
 * up". Longer than any plausible queue wait on a working install; far shorter
 * than the hour after which the API itself calls a run stale.
 */
export const SCAN_PICKUP_TIMEOUT_MS = 5 * 60_000;

/** Scanner keys the payload reports in flight. */
export function runningKeys(data: ScanPayload | undefined): string[] {
  return (data?.scanners ?? []).filter((row) => row.state === 'running').map((row) => row.key);
}

/** The newest `last_run_at` across the payload, or null when none has one. */
export function newestRunAt(data: ScanPayload | undefined): string | null {
  let newest: string | null = null;
  for (const row of data?.scanners ?? []) {
    if (row.last_run_at && (newest === null || row.last_run_at > newest)) newest = row.last_run_at;
  }
  return newest;
}

/** Does any row carry a run newer than `since`? (`since` null = any run at all.) */
export function hasRunSince(data: ScanPayload | undefined, since: string | null): boolean {
  return (data?.scanners ?? []).some(
    (row) => row.last_run_at !== null && (since === null || row.last_run_at > since),
  );
}

interface Mark {
  /** The newest run known when the start was accepted. */
  since: string | null;
  /** When the start was accepted (ms). */
  at: number;
}

export interface ScanRun {
  /** Scanner keys in flight, straight from the payload. */
  running: string[];
  /** A start was accepted and no worker has been seen to pick it up yet. */
  awaiting: boolean;
  /** `awaiting` ran out its timeout without the job ever being observed. */
  stalled: boolean;
  /** Anything a second submission should wait for. */
  pending: boolean;
  /** Call when the API accepted a start (202). */
  onStarted: () => void;
  /** For `useApiQuery`: polls while there is something to wait for, else stops. */
  refetchInterval: (data: ScanPayload | undefined) => number | false;
}

export function useScanRun(
  data: ScanPayload | undefined,
  options: { now?: () => number; pickupTimeoutMs?: number } = {},
): ScanRun {
  const now = options.now ?? Date.now;
  const pickupTimeoutMs = options.pickupTimeoutMs ?? SCAN_PICKUP_TIMEOUT_MS;

  const [mark, setMark] = useState<Mark | null>(null);
  const [stalled, setStalled] = useState(false);

  const running = runningKeys(data);
  const observed = mark !== null && (running.length > 0 || hasRunSince(data, mark.since));
  const awaiting = mark !== null && !observed;

  // The mark has done its job once the queue has visibly acted on it: from
  // here the table's own `running` rows drive the poll, and they end it.
  useEffect(() => {
    if (observed) setMark(null);
  }, [observed]);

  // Bounded waiting. A job nobody picks up must become a sentence, not a
  // permanent "Queued…".
  useEffect(() => {
    if (!awaiting || mark === null) return;
    const remaining = mark.at + pickupTimeoutMs - now();
    if (remaining <= 0) {
      setMark(null);
      setStalled(true);
      return;
    }
    const timer = setTimeout(() => {
      setMark(null);
      setStalled(true);
    }, remaining);
    return () => clearTimeout(timer);
  }, [awaiting, mark, now, pickupTimeoutMs]);

  const sinceRef = useRef<string | null>(null);
  sinceRef.current = newestRunAt(data);
  const onStarted = useCallback(() => {
    setStalled(false);
    setMark({ since: sinceRef.current, at: now() });
  }, [now]);

  // A ref rather than the state itself, so the function handed to the query
  // reads the CURRENT mark whichever render created it.
  const awaitingRef = useRef(false);
  awaitingRef.current = awaiting;
  const refetchInterval = useCallback(
    (latest: ScanPayload | undefined): number | false =>
      runningKeys(latest).length > 0 || awaitingRef.current ? SCAN_POLL_MS : false,
    [],
  );

  return {
    running,
    awaiting,
    stalled,
    pending: running.length > 0 || awaiting,
    onStarted,
    refetchInterval,
  };
}
