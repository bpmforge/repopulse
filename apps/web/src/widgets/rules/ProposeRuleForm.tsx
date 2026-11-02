import { useState } from 'react';
import { ErrorNote } from '../../components/index.js';
import { useApiMutation } from '../../api/useApiQuery.js';

// "Propose a rule" (W20-08, UX_TODO FND-65, SRS FR-CH-9 (a) and (c)).
//
// Nothing could put a rule into the registry: the only writer was an
// admin-only POST /rules taking a whole HealthRule body, and the web app never
// called it, so the lifecycle (accept to shadow, promote, deprecate) could not
// be reached. This form is that body, filled in by a person. From a finding it
// starts from the finding's own evidence. Whatever is sent lands PROPOSED — the
// API forces that — and runs nowhere until an admin accepts it to shadow and
// the promotion gate is met.

/** CODE_HEALTH_SUITE §8.1 domains and layers; the API validates both. */
export const RULE_DOMAINS = ['slop', 'logging', 'perf', 'correctness', 'framework'] as const;
export const RULE_LAYERS = ['pack', 'hybrid', 'llm'] as const;
const RULE_ID = /^[a-z0-9_]+\.[a-z0-9-]+$/;

export interface RuleDraft {
  id: string;
  domain: (typeof RULE_DOMAINS)[number];
  layer: (typeof RULE_LAYERS)[number];
  languages: string;
  severity: number;
  engineRule: string;
  checklistItem: string;
  trigger: string;
  clean: string;
  source: string;
}

/** The finding a rule is proposed from — only what the draft reads. */
export interface RuleSeed {
  id: number;
  title: string;
  dimension: string;
  severity: number;
  file: string | null;
  evidence: string;
  rule_id?: string | null;
  context?: { start_line: number; lines: string } | null;
}

const DOMAIN_OF: Record<string, RuleDraft['domain']> = {
  slop: 'slop',
  logging: 'logging',
  performance: 'perf',
};

const LANGUAGE_OF: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
};

/** A starting draft: from a finding when there is one, else blank. */
export function draftFrom(seed?: RuleSeed): RuleDraft {
  if (!seed) {
    return {
      id: '',
      domain: 'correctness',
      layer: 'llm',
      languages: '',
      severity: 3,
      engineRule: '',
      checklistItem: '',
      trigger: '',
      clean: '',
      source: 'manual_research',
    };
  }
  const domain = DOMAIN_OF[seed.dimension] ?? 'correctness';
  const slug = (seed.rule_id ?? seed.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const ext = seed.file?.split('.').pop() ?? '';
  return {
    id: slug ? `${domain}.${slug}` : '',
    domain,
    layer: 'llm',
    languages: LANGUAGE_OF[ext] ?? '',
    severity: Math.min(5, Math.max(1, seed.severity)),
    engineRule: '',
    checklistItem: seed.title,
    // The lines the finding was raised on are the first trigger fixture: the
    // rule must at least fire on the case that prompted it.
    trigger: seed.context?.lines ?? seed.evidence,
    clean: '',
    source: `field_lesson:finding/${seed.id}`,
  };
}

/** What is missing before the API would accept it, in words. */
export function draftProblems(d: RuleDraft): string[] {
  const out: string[] = [];
  if (!RULE_ID.test(d.id))
    out.push('The id must be domain.slug, lowercase (e.g. perf.n-plus-one).');
  if (d.languages.trim() === '') out.push('Name at least one language.');
  if ((d.layer === 'pack' || d.layer === 'hybrid') && d.engineRule.trim() === '') {
    out.push('A pack or hybrid rule needs the engine rule path.');
  }
  if ((d.layer === 'llm' || d.layer === 'hybrid') && d.checklistItem.trim() === '') {
    out.push('A model (llm) or hybrid rule needs a checklist question.');
  }
  if (d.trigger.trim() === '') out.push('Add code the rule must fire on.');
  if (d.clean.trim() === '') out.push('Add code the rule must NOT fire on.');
  return out;
}

/** The POST /rules body. Provenance author and date are stamped by the API. */
export function ruleBody(d: RuleDraft) {
  return {
    id: d.id,
    domain: d.domain,
    layer: d.layer,
    languages: d.languages
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean),
    severity: d.severity,
    status: 'proposed',
    provenance: { source: d.source, license: 'Apache-2.0' },
    ...(d.engineRule.trim() ? { engineRule: d.engineRule.trim() } : {}),
    ...(d.checklistItem.trim() ? { checklistItem: d.checklistItem.trim() } : {}),
    fixtures: { trigger: [d.trigger], clean: [d.clean] },
  };
}

