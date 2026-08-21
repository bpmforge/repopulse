import { z } from 'zod';
import type { ValidatedVulnerability, VexJustification, VexProposal } from '../types.js';
import type { CitedEvidence, RejectReason } from './types.js';

// V5 answer validation (W8-15, FR-SEC-14).
//
// THIS FILE IS THE POINT OF THE TICKET. A proposal that cites evidence which
// does not exist is worse than no proposal: it is a dismissal argument with a
// fabricated footnote, aimed at a human who is triaging forty other things and
// has every reason to trust a file:line. So an answer has to survive three
// checks, in order, and any one of them throws the whole answer away rather
// than salvaging the parts that passed.
//
//   1. SHAPE      — the JSON the checklist asked for, nothing else.
//   2. CITATION   — every cited file:line matches a V2 import or a V3 call site
//                   this funnel actually recorded for THIS vulnerability.
//   3. GROUND     — the justification's precondition holds on the deterministic
//                   verdicts. A model cannot talk its way past V1/V2/V3.
//
// Check 3 is what stops the failure mode this pass is most likely to produce.
// `usage: unknown` is the MAJORITY answer for transitive dependencies — V2 can
// only see this repository's own imports — and a model handed "unknown" and
// asked whether a CVE applies will reach for `vulnerable_code_not_present`
// unless something refuses it. Something refuses it here.

const JUSTIFICATIONS = [
  'component_not_present',
  'vulnerable_code_not_present',
  'vulnerable_code_not_in_execute_path',
  'vulnerable_code_cannot_be_controlled_by_adversary',
  'inline_mitigations_already_exist',
] as const satisfies readonly VexJustification[];

/** How much of the model's reason survives into the statement a human reads. */
const REASON_LIMIT = 400;

/**
 * The output contract, as zod.
 *
 * `strict()` because an extra key means the model answered a different question
 * than the one asked — usually a hallucinated `severity` or `cvss` it has no
 * basis for — and accepting the parts we recognise would hide that.
 */
export const verifyAnswerSchema = z
  .object({
    applies: z.boolean(),
    justification: z.enum(JUSTIFICATIONS).nullable(),
    confidence: z.number().int().min(1).max(5),
    // The checklist asks for 400 characters and this accepts far more, because
    // over-running a length hint is not getting the question wrong. Rejecting
    // at 401 would file a chatty-but-correct answer as `malformed`, which is
    // the mislabelling stripFence exists to avoid. It is TRIMMED where the
    // statement is composed instead; the ceiling here only catches a model that
    // has started generating prose instead of a verdict.
    reason: z.string().trim().min(1).max(4000),
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(['import', 'call_site']),
            file: z.string().trim().min(1),
            line: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict()
  .refine(
    (answer) => (answer.applies ? answer.justification === null : answer.justification !== null),
    {
      // The two halves have to agree. "It applies, and here is why it does not"
      // is not a partially usable answer; it is an answer we cannot act on in
      // either direction.
      message:
        'applies:true must carry justification:null, and applies:false must carry a justification',
    },
  );

export type VerifyAnswer = z.infer<typeof verifyAnswerSchema>;

export type AnswerValidation =
  | { ok: true; answer: VerifyAnswer; citedEvidence: CitedEvidence[]; proposal: VexProposal | null }
  | { ok: false; reason: RejectReason; detail: string };

/**
 * Parses and grounds one answer.
 *
 * `model` rides into the proposal's statement rather than being appended by a
 * caller: a proposal without an author is a sentence a human is asked to trust
 * with no way to weigh it, and the author is only known here.
 */
export function validateVerifyAnswer(
  raw: unknown,
  vulnerability: ValidatedVulnerability,
  model: string,
): AnswerValidation {
  const parsed = verifyAnswerSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'malformed',
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    };
  }
  const answer = parsed.data;

  const cited: CitedEvidence[] = [];
  for (const citation of answer.evidence) {
    const match = matchEvidence(vulnerability, citation);
    if (!match) {
      // REJECTED, not dropped. An answer that invented one of its three
      // citations has told us something about the other two, and keeping them
      // would be keeping the part of a fabrication that happens to check out.
      return {
        ok: false,
        reason: 'evidence_not_found',
        detail:
          `cited ${citation.kind} ${citation.file}:${citation.line}, which appears in no V2 ` +
          `import record or V3 call site for ${vulnerability.primaryId} in ${vulnerability.packageName}`,
      };
    }
    cited.push(match);
  }

  if (answer.applies || answer.justification === null) {
    // The ordinary answer: the model could not find a reason this does not
    // apply. It produces no proposal and is still worth recording — an
    // affirmation is evidence the pass ran and did not bite.
    return { ok: true, answer, citedEvidence: cited, proposal: null };
  }

  const ungrounded = groundFailure(answer.justification, vulnerability, cited);
  if (ungrounded) return { ok: false, reason: 'ungrounded', detail: ungrounded };

  return {
    ok: true,
    answer,
    citedEvidence: cited,
    proposal: {
      justification: answer.justification,
      statement: statementFor(answer, vulnerability, cited, model),
    },
  };
}

