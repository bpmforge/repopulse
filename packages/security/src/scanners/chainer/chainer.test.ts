import { describe, expect, it } from 'vitest';
import {
  buildChains,
  chainIdOf,
  DEFAULT_MAX_CHAINS,
  chainSeverity,
  isVocabularyTerm,
  type ChainableFinding,
} from './build.js';

// Attack chain construction (W8-09, SECURITY_SUITE.md §3.5, FR-SEC-8).

const finding = (over: Partial<ChainableFinding> & { id: number }): ChainableFinding => ({
  dedupKey: `key-${over.id}`,
  severity: 3,
  title: `finding ${over.id}`,
  file: 'src/a.ts',
  scannerKey: 'semgrep',
  yields: [],
  preconditions: [],
  ...over,
});

describe('the golden chain', () => {
  it('links two findings that share a vocabulary term, at elevated severity', () => {
    // The shape the whole feature exists for: a leaked credential is the
    // precondition for a finding that needs one.
    const secret = finding({
      id: 1,
      severity: 4,
      title: 'AWS credential committed',
      scannerKey: 'secrets',
      yields: ['credential:aws'],
    });
    const use = finding({
      id: 2,
      severity: 3,
      title: 'S3 bucket read with ambient credentials',
      preconditions: ['credential:aws'],
      yields: ['data-read'],
    });

    const chains = buildChains([secret, use]);
    expect(chains).toHaveLength(1);
    const [chain] = chains;
    expect(chain?.steps.map((s) => s.id)).toEqual([1, 2]);
    expect(chain?.links).toEqual(['credential:aws']);
    // One above the worst step (4), not the max and not an average: the point
    // of a chain is that the combination is worse than the parts.
    expect(chain?.severity).toBe(5);
    expect(chain?.summary).toContain('[credential:aws] →');
  });

  it('caps chain severity at 5', () => {
    expect(chainSeverity([{ severity: 5 }, { severity: 2 }])).toBe(5);
    expect(chainSeverity([{ severity: 1 }])).toBe(2);
  });

  it('gives the same members the same chain id, every time', () => {
    // Derived from the members rather than generated, so a weekly recompute
    // updates the chain in place instead of raising a new one every week.
    const a = finding({ id: 1, yields: ['rce'] });
    const b = finding({ id: 2, preconditions: ['rce'] });
    expect(chainIdOf([a, b])).toBe(chainIdOf([a, b]));
    expect(chainIdOf([a, b])).not.toBe(chainIdOf([b, a]));
  });
});

describe('what does NOT become a chain', () => {
  it('a lone finding is not a chain', () => {
    expect(buildChains([finding({ id: 1, yields: ['rce'] })])).toEqual([]);
  });

  it('two findings that share nothing are not a chain', () => {
    const chains = buildChains([
      finding({ id: 1, yields: ['ssrf'] }),
      finding({ id: 2, preconditions: ['admin'] }),
    ]);
    expect(chains).toEqual([]);
  });

  it('matching is LITERAL — no synonyms, no inference', () => {
    // A chainer that guesses produces plausible paths nobody can refute, which
    // is worse than no chainer: every one of them has to be argued down.
    const chains = buildChains([
      finding({ id: 1, yields: ['credential:aws'] }),
      finding({ id: 2, preconditions: ['credential:amazon'] }),
    ]);
    expect(chains).toEqual([]);
  });

  it('ignores terms outside the shared vocabulary', () => {
    expect(isVocabularyTerm('rce')).toBe(true);
    expect(isVocabularyTerm('credential:gitea')).toBe(true);
    expect(isVocabularyTerm('vuln-dependency:CVE-2024-1234')).toBe(true);
    expect(isVocabularyTerm('something-a-model-invented')).toBe(false);

    const chains = buildChains([
      finding({ id: 1, yields: ['something-a-model-invented'] }),
      finding({ id: 2, preconditions: ['something-a-model-invented'] }),
    ]);
    expect(chains).toEqual([]);
  });

  it('never chains a finding to itself', () => {
    expect(buildChains([finding({ id: 1, yields: ['rce'], preconditions: ['rce'] })])).toEqual([]);
  });
});

