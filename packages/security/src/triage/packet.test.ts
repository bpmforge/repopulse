import { describe, expect, it } from 'vitest';
import {
  budgetForContext,
  estimateTokens,
  type AnalysisGateway,
  type CompleteResult,
} from '@repopulse/analysis';
import { parseContextPacket, renderContextPacket, type ContextPacket } from './packet.js';
import { buildTriagePrompt } from './prompt.js';
import { runTriage } from './run.js';
import { sliceAround } from './slice.js';
import type { TriageCandidate } from './types.js';

// W22-02 slice 1: the judge's prompt carries the evidence packet captured at
// scan time, inside the model's window, and says what it left out. A finding
// stored before packets existed is judged exactly as before.

const FILE = 'server/tasks/BackfillTask.ts';
// The stored context window (W18-32): lines 12-20 of the file.
const WINDOW = [
  '    let done = 0;',
  '    while (done < total) {',
  '      // move one batch out of the working table',
  '      const rows = await sequelize.query(',
  '        `SELECT id FROM ${DEFAULT_SCHEMA}.${this.workingTable} WHERE id > ${cursor} LIMIT ${BATCH_SIZE}`,',
  '        { type: QueryTypes.SELECT }',
  '      );',
  '      done += rows.length;',
  '    }',
].join('\n');

const PACKET: ContextPacket = {
  v: 1,
  enclosing: {
    name: 'perform',
    file: FILE,
    startLine: 10,
    endLine: 22,
    segments: [
      {
        startLine: 10,
        lines: '  public async perform(cursor: number) {\n    const total = await this.count();',
      },
    ],
  },
  definitions: [
    {
      name: 'this.workingTable',
      kind: 'class_field',
      file: FILE,
      line: 8,
      text: '  private workingTable = "documents_backfill";',
    },
    {
      name: 'BATCH_SIZE',
      kind: 'module_const',
      file: FILE,
      line: 5,
      text: 'const BATCH_SIZE = 1000;',
    },
    {
      name: 'DEFAULT_SCHEMA',
      kind: 'module_const',
      file: 'server/migrations/constants.ts',
      line: 1,
      text: 'export const DEFAULT_SCHEMA = "public";',
      via: 'imported from "../migrations/constants"',
    },
  ],
  unresolved: [
    { name: 'sequelize', note: 'imported from "@server/storage/database" (not followed)' },
  ],
  callers: {
    symbol: 'perform',
    shown: [
      {
        symbol: 'perform',
        file: 'server/tasks/runner.ts',
        line: 5,
        text: 'await task.perform(0);',
      },
    ],
    total: 1,
    crossFileGraphReliable: false,
    method: 'name-match',
  },
  omitted: [],
};

function candidate(packet?: ContextPacket | null): TriageCandidate {
  return {
    finding: {
      dedupKey: 'k-16',
      scannerKey: 'semgrep',
      ruleId: 'bpm-sql-template-literal',
      title: 'SQL built from a template literal',
      dimension: 'security',
      file: FILE,
      lineStart: 16,
      lineEnd: 16,
      evidenceQuote: 'sequelize.query(`SELECT ... ${this.workingTable} ...`)',
    },
    reachability: { tier: null },
    source: WINDOW,
    sourceStartLine: 12,
    effectiveRisk: 5,
    ...(packet !== undefined ? { packet } : {}),
  };
}

function scripted(reply: string) {
  const prompts: string[] = [];
  const gateway: AnalysisGateway = {
    async complete(prompt): Promise<CompleteResult> {
      prompts.push(prompt);
      return {
        text: reply,
        model: 'scripted',
        tokensIn: 1,
        tokensOut: 1,
        costUsd: null,
        durationMs: 1,
      };
    },
    async health() {
      return { ok: true };
    },
  };
  return { gateway, prompts };
}

const answer = (citations: unknown[], verdict = 'likely_false_positive') =>
  JSON.stringify({
    verdict,
    confidence: 4,
    citations,
    rationale: 'workingTable is a constant string and BATCH_SIZE a module constant',
    vex_justification: null,
    vex_statement: null,
    patch: null,
  });

const meta = { repoId: '1', prNumber: 0, initiator: 'test' };

