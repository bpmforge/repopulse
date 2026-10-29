import { z } from 'zod';
import type { CodeSlice } from './slice.js';
import {
  TRIAGE_VERDICTS,
  type CitedLine,
  type TriageRejectReason,
  type TriageVerdict,
  type TriageVex,
} from './types.js';
import { VEX_JUSTIFICATIONS } from '../vex/types.js';
import type { VexJustification } from '../validation/types.js';

// Validating a triage answer (W19-04).
//
// The rule that makes a verdict worth showing a person: it cites lines, and the
// lines exist in the slice it was shown. Citations are matched back to OUR copy
// of the file — the text stored on the proposal is ours, never the model's.

const citationSchema = z.object({
  line: z.number().int(),
  quote: z.string().max(400).optional(),
  /** W22-02: a line from another file shown in the evidence packet. */
  file: z.string().max(400).nullable().optional(),
});

const answerSchema = z.object({
  verdict: z.enum(TRIAGE_VERDICTS),
  confidence: z.number().int().min(1).max(5),
  citations: z.array(citationSchema).max(10).default([]),
  rationale: z.string().max(800),
  vex_justification: z
    .enum(VEX_JUSTIFICATIONS as [string, ...string[]])
    .nullable()
    .optional(),
  vex_statement: z.string().max(400).nullable().optional(),
  patch: z.string().max(20_000).nullable().optional(),
});

export interface AcceptedAnswer {
  verdict: TriageVerdict;
  confidence: number;
  rationale: string;
  citations: CitedLine[];
  vex: TriageVex | null;
  /** The model's proposed diff, still UNVERIFIED. Only present for a `real` verdict. */
  patchText: string | null;
  /** Fields dropped and why — reported, not silent. */
  notes: string[];
}

export type AnswerResult =
  { ok: true; answer: AcceptedAnswer } | { ok: false; reason: TriageRejectReason; detail: string };

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * `shown` (W22-02): the evidence packet's numbered lines, keyed `file:line`
 * (packet.ts renderContextPacket). A citation may name one of them; it is
 * checked and recorded from OUR copy exactly like a slice line.
 */
export function validateTriageAnswer(
  raw: unknown,
  slice: CodeSlice,
  shown: ReadonlyMap<string, string> = new Map(),
): AnswerResult {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'malformed',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  const a = parsed.data;

  if (a.citations.length === 0) {
    return {
      ok: false,
      reason: 'uncited',
      detail: `a "${a.verdict}" verdict cites no line; every verdict must cite a line it was given`,
    };
  }

  const citations: CitedLine[] = [];
  for (const c of a.citations) {
    const file = c.file && c.file.trim() !== '' ? c.file.trim() : slice.file;
    const inSlice = file === slice.file && c.line >= slice.startLine && c.line <= slice.endLine;
    const fromPacket = shown.get(`${file}:${c.line}`);
    if (!inSlice && fromPacket === undefined) {
      return {
        ok: false,
        reason: 'citation_not_found',
        detail:
          file === slice.file
            ? `cites line ${c.line}, outside the lines shown (${slice.startLine}-${slice.endLine}${shown.size > 0 ? ' and the evidence lines' : ''})`
            : `cites ${file} line ${c.line}, which was not shown`,
      };
    }
    const ours = inSlice ? (slice.lines[c.line - slice.startLine] ?? '') : (fromPacket as string);
    // A quote that is not on the line it names means the model is describing
    // code it cannot see. Substring either way: models trim and reflow.
    if (c.quote !== undefined && c.quote.trim() !== '') {
      const q = norm(c.quote);
      const o = norm(ours);
      if (!o.includes(q) && !q.includes(o)) {
        return {
          ok: false,
          reason: 'citation_not_found',
          detail: `line ${c.line} does not contain the quoted text`,
        };
      }
    }
    citations.push({ file, line: c.line, text: ours });
  }

  const notes: string[] = [];
  let vex: TriageVex | null = null;
  if (a.vex_justification) {
    // A justification says "this does not apply". On a `real` verdict that
    // contradicts itself; on `needs_human` it claims a certainty it disclaimed.
    if (a.verdict !== 'likely_false_positive') {
      return {
        ok: false,
        reason: 'ungrounded',
        detail: `proposes the VEX justification "${a.vex_justification}" on a "${a.verdict}" verdict`,
      };
    }
    vex = {
      justification: a.vex_justification as VexJustification,
      statement: a.vex_statement?.trim() || a.rationale.slice(0, 300),
    };
  }

  let patchText: string | null = null;
  if (a.patch && a.patch.trim() !== '') {
    if (a.verdict === 'real') patchText = a.patch;
    else notes.push(`dropped a patch offered with a "${a.verdict}" verdict`);
  }

  return {
    ok: true,
    answer: {
      verdict: a.verdict,
      confidence: a.confidence,
      rationale: a.rationale,
      citations,
      vex,
      patchText,
      notes,
    },
  };
}
