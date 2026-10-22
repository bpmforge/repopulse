// Findings export and the external-ticket link (W20-18, UX_TODO X-08; decision
// 2026-10-20: "Export yes; the ticket field as an optional URL").
//
// PURE FORMATTERS. The route (findings/index.ts) selects the rows with the
// list's own filters (listFilters, workspace-filtered), so an export holds
// exactly what the Findings list shows under the same filters, up to the cap.
// Nothing here reads the forge: an export is our own Postgres, written out.

/** The most findings one export writes; over it the file says it was cut. */
export const EXPORT_CAP = 5000;

export type ExportFormat = 'csv' | 'sarif';

/** One finding as an export needs it. */
export interface ExportRow {
  id: number;
  org: string;
  repoName: string;
  title: string;
  dimension: string;
  severity: number;
  confidence: number;
  status: string;
  dismissReason: string | null;
  file: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  ruleId: string | null;
  scannerKey: string | null;
  cveId: string | null;
  riskBand: string | null;
  effectiveRisk: string | number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  recommendation: string;
  externalTicketUrl: string | null;
}

/** The 1-5 scale in words, as every screen and report names it. */
export const SEVERITY_WORDS = ['info', 'low', 'medium', 'high', 'critical'] as const;
export const severityWord = (s: number): string =>
  SEVERITY_WORDS[Math.min(5, Math.max(1, s)) - 1] ?? 'info';

/** Where a finding opens in RepoPulse, when the install's public URL is known. */
export function findingLink(base: string | null, id: number): string | null {
  return base ? `${base.replace(/\/+$/, '')}/findings?finding=${id}` : null;
}

/**
 * One CSV cell. Quoted when it must be, and a cell a spreadsheet would run as
 * a formula (=, +, -, @, tab, carriage return first) gets a leading quote:
 * finding titles and file paths come from scanned code, which anyone can write.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = [
  'id',
  'repository',
  'title',
  'severity',
  'confidence',
  'dimension',
  'status',
  'dismiss_reason',
  'file',
  'line_start',
  'line_end',
  'rule_id',
  'scanner',
  'cve_id',
  'risk_band',
  'effective_risk',
  'first_seen',
  'last_seen',
  'external_ticket',
  'repopulse_link',
] as const;

export function findingsCsv(
  rows: readonly ExportRow[],
  opts: { base: string | null; truncated: boolean },
): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        `${r.org}/${r.repoName}`,
        r.title,
        severityWord(r.severity),
        r.confidence,
        r.dimension,
        r.status,
        r.dismissReason,
        r.file,
        r.lineStart,
        r.lineEnd,
        r.ruleId,
        r.scannerKey,
        r.cveId,
        r.riskBand,
        r.effectiveRisk === null ? null : Number(r.effectiveRisk),
        r.firstSeenAt.toISOString(),
        r.lastSeenAt.toISOString(),
        r.externalTicketUrl,
        findingLink(opts.base, r.id),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  // Said in the file, not only in a header nobody sees after saving it.
  if (opts.truncated) {
    lines.push(
      csvCell(
        `# Cut at ${EXPORT_CAP} findings. Narrow the filters to export the rest; nothing past the cap is in this file.`,
      ),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

function sarifLevel(severity: number): 'error' | 'warning' | 'note' {
  return severity >= 4 ? 'error' : severity === 3 ? 'warning' : 'note';
}

/** A rule id for every result: the scanner's own, or the dimension's. */
const ruleIdOf = (r: ExportRow): string => r.ruleId ?? `repopulse/${r.scannerKey ?? r.dimension}`;

/**
 * SARIF 2.1.0, one run per repository (paths in a run are relative to that
 * repository's root). Dismissed and won't-fix findings carry a suppression
 * saying a person accepted them, so a tool that imports this does not reopen
 * what was decided here.
 */
