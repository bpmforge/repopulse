// SeverityBadge (UX §2.1 severity ramp): tinted background + strong text (never
// white-on-color) in both themes. The severity word is the label, so meaning
// never rides on color alone (UX §7).

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

const SEV_CLASS: Record<Severity, string> = {
  critical: 'bg-sev-critical/15 text-sev-critical',
  high: 'bg-sev-high/15 text-sev-high',
  medium: 'bg-sev-medium/15 text-sev-medium',
  low: 'bg-sev-low/15 text-sev-low',
  info: 'bg-sev-info/15 text-sev-info',
};

export interface SeverityBadgeProps {
  severity: Severity;
  className?: string;
}

export function SeverityBadge({ severity, className = '' }: SeverityBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-xs font-medium capitalize ${SEV_CLASS[severity]} ${className}`}
      data-testid="severity-badge"
      data-severity={severity}
    >
      {severity}
    </span>
  );
}
