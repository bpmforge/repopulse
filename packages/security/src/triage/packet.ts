import { estimateTokens } from '@repopulse/analysis';

// The evidence packet a rule hit carries to the AI judge (W22-02, slice 1).
//
// Captured in the scan-runner while the snapshot exists (index/capture.ts) and
// stored on the finding beside context_lines, under the same retention: it is
// customer code. Here it is typed, read back defensively from the jsonb column,
// and rendered into the triage prompt within what the model's window leaves.
//
// The shape follows Lodestone's evidencePacket (enclosing chunk, callers,
// crossFileGraphReliable) plus what the judge was missing on the outline run:
// the definitions of the names used on the flagged lines.

export const CONTEXT_PACKET_VERSION = 1;

/** One run of consecutive lines; `lines` joined by '\n', `startLine` 1-based. */
export type PacketSegment = { startLine: number; lines: string };

export type DefinitionKind =
  | 'class_field'
  | 'module_const'
  | 'variable'
  | 'parameter'
  | 'function'
  | 'class'
  | 'type'
  | 'imported';

export type PacketDefinition = {
  /** As written on the flagged line: `this.workingTable`, `BATCH_SIZE`, `cfg.Limit`. */
  name: string;
  kind: DefinitionKind;
  file: string;
  line: number;
  /** The definition's own line(s), at most a few. */
  text: string;
  /** How it was reached, when not a plain same-file declaration: `imported from "./limits"`. */
  via?: string;
};

export type PacketCaller = { symbol: string; file: string; line: number; text: string };

