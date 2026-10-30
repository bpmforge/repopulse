// When each scanner runs on its own (W20-21, UX_TODO FND-52).
//
// The cron lines live in the worker's environment, and the Coverage table
// never said whether a scanner runs on every pull request, weekly, nightly or
// only when someone presses Run. This mirrors the repeatable jobs the worker
// registers (workers/index.ts) from the same variables; w20-21.test.ts reads
// the worker's list and fails if the two drift.

/** The cron variables the worker registers, with their shipped defaults. */
export function scanCrons(env: NodeJS.ProcessEnv = process.env) {
  return {
    weekly: env.SECURITY_WEEKLY_CRON ?? '41 2 * * 0',
    registers: env.REGISTERS_NIGHTLY_CRON ?? '17 3 * * *',
    chain: env.SECURITY_CHAIN_CRON ?? '41 3 * * 0',
    secretsHistory: env.SECRETS_HISTORY_CRON ?? '23 4 1 * *',
  };
}

/**
 * The repeatable jobs the worker registers, scanner key → cron (an empty map
 * when SECURITY_WEEKLY_CRON is `off`), in the worker's own order.
 */
export function scheduledScanners(env: NodeJS.ProcessEnv = process.env): [string, string][] {
  const c = scanCrons(env);
  if (c.weekly === 'off') return [];
  return [
    ['semgrep', c.weekly],
    ['code_health_tools', c.weekly],
    // W16-36. The CVE scan rides the same weekly slot as code health: both
    // want a snapshot of the same commit, and two tarballs for one tree would
    // be a rate-limit cost with nothing to show for it.
    ['dependency_cve', c.weekly],
    // W9-06: one entry drives both deterministic code-health scanners.
    ['anti_slop', c.weekly],
    ['attack_chainer', c.chain],
    ['supply_chain_register', c.registers],
    ['architecture_register', c.registers],
    ['test_gap_register', c.registers],
    // Weekly, not nightly: it drafts from a 30-day window of dismissals.
    // On the chain slot, an hour after the sweep: it shares the sweep's model.
    ['rule_draft_pass', c.chain],
    ['knowledge_register', c.registers],
    // W18-24. Nightly with the registers: alerts change when someone's CI runs.
    ['code_scanning_pull', c.registers],
  ];
}

/**
 * Scanners that run as part of another scheduled job rather than their own:
 * the logging and performance packs run inside the weekly anti-slop sweep, on
 * the snapshot it already took (workers/index.ts).
 */
const RIDES_WITH: Record<string, string> = {
  logging_hygiene: 'anti_slop',
  performance: 'anti_slop',
};

/**
 * PR-push scanners that run only when the change gives them something to read
 * (W21-02, security scanners/pr/run.ts PR_CONDITIONAL_SCANNERS).
 */
const PR_ONLY_WHEN: Record<string, string> = {
  dependency_cve: 'on pull requests that change a manifest or lockfile',
  container_image: 'on pull requests that change a file naming an image',
};

/** The pattern scanners PR_SCANS=off takes off PR pushes (W21-02). */
const PR_PATTERN_KEYS = new Set([
  'semgrep',
  'anti_slop',
  'logging_hygiene',
  'performance',
  'dependency_cve',
  'container_image',
]);

type Field = number[] | null; // null = every value