describe('longer paths', () => {
  it('walks three steps and reports the whole path', () => {
    const chains = buildChains([
      finding({ id: 1, title: 'entry', yields: ['ssrf'] }),
      finding({ id: 2, title: 'middle', preconditions: ['ssrf'], yields: ['credential:aws'] }),
      finding({ id: 3, title: 'impact', severity: 4, preconditions: ['credential:aws'] }),
    ]);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.steps.map((s) => s.title)).toEqual(['entry', 'middle', 'impact']);
    expect(chains[0]?.severity).toBe(5);
  });

  it('stops at a cycle instead of looping forever', () => {
    // A loop still contains a real path up to the repeated node.
    const chains = buildChains([
      finding({ id: 1, yields: ['rce'], preconditions: ['data-write'] }),
      finding({ id: 2, preconditions: ['rce'], yields: ['data-write'] }),
    ]);
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      expect(new Set(chain.steps.map((s) => s.id)).size).toBe(chain.steps.length);
    }
  });

  it('respects the depth limit', () => {
    const findings = Array.from({ length: 8 }, (_, i) =>
      finding({
        id: i + 1,
        yields: [`credential:step${i + 1}`],
        ...(i > 0 ? { preconditions: [`credential:step${i}`] } : {}),
      }),
    );
    const chains = buildChains(findings, { maxDepth: 3 });
    expect(chains.every((c) => c.steps.length <= 3)).toBe(true);
  });

  it('orders worst chain first', () => {
    const chains = buildChains([
      finding({ id: 1, severity: 1, yields: ['ssrf'] }),
      finding({ id: 2, severity: 1, preconditions: ['ssrf'] }),
      finding({ id: 3, severity: 4, yields: ['rce'] }),
      finding({ id: 4, severity: 4, preconditions: ['rce'] }),
    ]);
    expect(chains[0]?.severity).toBeGreaterThan(chains[chains.length - 1]!.severity);
  });
});

describe('many findings per stage (the walk is capped, not the result)', () => {
  const TERMS = [
    'network-access',
    'sql-injection',
    'data-read',
    'auth-bypass',
    'admin',
    'rce',
    'data-write',
  ];
  // k findings per stage; every finding in a stage leads to every finding in
  // the next, so the number of paths is k^stages.
  const layered = (k: number, stages: number, severityOf = (_s: number, _j: number) => 3) => {
    const out: ChainableFinding[] = [];
    let id = 1;
    for (let s = 0; s < stages; s++) {
      for (let j = 0; j < k; j++) {
        out.push(
          finding({
            id: id++,
            severity: severityOf(s, j),
            preconditions: s === 0 ? [] : [TERMS[s]!],
            yields: [TERMS[s + 1]!],
          }),
        );
      }
    }
    return out;
  };

  it('stops at DEFAULT_MAX_CHAINS instead of enumerating a million paths', () => {
    // 10 per stage over 6 stages is 10^6 paths: measured 2.4 s and 1,000,000
    // chains before the cap moved inside the walk.
    const started = performance.now();
    const chains = buildChains(layered(10, 6));
    expect(chains).toHaveLength(DEFAULT_MAX_CHAINS);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('returns exactly what it returned before when the total is under the cap', () => {
    const all = buildChains(layered(3, 4), { maxChains: Number.POSITIVE_INFINITY });
    expect(all).toHaveLength(81);
    expect(buildChains(layered(3, 4)).map((c) => c.chainId)).toEqual(all.map((c) => c.chainId));
  });

  it('walks from the most severe finding first, so a tight cap keeps the severe chain', () => {
    // One severity-5 entry among severity-1 entries listed BEFORE it.
    const findings = layered(4, 3, (s, j) => (s === 0 && j === 3 ? 5 : 1));
    const [only] = buildChains(findings, { maxChains: 1 });
    expect(only?.severity).toBe(5);
  });
});