export function findingsSarif(
  rows: readonly ExportRow[],
  opts: { base: string | null; truncated: boolean; toolVersion?: string },
): Record<string, unknown> {
  const byRepo = new Map<string, ExportRow[]>();
  for (const r of rows) {
    const key = `${r.org}/${r.repoName}`;
    const list = byRepo.get(key) ?? [];
    list.push(r);
    byRepo.set(key, list);
  }
  const runs = [...byRepo.entries()].map(([repo, list]) => {
    const rules = new Map<string, { id: string; shortDescription: { text: string } }>();
    for (const r of list) {
      const id = ruleIdOf(r);
      if (!rules.has(id)) rules.set(id, { id, shortDescription: { text: r.title } });
    }
    return {
      tool: {
        driver: {
          name: 'RepoPulse',
          ...(opts.toolVersion ? { version: opts.toolVersion } : {}),
          ...(opts.base ? { informationUri: opts.base } : {}),
          rules: [...rules.values()],
        },
      },
      automationDetails: { id: `repopulse/${repo}/` },
      results: list.map((r) => {
        const link = findingLink(opts.base, r.id);
        const closed = r.status === 'dismissed' || r.status === 'wont_fix';
        return {
          ruleId: ruleIdOf(r),
          level: sarifLevel(r.severity),
          message: { text: r.recommendation ? `${r.title}. ${r.recommendation}` : r.title },
          ...(r.file
            ? {
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: r.file },
                      ...(r.lineStart !== null
                        ? {
                            region: {
                              startLine: r.lineStart,
                              ...(r.lineEnd !== null && r.lineEnd >= r.lineStart
                                ? { endLine: r.lineEnd }
                                : {}),
                            },
                          }
                        : {}),
                    },
                  },
                ],
              }
            : {}),
          ...(closed
            ? {
                suppressions: [
                  {
                    kind: 'external',
                    status: 'accepted',
                    justification: `${r.status === 'wont_fix' ? "Won't fix" : 'Dismissed'} in RepoPulse${r.dismissReason ? ` (${r.dismissReason})` : ''}.`,
                  },
                ],
              }
            : {}),
          properties: {
            repopulse_id: r.id,
            repository: repo,
            severity: severityWord(r.severity),
            confidence: r.confidence,
            dimension: r.dimension,
            status: r.status,
            ...(r.cveId ? { cve_id: r.cveId } : {}),
            ...(r.riskBand ? { risk_band: r.riskBand } : {}),
            ...(r.externalTicketUrl ? { external_ticket: r.externalTicketUrl } : {}),
            ...(link ? { repopulse_link: link } : {}),
          },
        };
      }),
    };
  });
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs:
      runs.length > 0
        ? runs
        : [{ tool: { driver: { name: 'RepoPulse', rules: [] } }, results: [] }],
    ...(opts.truncated
      ? {
          properties: {
            truncated: true,
            note: `Cut at ${EXPORT_CAP} findings. Narrow the filters to export the rest.`,
          },
        }
      : {}),
  };
}

/** Longest ticket link kept (the CHECK in migration 0051 says the same). */
export const TICKET_URL_MAX = 2048;

/**
 * An external-ticket link from a request: null clears it; otherwise an
 * absolute http(s) URL with no spaces and no user name or password in it.
 * Returns the cleaned URL, null to clear, or a sentence saying what is wrong.
 */
export function cleanTicketUrl(raw: unknown): { url: string | null } | string {
  if (raw === null || raw === undefined) return { url: null };
  if (typeof raw !== 'string') return 'url must be text, or null to remove the link.';
  const text = raw.trim();
  if (text === '') return { url: null };
  if (text.length > TICKET_URL_MAX) return `Keep the link under ${TICKET_URL_MAX} characters.`;
  if (/\s/.test(text)) return 'A link cannot contain spaces.';
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return 'Paste the full link to the ticket, starting with https://.';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Only http and https links can be stored.';
  }
  if (parsed.username || parsed.password) {
    return 'Remove the user name or password from the link before saving it.';
  }
  if (!/^https?:\/\//i.test(text)) return 'Paste the full link, starting with https://.';
  // The scheme in lower case: the column's CHECK reads it case-sensitively.
  return { url: `${parsed.protocol}${text.slice(parsed.protocol.length)}` };
}
