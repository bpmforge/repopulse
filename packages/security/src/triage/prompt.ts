import { readFileSync } from 'node:fs';
import path from 'node:path';
import { estimateTokens } from '@repopulse/analysis';
import { VEX_JUSTIFICATIONS } from '../vex/types.js';
import { CHECKLIST_DIR } from '../scanners/owasp/checklist.js';
import type { CodeSlice } from './slice.js';
import { TRIAGE_CHECKLIST_VERSION, type TriageFinding, type TriageReachability } from './types.js';

// The triage prompt (W19-04). The checklist is a versioned asset
// (checklists/triage.v1.md); the proposal records which version asked.

export function loadTriageChecklist(dir: string = CHECKLIST_DIR): string {
  // Loaded by exact version, not "highest wins": a proposal is only
  // reproducible against the prompt that produced it.
  return readFileSync(path.join(dir, `${TRIAGE_CHECKLIST_VERSION}.md`), 'utf8');
}

/**
 * The answer template. Every enumerated value is written out — a placeholder
 * like <verdict> invites the model to invent a label (W19-03 found a real model
 * answering `"dimension":"slop"` to a `<dimension>` placeholder).
 */
const REQUIRED_JSON = `Respond ONLY with JSON of this exact shape, and nothing else:

{"verdict":"real" or "likely_false_positive" or "needs_human",
"confidence":1-5,
"citations":[{"line":<a line number printed in the left margin above>,"quote":"the text of that line"}],
"rationale":"<=600 chars, naming what in the cited lines decides it",
"vex_justification":null or one of ${VEX_JUSTIFICATIONS.map((j) => `"${j}"`).join(' or ')},
"vex_statement":null or "<=300 chars",
"patch":null or "a unified diff against this file"}

Use null for vex_justification, vex_statement and patch unless the rules above allow them.`;

/** With an evidence packet, a citation may name a numbered line from another file. */
const REQUIRED_JSON_WITH_PACKET = REQUIRED_JSON.replace(
  '{"line":<a line number printed in the left margin above>,"quote":"the text of that line"}',
  '{"line":<a line number printed in a left margin above>,"quote":"the text of that line","file":"only for a line from a file other than the flagged one: the path shown with it"}',
);

export interface TriagePrompt {
  text: string;
  tokens: number;
  checklistVersion: string;
}

export function buildTriagePrompt(args: {
  finding: TriageFinding;
  reachability: TriageReachability;
  slice: CodeSlice;
  checklist?: string;
  /** W22-02: the rendered evidence packet (packet.ts), already cut to its budget. */
  packetText?: string;
}): TriagePrompt {
  const { finding, reachability, slice } = args;
  const reach =
    reachability.tier === null
      ? 'not computed for this scanner'
      : `${reachability.tier}${reachability.detail ? ` — ${reachability.detail}` : ''}`;

  const text = [
    args.checklist ?? loadTriageChecklist(),
    '',
    '## The finding',
    `Rule: ${finding.ruleId}  (scanner: ${finding.scannerKey}${finding.packVersion ? `, pack ${finding.packVersion}` : ''})`,
    `Title: ${finding.title}`,
    finding.ruleDescription ? `What the rule looks for: ${finding.ruleDescription}` : '',
    finding.cwe ? `CWE: ${finding.cwe}` : '',
    `Dimension: ${finding.dimension}`,
    `Flagged lines: ${finding.lineStart}-${finding.lineEnd} of ${finding.file}`,
    `Flagged text: ${finding.evidenceQuote}`,
    `Reachability: ${reach}`,
    '',
    `## ${slice.file}, lines ${slice.startLine}-${slice.endLine}${slice.truncated ? ' (cut short to fit)' : ''}`,
    '```',
    slice.text,
    '```',
    '',
    ...(args.packetText ? [args.packetText, '', REQUIRED_JSON_WITH_PACKET] : [REQUIRED_JSON]),
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');

  return { text, tokens: estimateTokens(text), checklistVersion: TRIAGE_CHECKLIST_VERSION };
}
