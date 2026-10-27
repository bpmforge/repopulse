import type { Dimension } from '../gateway/types.js';
import type { LlmRole } from '../routing/index.js';

// The specialist roster (W19-03).
//
// A specialist is a ROLE (what W19-02 routes models by), a DIMENSION (what a
// finding carries) and a versioned CHECKLIST ASSET (checklists/{id}.v{N}.md).
// For the six in the roster they are one name, which is deliberate: it is what
// lets the routing settings, the finding facet and the checklist file stay in
// step without a mapping table that can drift.
//
// WAVES are an ordering, not a dependency: wave 1 is what is most worth a
// scarce model call, so when a call budget caps a run (planner/runner) the
// later, advisory waves are the ones that go — and the result says so.

export const SPECIALIST_IDS = [
  'security',
  'performance',
  'code_health',
  'test_coverage',
  'best_practices',
  'ai_slop',
] as const;
export type SpecialistId = (typeof SPECIALIST_IDS)[number];

export interface Specialist {
  id: SpecialistId;
  dimension: Dimension;
  role: LlmRole;
  label: string;
  checklistVersion: string;
  wave: 1 | 2 | 3;
  /** Where the checklist came from, for the provenance the doc promises. */
  source: string;
}

const v1 = 'v1';

export const SPECIALISTS: readonly Specialist[] = Object.freeze([
  {
    id: 'security',
    dimension: 'security',
    role: 'security',
    label: 'Security',
    checklistVersion: v1,
    wave: 1,
    source: 'ANALYSIS_TIERS.md §4 (OWASP-informed, diff-scoped)',
  },
  {
    id: 'performance',
    dimension: 'performance',
    role: 'performance',
    label: 'Performance',
    checklistVersion: 'v3',
    wave: 2,
    source: 'ANALYSIS_TIERS.md §4; W9 v2; W21-20 v3 (algorithmic complexity, live eval 2026-10-26)',
  },
  {
    id: 'code_health',
    dimension: 'code_health',
    role: 'code_health',
    label: 'Code health',
    checklistVersion: 'v2',
    wave: 2,
    source: 'ANALYSIS_TIERS.md §4; W9-05 v2 (rule-id aligned)',
  },
  {
    id: 'test_coverage',
    dimension: 'test_coverage',
    role: 'test_coverage',
    label: 'Test coverage',
    checklistVersion: v1,
    wave: 2,
    source: 'ANALYSIS_TIERS.md §4',
  },
  {
    id: 'best_practices',
    dimension: 'best_practices',
    role: 'best_practices',
    label: 'Best practices',
    checklistVersion: v1,
    wave: 3,
    source: 'attest v3.13.3 code-review/pattern-consistency-checker, narrowed',
  },
  {
    id: 'ai_slop',
    dimension: 'ai_slop',
    role: 'ai_slop',
    label: 'AI slop',
    checklistVersion: v1,
    wave: 3,
    source: 'attest v3.13.3 agents/shared/ANTI_SLOP_RULES.md (judgement rules only)',
  },
] satisfies Specialist[]);

export function specialistById(id: SpecialistId): Specialist {
  const s = SPECIALISTS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown specialist "${id}"`);
  return s;
}
