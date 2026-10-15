import { SeverityBadge, type Severity } from '../../components/primitives/SeverityBadge.js';

// A finding's 1–5 severity as the UX_SPEC §2.1 severity ramp (W18-28).
//
// Every findings table printed it as "● critical" / "○ low" in body text, so a
// critical and a low finding differed by one glyph and the ramp the spec
// defines for exactly this column appeared nowhere a finding is listed. The
// badge keeps the word (colour is never the only carrier, §7) and adds the tint.
const SEVERITY_KEY: Record<number, Severity> = {
  5: 'critical',
  4: 'high',
  3: 'medium',
  2: 'low',
  1: 'info',
};

export function FindingSeverityBadge({ severity }: { severity: number }): React.JSX.Element {
  return <SeverityBadge severity={SEVERITY_KEY[severity] ?? 'info'} />;
}
