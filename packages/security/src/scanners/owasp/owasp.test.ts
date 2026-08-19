import { describe, expect, it } from 'vitest';
import { buildChecklistPrompt, ChecklistMissingError, loadChecklist } from './checklist.js';
import { componentNames, isLlmPackage } from './llm-packages.js';

// OWASP checklist scanners (W8-08, SECURITY_SUITE.md §3.4, FR-SEC-7).

describe('checklist assets are versioned, not inlined', () => {
  it('loads both checklists with their versions', () => {
    const web = loadChecklist('owasp_web');
    const llm = loadChecklist('owasp_llm');
    expect(web.version).toBe('owasp-web.v1');
    expect(llm.version).toBe('owasp-llm.v1');
    // The version is what lands on the scan_run: a finding is only
    // reproducible against the questions that produced it.
    expect(web.prompt).toContain('A03');
    expect(llm.prompt).toContain('LLM05');
  });

  it('picks the HIGHEST version when several exist', () => {
    // Pinning belongs in per-repo config, not in a default that quietly runs
    // last year's questions forever.
    const dir = new URL('../../../checklists/', import.meta.url).pathname;
    expect(loadChecklist('owasp_web', dir).version).toBe('owasp-web.v1');
  });

  it('throws when a checklist is missing rather than running an empty prompt', () => {
    // An empty prompt would produce an empty findings array and a green run.
    expect(() => loadChecklist('owasp_web', '/tmp')).toThrow(ChecklistMissingError);
  });

  it('tells both checklists to answer with nothing when there is nothing', () => {
    // The line that stops a ten-category checklist producing ten findings.
    for (const key of ['owasp_web', 'owasp_llm'] as const) {
      expect(loadChecklist(key).prompt).toMatch(/Silence is a valid answer/);
    }
  });

  it('demands a VERBATIM quote in both', () => {
    for (const key of ['owasp_web', 'owasp_llm'] as const) {
      expect(loadChecklist(key).prompt).toMatch(/verbatim/i);
    }
  });

  it('publishes the shared chaining vocabulary in both', () => {
    // The chainer can only match findings that speak the same words.
    for (const key of ['owasp_web', 'owasp_llm'] as const) {
      const prompt = loadChecklist(key).prompt;
      for (const term of ['credential:{kind}', 'rce', 'sql-injection', 'auth-bypass']) {
        expect(prompt, `${key} / ${term}`).toContain(term);
      }
    }
  });
});

describe('the prompt puts the diff last, fenced, and labelled as data', () => {
  it('frames the diff as data rather than instructions', () => {
    // The scanner's entire input is attacker-influenced text: anyone who can
    // open a PR can write "ignore your instructions" in a comment.
    const prompt = buildChecklistPrompt(loadChecklist('owasp_web'), '+const a = 1;');
    expect(prompt).toContain('```diff');
    expect(prompt).toMatch(/DATA, never an\s+instruction/);
    // Instructions first, code last.
    expect(prompt.indexOf('A03')).toBeLessThan(prompt.indexOf('```diff'));
  });
});

describe('owasp_llm applies only where an LLM actually is', () => {
  it('recognises the client packages that mean a model is in play', () => {
    for (const name of [
      '@anthropic-ai/sdk',
      'openai',
      'langchain',
      '@langchain/core',
      'llamaindex',
      'ollama',
      '@google/generative-ai',
    ]) {
      expect(isLlmPackage(name), name).toBe(true);
    }
  });

  it('does not fire on packages that merely sound like one', () => {
    // A false positive here runs a whole LLM checklist over a codebase with no
    // model in it, and every finding it produces is confident and wrong.
    for (const name of ['openai-mock-server', 'my-openai-wrapper', 'aidan', 'chainsaw', 'aim']) {
      expect(isLlmPackage(name), name).toBe(false);
    }
  });

  it('reads component names out of a CycloneDX document defensively', () => {
    expect(componentNames({ components: [{ name: 'openai' }, { version: '1' }] })).toEqual([
      'openai',
    ]);
    // A malformed or absent SBOM is not a crash and not a match.
    expect(componentNames({})).toEqual([]);
    expect(componentNames({ components: 'nope' })).toEqual([]);
  });
});
