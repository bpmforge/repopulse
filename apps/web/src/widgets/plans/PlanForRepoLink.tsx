import { InternalLink } from './InternalLink.js';
import { planSearchForRepo } from './contracts.js';

// From a review to the plan for its repository (W17-24).
//
// The finding already knows which repository it is in; the Plans page reads
// the same `?repos=` the topbar filter writes. So the path from "this finding"
// to "the plan for its repository" is one link carrying the id — nobody copies
// a number out of one screen into another. It NAVIGATES only: no plan exists
// until a person presses Generate on the page it lands on.

export function PlanForRepoLink({ repoId }: { repoId: number }) {
  return (
    <InternalLink
      to="/plans"
      search={planSearchForRepo(repoId)}
      className="text-xs text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      testId="plan-for-repo-link"
    >
      Improvement plan for this repository →
    </InternalLink>
  );
}
