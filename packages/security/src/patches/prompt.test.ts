import { describe, expect, it } from 'vitest';
import {
  buildPatchPrompt,
  extractNoSafeFix,
  isFallbackFamilyRule,
  type PatchPromptFinding,
} from './prompt.js';

// The drafting prompt's rule against trading a lint hit for a crash, and the
// "no safe fix" answer (W22-09, 2026-10-30).

const finding = (ruleId: string | null): PatchPromptFinding => ({
  file: 'app/editor/DragTarget.ts',
  lineStart: 4,
  lineEnd: 5,
  title: 'Silent fallback return',
  ruleId,
  scannerKey: 'semgrep',
  evidence: 'catch { return null }',
  recommendation: 'Log or rethrow.',
});
const SOURCE =
  'function f(view, node) {\n  try {\n    return view.posAtDOM(node, 0);\n  } catch {\n    return null;\n  }\n}\n';

describe('buildPatchPrompt', () => {
  it('always says never to remove or weaken error handling, and how to answer when no safe fix exists', () => {
    const p = buildPatchPrompt(finding('bpm-eval'), SOURCE);
    expect(p).toContain('Never remove or weaken error handling to make the rule stop firing');
    expect(p).toContain('null/undefined fallback around a call that can throw');
    expect(p).toContain('Never add a force-unwrap or crash');
    expect(p).toContain('{"no_safe_fix":"<one sentence on why>"}');
    // Not the fallback-family paragraph for an unrelated rule.
    expect(p).not.toContain('HIDES a failure');
  });

  it('for a fallback-family rule, the fix must add handling and keep behaviour', () => {
    const p = buildPatchPrompt(finding('bpm-ch-silent-fallback-return'), SOURCE);
    expect(p).toContain('This rule flags error handling that HIDES a failure. The fix must ADD');
    expect(p).toContain('Removing the handler so the error propagates is NOT a fix.');
  });

  it('knows the fallback family across languages, and not the env-default rule', () => {
    for (const id of [
      'bpm-ch-silent-fallback-return',
      'bpm-ch-silent-fallback-return-py',
      'bpm-ch-java-silent-fallback-return',
      'bpm-slop-fallback-hides-failure-go',
      'bpm-ch-empty-catch',
      'bpm-slop-empty-catch-swift',
      'bpm-ch-empty-except-py',
      'bpm-ch-bare-except-py',
      'bpm-ch-rb-empty-rescue',
      'bpm-ch-rb-rescue-nil-modifier',
      'bpm-ch-go-swallowed-error',
      'bpm-ch-go-discarded-error',
      'bpm-ch-rs-swallowed-err',
      'bpm-ch-kt-run-catching-swallow',
      'bpm-ch-catch-all-fallback-cpp',
      'bpm-slop-try-parse-fallback',
    ]) {
      expect(isFallbackFamilyRule(id), id).toBe(true);
    }
    for (const id of [
      'bpm-eval',
      'bpm-slop-hardcoded-env-fallback',
      'bpm-ch-try-catch-in-loop',
      null,
    ]) {
      expect(isFallbackFamilyRule(id), String(id)).toBe(false);
    }
  });
});

describe('extractNoSafeFix', () => {
  it('reads the no-safe-fix answer, bare or fenced', () => {
    expect(extractNoSafeFix('{"no_safe_fix":"Only removing the catch clears it."}')).toBe(
      'Only removing the catch clears it.',
    );
    expect(extractNoSafeFix('```json\n{"no_safe_fix": true}\n```')).toBe('no reason given');
  });
  it('is null for a diff answer', () => {
    expect(extractNoSafeFix('{"diff":"--- a/x\\n+++ b/x\\n"}')).toBeNull();
    expect(extractNoSafeFix('{"diff":"--- a/x","no_safe_fix":"x"}')).toBeNull();
    expect(extractNoSafeFix('--- a/x\n+++ b/x\n')).toBeNull();
    expect(extractNoSafeFix('{"no_safe_fix": null}')).toBeNull();
  });
});