/** Stored on findings.context_packet (jsonb). A type alias so it is a plain JSON record. */
export type ContextPacket = {
  v: 1;
  enclosing: {
    name: string | null;
    file: string;
    startLine: number;
    endLine: number;
    /** One segment when the function fits; head + the lines around the hit when it does not. */
    segments: PacketSegment[];
  } | null;
  definitions: PacketDefinition[];
  /** Names on the flagged lines with no definition found, and why (`imported from "pg"`). */
  unresolved: { name: string; note: string }[];
  callers: {
    symbol: string;
    shown: PacketCaller[];
    /** Every match found, of which `shown` is the first few. */
    total: number;
    /**
     * Lodestone's flag, same meaning: false = callers were matched by NAME only
     * (lexically), so an empty or short list is not evidence that nothing else
     * calls it, and a listed caller may be a different function of that name.
     */
    crossFileGraphReliable: boolean;
    method: 'name-match';
  } | null;
  /** What capture left out to stay inside the stored cap, in words. */
  omitted: string[];
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const isStr = (v: unknown): v is string => typeof v === 'string';

function segmentOf(v: unknown): PacketSegment | null {
  return isObj(v) && isInt(v.startLine) && isStr(v.lines)
    ? { startLine: v.startLine, lines: v.lines }
    : null;
}

/**
 * Reads a stored packet back, or null. Anything of an unknown version or the
 * wrong shape is dropped rather than half-trusted: the judge then works from
 * context_lines alone, as it did before packets existed.
 */
export function parseContextPacket(raw: unknown): ContextPacket | null {
  if (!isObj(raw) || raw.v !== CONTEXT_PACKET_VERSION) return null;
  let enclosing: ContextPacket['enclosing'] = null;
  const e = raw.enclosing;
  if (
    isObj(e) &&
    isStr(e.file) &&
    isInt(e.startLine) &&
    isInt(e.endLine) &&
    Array.isArray(e.segments)
  ) {
    const segments = e.segments.map(segmentOf).filter((s): s is PacketSegment => s !== null);
    if (segments.length > 0) {
      enclosing = {
        name: isStr(e.name) ? e.name : null,
        file: e.file,
        startLine: e.startLine,
        endLine: e.endLine,
        segments,
      };
    }
  }
  const definitions: PacketDefinition[] = Array.isArray(raw.definitions)
    ? raw.definitions.flatMap((d): PacketDefinition[] =>
        isObj(d) &&
        isStr(d.name) &&
        isStr(d.kind) &&
        isStr(d.file) &&
        isInt(d.line) &&
        isStr(d.text)
          ? [
              {
                name: d.name,
                kind: d.kind as DefinitionKind,
                file: d.file,
                line: d.line,
                text: d.text,
                ...(isStr(d.via) ? { via: d.via } : {}),
              },
            ]
          : [],
      )
    : [];
  const unresolved = Array.isArray(raw.unresolved)
    ? raw.unresolved.flatMap((u) =>
        isObj(u) && isStr(u.name) && isStr(u.note) ? [{ name: u.name, note: u.note }] : [],
      )
    : [];
  let callers: ContextPacket['callers'] = null;
  const c = raw.callers;
  if (isObj(c) && isStr(c.symbol) && Array.isArray(c.shown) && typeof c.total === 'number') {
    callers = {
      symbol: c.symbol,
      shown: c.shown.flatMap((s) =>
        isObj(s) && isStr(s.symbol) && isStr(s.file) && isInt(s.line) && isStr(s.text)
          ? [{ symbol: s.symbol, file: s.file, line: s.line, text: s.text }]
          : [],
      ),
      total: c.total,
      // Unknown means unreliable: the safe reading of an empty list.
      crossFileGraphReliable: c.crossFileGraphReliable === true,
      method: 'name-match',
    };
  }
  const omitted = Array.isArray(raw.omitted) ? raw.omitted.filter(isStr) : [];
  return { v: 1, enclosing, definitions, unresolved, callers, omitted };
}

export interface RenderedPacket {
  /** The prompt section, '' when nothing fitted. */
  text: string;
  tokens: number;
  /** Every numbered line shown, keyed `file:line`, so a citation of one can be checked. */
  lines: Map<string, string>;
  /** What did not fit the window, in words (also stated in `text`). */
  leftOut: string[];
}

function numbered(seg: PacketSegment, width: number): string {
  return seg.lines
    .split('\n')
    .map((l, i) => `${String(seg.startLine + i).padStart(width)}| ${l}`)
    .join('\n');
}

function remember(lines: Map<string, string>, file: string, seg: PacketSegment): void {
  seg.lines.split('\n').forEach((l, i) => lines.set(`${file}:${seg.startLine + i}`, l));
}

const KIND_WORDS: Record<DefinitionKind, string> = {
  class_field: 'class field',
  module_const: 'module-level constant',
  variable: 'variable',
  parameter: 'parameter of the enclosing function',
  function: 'function',
  class: 'class',
  type: 'type',
  imported: 'imported',
};

/**
 * The packet as a prompt section of at most `budgetTokens`. Pieces are added
 * in the order the judge needs them — definitions of the flagged names first
 * (what the outline run lacked), then the enclosing function, then callers —
 * and whatever does not fit is named in a closing "left out" list, so the model
 * is never left to read an absence as evidence.
 */
export function renderContextPacket(
  packet: ContextPacket,
  flaggedFile: string,
  budgetTokens: number,
): RenderedPacket {
  const lines = new Map<string, string>();
  const leftOut = [...packet.omitted.map((o) => `${o} (at scan time)`)];
  const parts: string[] = [];
  // Room for the header and the left-out list, kept back from the start.
  const reserve = 120;
  let used = 0;
  const fits = (text: string): boolean => used + estimateTokens(text) + reserve <= budgetTokens;
  const take = (text: string): void => {
    parts.push(text);
    used += estimateTokens(text);
  };
  const where = (file: string): string => (file === flaggedFile ? 'this file' : file);

  // 1. Definitions.
  if (packet.definitions.length > 0 || packet.unresolved.length > 0) {
    const head = '### Where the names on the flagged lines are defined';
    if (fits(head)) {
      take(head);
      for (const d of packet.definitions) {
        const segLines = d.text.split('\n');
        const seg = { startLine: d.line, lines: d.text };
        const width = String(d.line + segLines.length - 1).length;
        const block = [
          `- \`${d.name}\`: ${KIND_WORDS[d.kind] ?? d.kind}, ${where(d.file)} line ${d.line}${d.via ? ` (${d.via})` : ''}`,
          ...(d.file === flaggedFile ? [] : [`  file: ${d.file}`]),
          '```',
          numbered(seg, width),
          '```',
        ].join('\n');
        if (fits(block)) {
          take(block);
          remember(lines, d.file, seg);
        } else {
          leftOut.push(`the definition of ${d.name} (${d.file}:${d.line})`);
        }
      }
      for (const u of packet.unresolved) {
        const line = `- \`${u.name}\`: ${u.note}`;
        if (fits(line)) take(line);
        else leftOut.push(`the note on ${u.name}`);
      }
    } else {
      leftOut.push('the definitions of the names on the flagged lines');
    }
  }

  // 2. Enclosing function: whole, else its first segment, else nothing.
  const enc = packet.enclosing;
  if (enc) {
    const label = enc.name ? `\`${enc.name}\`` : 'an anonymous function';
    const width = String(enc.endLine).length;
    const render = (segs: PacketSegment[], partial: boolean): string =>
      [
        `### The enclosing function: ${label}, ${where(enc.file)} lines ${enc.startLine}-${enc.endLine}${partial ? ' (only part of it is shown)' : ''}`,
        ...(enc.file === flaggedFile ? [] : [`file: ${enc.file}`]),
        '```',
        segs.map((s) => numbered(s, width)).join(`\n${' '.repeat(width)}| …\n`),
        '```',
      ].join('\n');
    const cut = enc.segments.length > 1 || enc.segments[0]?.startLine !== enc.startLine;
    const whole = render(enc.segments, cut);
    if (fits(whole)) {
      take(whole);
      for (const s of enc.segments) remember(lines, enc.file, s);
    } else if (enc.segments.length > 1 && fits(render(enc.segments.slice(-1), true))) {
      // The segment around the hit is the one worth keeping.
      const last = enc.segments.slice(-1);
      take(render(last, true));
      for (const s of last) remember(lines, enc.file, s);
      leftOut.push(`the start of ${label} (lines ${enc.startLine}-…)`);
    } else {
      leftOut.push(`the enclosing function ${label} (${enc.file}:${enc.startLine}-${enc.endLine})`);
    }
  }

  // 3. Callers, with the reliability flag spelled out.
  const c = packet.callers;
  if (c) {
    const reliability = c.crossFileGraphReliable
      ? 'crossFileGraphReliable=true'
      : 'crossFileGraphReliable=false: found by name only, so an empty or short list is NOT evidence that nothing else calls it, and a listed line may call a different function of the same name';
    const head = `### Callers of \`${c.symbol}\` (${c.total} found; ${reliability})`;
    if (fits(head)) {
      take(head);
      if (c.shown.length === 0) {
        const none = '- none found';
        if (fits(none)) take(none);
      }
      let shown = 0;
      for (const s of c.shown) {
        const line = `- ${s.file}:${s.line}  ${s.text.trim()}`;
        if (!fits(line)) break;
        take(line);
        lines.set(`${s.file}:${s.line}`, s.text);
        shown += 1;
      }
      if (c.total > shown) leftOut.push(`${c.total - shown} of ${c.total} callers of ${c.symbol}`);
    } else {
      leftOut.push(`the callers of ${c.symbol}`);
    }
  }

  if (parts.length === 0 && leftOut.length === 0) return { text: '', tokens: 0, lines, leftOut };
  const out = [
    '## Evidence gathered from the scanned snapshot (lexical; line numbers are the real file lines)',
    ...parts,
  ];
  if (leftOut.length > 0) {
    // The list itself must fit too: as many entries as the budget holds, then a count.
    out.push('### Left out to fit');
    for (let i = 0; i < leftOut.length; i++) {
      const line = `- ${leftOut[i]}`;
      const rest = `- and ${leftOut.length - i} more`;
      if (estimateTokens([...out, line, rest].join('\n')) > budgetTokens) {
        out.push(rest);
        break;
      }
      out.push(line);
    }
  }
  const text = out.join('\n');
  const tokens = estimateTokens(text);
  // Too small a window for even the headings: send nothing rather than overrun it.
  if (tokens > budgetTokens) return { text: '', tokens: 0, lines: new Map(), leftOut };
  return { text, tokens, lines, leftOut };
}