function parseField(raw: string, min: number, max: number): Field | undefined {
  if (raw === '*') return null;
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    if (!/^\d+$/.test(part)) return undefined;
    const n = Number(part);
    if (n < min || n > max) return undefined;
    out.add(n === 7 && max === 7 ? 0 : n);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The next time a five-field cron line fires after `from`, in the server's
 * local time (as BullMQ runs it). Supports numbers, comma lists and `*`;
 * anything richer (ranges, steps) returns null and the screen shows the line.
 */
export function nextCronRun(pattern: string, from: Date): Date | null {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = [
    parseField(parts[0]!, 0, 59),
    parseField(parts[1]!, 0, 23),
    parseField(parts[2]!, 1, 31),
    parseField(parts[3]!, 1, 12),
    parseField(parts[4]!, 0, 7),
  ];
  if (m === undefined || h === undefined || dom === undefined || mon === undefined) return null;
  if (dow === undefined) return null;
  const minutes = m ?? Array.from({ length: 60 }, (_, i) => i);
  const hours = h ?? Array.from({ length: 24 }, (_, i) => i);
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let i = 0; i < 400; i++) {
    const d = new Date(day.getFullYear(), day.getMonth(), day.getDate() + i);
    if (mon !== null && !mon.includes(d.getMonth() + 1)) continue;
    // Standard cron: when both day fields are restricted, either may match.
    const domOk = dom === null || dom.includes(d.getDate());
    const dowOk = dow === null || dow.includes(d.getDay());
    const dayOk = dom !== null && dow !== null ? domOk || dowOk : domOk && dowOk;
    if (!dayOk) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute);
        if (t.getTime() > from.getTime()) return t;
      }
    }
  }
  return null;
}

/** "weekly" / "nightly" / "monthly" / "on a schedule", from the line's shape. */
function cadenceWord(pattern: string): string {
  const p = pattern.trim().split(/\s+/);
  if (p.length !== 5) return 'on a schedule';
  if (p[2] === '*' && p[3] === '*' && p[4] === '*') return 'nightly';
  if (p[2] === '*' && p[3] === '*' && /^\d$/.test(p[4] ?? '')) return 'weekly';
  if (/^\d+$/.test(p[2] ?? '') && p[3] === '*' && p[4] === '*') return 'monthly';
  return 'on a schedule';
}

export interface ScannerRuns {
  /** Runs on its own when a pull request or a push arrives. */
  on_change: boolean;
  /** The cadence in a word, or null when it has no schedule. */
  cadence: string | null;
  /** The cron line, as configured. */
  cron: string | null;
  /** The next scheduled run (ISO), or null when unscheduled or not computable. */
  next_run_at: string | null;
  /** Can be started with "Run scans now". */
  manual: boolean;
  /** One line for the Coverage table. */
  text: string;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function when(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${WEEKDAY[d.getDay()]} ${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${hh}:${mm}`;
}

/** When one scanner runs on its own, from its declared triggers and the configured crons. */
export function scannerRuns(
  key: string,
  triggers: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): ScannerRuns {
  const onPush = triggers.includes('push');
  const onPr =
    triggers.includes('pr_synced') && !(env.PR_SCANS === 'off' && PR_PATTERN_KEYS.has(key));
  const onChange = onPr || onPush;
  const manual = triggers.includes('manual');
  const schedule = new Map(scheduledScanners(env));
  const c = scanCrons(env);
  let cron: string | null = null;
  if (triggers.includes('schedule')) {
    cron =
      key === 'secrets'
        ? c.secretsHistory === 'off'
          ? null
          : c.secretsHistory
        : (schedule.get(key) ?? schedule.get(RIDES_WITH[key] ?? '') ?? null);
  }
  const next = cron ? nextCronRun(cron, now) : null;
  const parts: string[] = [];
  if (onPr && onPush) parts.push('on every pull request and push');
  else if (onPr) parts.push(PR_ONLY_WHEN[key] ?? 'on every pull request push');
  else if (onPush) parts.push('on every push');
  if (cron) {
    const word = key === 'secrets' ? 'history sweep monthly' : cadenceWord(cron);
    parts.push(next ? `${word}, next ${when(next)} (server time)` : `${word} (${cron})`);
  }
  if (parts.length === 0) parts.push(manual ? 'only when started by hand' : 'not scheduled');
  else if (manual) parts.push('or by hand');
  return {
    on_change: onChange,
    cadence: cron ? cadenceWord(cron) : null,
    cron,
    next_run_at: next ? next.toISOString() : null,
    manual,
    text: parts.join('; '),
  };
}