describe('the judge prompt with an evidence packet', () => {
  it('includes the definitions, the enclosing function and the callers with the reliability flag', async () => {
    const { gateway, prompts } = scripted(answer([{ line: 16 }]));
    await runTriage([candidate(PACKET)], { gateway, meta });
    const p = prompts[0]!;
    expect(p).toContain('## Evidence gathered from the scanned snapshot');
    expect(p).toContain('`this.workingTable`: class field, this file line 8');
    expect(p).toContain('8|   private workingTable = "documents_backfill";');
    expect(p).toContain('5| const BATCH_SIZE = 1000;');
    expect(p).toContain('1| export const DEFAULT_SCHEMA = "public";');
    expect(p).toContain('### The enclosing function: `perform`');
    expect(p).toContain('crossFileGraphReliable=false');
    expect(p).toContain('server/tasks/runner.ts:5  await task.perform(0);');
    // The packet comes before the answer template, which now allows a file.
    expect(p.indexOf('## Evidence')).toBeLessThan(p.indexOf('Respond ONLY with JSON'));
    expect(p).toContain('"file":"only for a line from a file other than the flagged one');
  });

  it('accepts a citation of a definition line outside the stored window, recorded from our copy', async () => {
    const { gateway } = scripted(
      answer([
        { line: 16, quote: 'LIMIT ${BATCH_SIZE}' },
        { line: 8, quote: 'private workingTable = "documents_backfill"' },
        { line: 1, file: 'server/migrations/constants.ts', quote: 'DEFAULT_SCHEMA = "public"' },
      ]),
    );
    const r = await runTriage([candidate(PACKET)], { gateway, meta });
    expect(r.rejections).toEqual([]);
    expect(r.proposals[0]!.citations).toEqual([
      { file: FILE, line: 16, text: expect.stringContaining('LIMIT ${BATCH_SIZE}') },
      { file: FILE, line: 8, text: '  private workingTable = "documents_backfill";' },
      {
        file: 'server/migrations/constants.ts',
        line: 1,
        text: 'export const DEFAULT_SCHEMA = "public";',
      },
    ]);
  });

  it('still rejects a citation of a line it was not shown, in either file', async () => {
    for (const bad of [{ line: 3 }, { line: 2, file: 'server/migrations/constants.ts' }]) {
      const { gateway } = scripted(answer([bad]));
      const r = await runTriage([candidate(PACKET)], { gateway, meta });
      expect(r.rejections[0]).toMatchObject({ reason: 'citation_not_found' });
    }
  });

  it('never exceeds the window, and names what it left out when the window is tight', async () => {
    const base = buildTriagePrompt({
      finding: candidate().finding,
      reachability: { tier: null },
      slice: sliceAround(WINDOW, FILE, 16, 16, 100_000, undefined, 12),
    }).tokens;
    // A window whose prompt budget leaves ~260 tokens for the packet.
    const tight = Math.ceil((base + 260 + 3000) / 0.75);
    for (const contextWindow of [tight, 16_000, 128_000, null]) {
      const { gateway, prompts } = scripted(answer([{ line: 16 }]));
      await runTriage([candidate(PACKET)], { gateway, meta, contextWindow });
      expect(estimateTokens(prompts[0]!)).toBeLessThanOrEqual(
        budgetForContext(contextWindow).promptTokens,
      );
    }
    const { gateway, prompts } = scripted(answer([{ line: 16 }]));
    await runTriage([candidate(PACKET)], { gateway, meta, contextWindow: tight });
    expect(prompts[0]).toContain('### Left out to fit');
    // The first definition still made it; the rest is named, not silently dropped.
    expect(prompts[0]).toContain('`this.workingTable`');
    expect(prompts[0]).toMatch(/- (the enclosing function|the callers of perform|and \d+ more)/);
  });

  it('a finding without a packet is judged exactly as before', async () => {
    const a = scripted(answer([{ line: 16 }]));
    const b = scripted(answer([{ line: 16 }]));
    const ra = await runTriage([candidate()], { gateway: a.gateway, meta });
    await runTriage([candidate(null)], { gateway: b.gateway, meta });
    expect(a.prompts[0]).toBe(b.prompts[0]);
    expect(a.prompts[0]).not.toContain('## Evidence');
    expect(a.prompts[0]).not.toContain('"file":');
    expect(ra.proposals).toHaveLength(1);
    // A packet line cannot be cited when there was no packet.
    const c = scripted(answer([{ line: 8 }]));
    const rc = await runTriage([candidate()], { gateway: c.gateway, meta });
    expect(rc.rejections[0]).toMatchObject({ reason: 'citation_not_found' });
  });
});

describe('parseContextPacket', () => {
  it('reads back a stored packet and drops an unknown version or shape', () => {
    expect(parseContextPacket(JSON.parse(JSON.stringify(PACKET)))).toEqual(PACKET);
    expect(parseContextPacket(null)).toBeNull();
    expect(parseContextPacket({ v: 2 })).toBeNull();
    expect(parseContextPacket('x')).toBeNull();
    const partial = parseContextPacket({
      v: 1,
      definitions: [{ name: 'x' }],
      callers: { symbol: 's', shown: [], total: 0 },
    });
    expect(partial).toMatchObject({
      enclosing: null,
      definitions: [],
      callers: { crossFileGraphReliable: false },
    });
  });

  it('renders nothing when even the headings do not fit', () => {
    expect(renderContextPacket(PACKET, FILE, 30)).toMatchObject({ text: '', tokens: 0 });
  });
});
