import type { SpecialistId } from '@repopulse/analysis';

// Model evaluation (W19-05).
//
// Each specialist is run over labelled fixtures — a few cases with a planted
// defect and a few clean ones — for a chosen provider and model, and scored for
// PRECISION (of what it reported, how much was a real planted defect) and
// RECALL (of the planted defects, how many it reported). The published table is
// per model, with "not yet run" for anything unmeasured and the engine and date
// of every run.

export type EvalRole = SpecialistId;

/** A planted defect: the file and a quote that appears in the code at the defect. */
export interface EvalLabel {
  file: string;
  quote: string;
}

export type EvalCase =
  | {
      id: string;
      kind: 'diff';
      files: { path: string; patch: string }[];
      labels: EvalLabel[];
      note: string;
    }
  | { id: string; kind: 'file'; path: string; content: string; labels: EvalLabel[]; note: string }
  | {
      id: string;
      kind: 'module';
      files: { path: string; content: string }[];
      labels: EvalLabel[];
      note: string;
    };

export interface RoleScore {
  cases: number;
  /** Cases that hit a provider error and were NOT scored. */
  errored: number;
  /** Cases where the model never produced a valid answer after one retry (scored as nothing found). */
  formatFailures: number;
  tp: number;
  fp: number;
  fn: number;
  /** Extra findings on an already-matched defect: neither right nor wrong. */
  duplicates: number;
  /** null when nothing was reported (no TP, no FP) — not 100%, not 0%. */
  precision: number | null;
  /** null when there were no planted defects to find. */
  recall: number | null;
  /** `incomplete` when any case errored: its precision and recall are withheld. */
  state: 'scored' | 'incomplete';
}

export interface TriageSummary {
  total: number;
  agree: number;
  disagree: number;
  abstained: number;
  rejected: number;
  agreement: number | null;
  missedReal: number;
}

export interface ModelEvalRow {
  model: string;
  /** What served it: the adapter kind and host, so a number can be traced to an engine. */
  engine: string;
  ranAt: string;
  temperature: number;
  /** Requested seed, or null. Providers may ignore it; this records the request, not the guarantee. */
  seed: number | null;
  checklistVersions: Record<string, string>;
  /** False when any case errored. */
  complete: boolean;
  roles: Partial<Record<EvalRole, RoleScore>>;
  triage: TriageSummary | null;
  /** Provider errors, in full — a run that hit any is never presented as clean. */
  errors: { role: string; caseId: string; error: string }[];
}

export interface ModelEvalFile {
  schema: 1;
  rows: ModelEvalRow[];
}
