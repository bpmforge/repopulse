import { InternalLink } from '../plans/InternalLink.js';

// A rule id that goes somewhere (W20-13, UX_TODO FND-40).
//
// Rule ids in the registry, the precision table and the coverage map were
// plain text, so a reviewer could not get from a rule to the findings it
// raised. The link asks for shadow findings too and every status: a rule's
// record is everything it said, not only what is still open.

const LINK =
  'font-mono text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

export function RuleFindingsLink({
  ruleId,
  className = '',
}: {
  ruleId: string;
  className?: string;
}) {
  return (
    <InternalLink
      to="/findings"
      search={{ rule_id: ruleId, experimental: 'include', status: 'any' }}
      className={`${LINK} ${className}`}
      testId={`rule-findings-${ruleId}`}
    >
      {ruleId}
    </InternalLink>
  );
}

/** To the rule registry in Settings, where a shadow rule is promoted. */
export function RuleRegistryLink() {
  return (
    <InternalLink
      to="/admin/rules"
      className="text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      testId="rule-registry-link"
    >
      Settings → Rules
    </InternalLink>
  );
}