const FIELD = 'panel px-2 py-1 text-sm';
const LABEL = 'flex flex-col gap-1 text-xs text-fg-muted';

export function ProposeRuleForm({ seed, onClose }: { seed?: RuleSeed; onClose?: () => void }) {
  const [draft, setDraft] = useState<RuleDraft>(() => draftFrom(seed));
  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const propose = useApiMutation<ReturnType<typeof ruleBody>, { rule_id: string; status: string }>(
    { endpoint: '/rules', method: 'POST' },
    { invalidate: [['/rules', {}, {}]] },
  );
  const problems = draftProblems(draft);

  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-border p-3"
      data-testid="propose-rule-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (problems.length === 0) propose.mutate(ruleBody(draft));
      }}
    >
      <p className="text-xs text-fg-muted">
        A proposed rule does not run. An admin accepts it to shadow, where its findings are measured
        and kept out of every score; it counts only once promoted, after at least 20 findings over
        30 days with under 20% marked false positive.
      </p>
      <div className="flex flex-wrap gap-2">
        <label className={LABEL}>
          Rule id
          <input
            className={`${FIELD} w-64 font-mono`}
            data-testid="propose-rule-id"
            value={draft.id}
            onChange={(e) => set('id', e.target.value)}
          />
        </label>
        <label className={LABEL}>
          Domain
          <select
            className={FIELD}
            data-testid="propose-rule-domain"
            value={draft.domain}
            onChange={(e) => set('domain', e.target.value as RuleDraft['domain'])}
          >
            {RULE_DOMAINS.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          Layer
          <select
            className={FIELD}
            data-testid="propose-rule-layer"
            value={draft.layer}
            onChange={(e) => set('layer', e.target.value as RuleDraft['layer'])}
          >
            <option value="llm">llm (a checklist question)</option>
            <option value="pack">pack (an engine rule)</option>
            <option value="hybrid">hybrid (both)</option>
          </select>
        </label>
        <label className={LABEL}>
          Languages (comma separated)
          <input
            className={FIELD}
            data-testid="propose-rule-languages"
            value={draft.languages}
            onChange={(e) => set('languages', e.target.value)}
          />
        </label>
        <label className={LABEL}>
          Severity
          <select
            className={FIELD}
            data-testid="propose-rule-severity"
            value={draft.severity}
            onChange={(e) => set('severity', Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      {draft.layer !== 'llm' && (
        <label className={LABEL}>
          Engine rule path
          <input
            className={`${FIELD} font-mono`}
            data-testid="propose-rule-engine"
            placeholder="rulepacks/code-health/my-rule.yaml#my-rule"
            value={draft.engineRule}
            onChange={(e) => set('engineRule', e.target.value)}
          />
        </label>
      )}
      {draft.layer !== 'pack' && (
        <label className={LABEL}>
          Checklist question
          <input
            className={FIELD}
            data-testid="propose-rule-checklist"
            value={draft.checklistItem}
            onChange={(e) => set('checklistItem', e.target.value)}
          />
        </label>
      )}
      <div className="grid gap-2 md:grid-cols-2">
        <label className={LABEL}>
          Must fire on
          <textarea
            className={`${FIELD} h-28 font-mono text-xs`}
            data-testid="propose-rule-trigger"
            value={draft.trigger}
            onChange={(e) => set('trigger', e.target.value)}
          />
        </label>
        <label className={LABEL}>
          Must NOT fire on
          <textarea
            className={`${FIELD} h-28 font-mono text-xs`}
            data-testid="propose-rule-clean"
            value={draft.clean}
            onChange={(e) => set('clean', e.target.value)}
          />
        </label>
      </div>
      {problems.length > 0 && (
        <ul className="text-xs text-fg-faint" data-testid="propose-rule-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="submit"
          className="rounded-md border border-accent bg-accent/10 px-2 py-1 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="propose-rule-submit"
          disabled={problems.length > 0 || propose.isPending}
          aria-busy={propose.isPending || undefined}
        >
          {propose.isPending ? 'Proposing…' : 'Propose rule'}
        </button>
        {onClose && (
          <button
            type="button"
            className="text-fg-muted underline underline-offset-2"
            onClick={onClose}
          >
            Cancel
          </button>
        )}
      </div>
      <ErrorNote error={propose.error} testId="propose-rule-error" />
      {propose.isSuccess && (
        <p className="text-xs" role="status" data-testid="propose-rule-done">
          Proposed <span className="font-mono">{propose.data.rule_id}</span>. It is listed under
          Settings → Rules as proposed and does not run until it is accepted to shadow.
        </p>
      )}
    </form>
  );
}
