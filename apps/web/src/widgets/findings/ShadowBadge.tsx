// The mark on a finding raised by a rule still in shadow (W18-29).
//
// A word, not a tint: "shadow" is a fact about the RULE (its precision is
// still being measured, CODE_HEALTH_SUITE §8.2), not a severity, so it borrows
// none of the severity ramp's colours and reads the same in print. The dashed
// outline is the second carrier for sighted users scanning a mixed list.

export const SHADOW_EXPLAINER =
  'From a rule still in shadow: its precision is being measured before anyone is asked to act on it. Shadow findings are left out of risk, top actions and CI checks.';

export function ShadowBadge({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-sm border border-dashed border-fg-faint px-1.5 py-0.5 text-xs text-fg-muted ${className}`}
      title={SHADOW_EXPLAINER}
      data-testid="shadow-badge"
    >
      shadow
    </span>
  );
}