/** A citation matched back to OUR record, so the detail text is never the model's. */
function matchEvidence(
  vulnerability: ValidatedVulnerability,
  citation: { kind: 'import' | 'call_site'; file: string; line: number },
): CitedEvidence | null {
  // Compared on the normalised path because a model asked to copy a path will
  // sometimes add a leading `./` or `/`. That is a transcription difference,
  // not a fabricated citation, and treating it as one would reject good
  // answers for a reason nobody could act on.
  const wanted = normalise(citation.file);

  if (citation.kind === 'import') {
    const hit = vulnerability.usage.evidence.find(
      (evidence) => normalise(evidence.file) === wanted && evidence.line === citation.line,
    );
    return hit ? { kind: 'import', file: hit.file, line: hit.line, detail: hit.quote } : null;
  }

  const hit = vulnerability.reachability.callSites.find(
    (site) => normalise(site.file) === wanted && site.line === citation.line,
  );
  return hit ? { kind: 'call_site', file: hit.file, line: hit.line, detail: hit.symbol } : null;
}

function normalise(file: string): string {
  return file.replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * The precondition for each justification, or null when it holds.
 *
 * These are the same grounds the checklist states, enforced rather than
 * requested. A prompt rule the code does not check is a suggestion, and this is
 * the one place where a model being persuasive must not be enough.
 */
function groundFailure(
  justification: VexJustification,
  vulnerability: ValidatedVulnerability,
  cited: readonly CitedEvidence[],
): string | null {
  const scope = vulnerability.scope;
  const usage = vulnerability.usage;

  switch (justification) {
    case 'component_not_present':
      if (scope.inResolvedSet) {
        return `${scope.manifest ?? 'a lockfile'} resolves ${vulnerability.packageName}, so it is present`;
      }
      if (scope.unreadableReason) {
        // "We could not read a manifest" and "the manifest does not list it"
        // are opposite facts that both produce inResolvedSet:false, and only
        // one of them is a reason to say the component is absent.
        return `no manifest could be read for this ecosystem (${scope.unreadableReason}), which is not evidence of absence`;
      }
      return null;

    case 'vulnerable_code_not_present':
    case 'vulnerable_code_not_in_execute_path':
      if (usage.status === 'not_imported') return null;
      if (vulnerability.reachability.tier === 'proven_unreachable') return null;
      if (usage.status === 'unknown') {
        return (
          `V2 answered 'unknown' (${usage.unknownReason ?? 'no reason recorded'}), which is an ` +
          'absence of evidence and cannot support a not_affected justification'
        );
      }
      return `V2 found ${vulnerability.packageName} imported, so its code is present in this repository`;

    case 'vulnerable_code_cannot_be_controlled_by_adversary':
    case 'inline_mitigations_already_exist':
      // Both are claims ABOUT code, so they require the code to have been
      // seen. Without a citation the model is reasoning about a dependency
      // whose source it was never shown.
      if (usage.status !== 'imported') {
        return `this justification is a claim about code that was read, but V2's verdict is '${usage.status}'`;
      }
      if (cited.length === 0) {
        return 'no V2 or V3 evidence line was cited, so the claim rests on nothing that was shown';
      }
      return null;
  }
}

/**
 * The sentence a human confirms or rejects.
 *
 * It carries the model's reason, its author, its confidence AND the limit of
 * what the pass could see. The limit is not boilerplate: this is a judgement
 * made from an evidence summary with no dependency source in it, and a
 * statement that read like a finding would invite exactly the unattended
 * dismissal the whole tier is built to prevent.
 */
function statementFor(
  answer: VerifyAnswer,
  vulnerability: ValidatedVulnerability,
  cited: readonly CitedEvidence[],
  model: string,
): string {
  const citations =
    cited.length > 0
      ? ` Cited: ${cited.map((evidence) => `${evidence.file}:${evidence.line}`).join(', ')}.`
      : '';
  // Trimmed, and visibly so. A statement is a sentence a human reads in a
  // triage row; a thousand words of model prose there would be scrolled past,
  // and the ellipsis is what tells a reader there was more rather than letting
  // a truncated clause read as the whole thought.
  const reason =
    answer.reason.length > REASON_LIMIT
      ? `${answer.reason.slice(0, REASON_LIMIT)}…`
      : answer.reason;
  return (
    `${reason}${citations} Proposed by ${model} at confidence ${answer.confidence}/5 from ` +
    `V1-V3 evidence for ${vulnerability.packageName} ${vulnerability.packageVersion} only — no ` +
    'dependency source and no runtime behaviour was examined. A human confirms this before ' +
    'anything is suppressed.'
  );
}
