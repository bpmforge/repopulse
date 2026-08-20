import type { RiskBand } from '../../widgets/risk/contracts.js';
import { RISK_BAND_LABEL } from '../../widgets/risk/contracts.js';

// Risk band chip (W9-11, DASHBOARD.md, FR-RISK-5).
//
// A shared primitive because three surfaces show this and they must not drift
// on what a band means. Word + glyph, never colour alone (UX_SPEC §7) — and
// the word is a VERB, because people act on verbs rather than on numbers.

export function RiskBandChip({ band, testId }: { band: RiskBand | null; testId?: string }) {
  return (
    <span
      className="rounded-sm border border-border px-1.5 py-0.5 text-xs"
      data-testid={testId ?? 'risk-band-chip'}
      data-band={band ?? 'unpriced'}
    >
      {/* An unpriced finding says so. It has not been judged low-risk; the
          nightly reprice has simply not reached it yet. */}
      {band === null ? '· not yet priced' : RISK_BAND_LABEL[band]}
    </span>
  );
}
