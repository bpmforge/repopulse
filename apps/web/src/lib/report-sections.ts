/**
 * A report section's heading (W16-54; shared with the compare table in
 * W20-22, UX_TODO ADM-25).
 *
 * `capitalize` on the raw id turned `ci` into "Ci" and `pr_flow` into "Pr
 * Flow" — the two acronyms this product is largely about, misspelled in the
 * document customers are handed. The map covers the ids where mechanical
 * casing is wrong; everything else keeps the underscore-to-space transform,
 * so a section added later still gets a readable heading rather than nothing.
 */
export const SECTION_TITLE: Record<string, string> = {
  ci: 'CI',
  pr_flow: 'PR flow',
  top_risks: 'Top risks',
  // W20-15 (UX_TODO X-22): open findings only, so the heading says so.
  findings: 'Open findings',
  risk_counts: 'Risk counts',
  score_breakdown: 'Health score breakdown',
  sbom: 'SBOM',
  vex: 'VEX',
  // W18-20. Mapped summary ids also get a heading: the governance summary
  // opens a new topic mid-report and would otherwise run on from the section
  // above it.
  ai_governance: 'AI-authored vs human changes',
  ai_governance_measures: 'AI-authored vs human: measures',
};

export function sectionTitle(id: string | undefined): string {
  const key = id ?? '';
  const mapped = SECTION_TITLE[key];
  if (mapped) return mapped;
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
