import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ErrorNote, WidgetFrame } from '../../components/index.js';
import { useApiMutation, useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import { CapabilityList } from './LlmProviders.js';
import {
  summarizeRole,
  TIER3_NOTE,
  WHAT_IS_SENT,
  type EgressLink,
  type EgressProvider,
} from './egress.js';

// Admin → Models → "Set up a model" (W19-07).
//
// Four steps that take a person from "I have a model somewhere" to "I know what
// leaves my network, per role": where it runs, connect and TEST it, choose
// which roles use it, and a review that says plainly what is sent where. It
// uses the same APIs as the full forms below it, so nothing here can do what
// those cannot - it is a path through them, not a second implementation.

const KINDS = { endpoint: '/admin/llm-providers/kinds' } as const;
const LIST = { endpoint: '/admin/llm-providers' } as const;
const ROUTING = { endpoint: '/admin/llm-routing' } as const;

type Where = 'local' | 'proxy' | 'hosted';

interface Preset {
  id: string;
  label: string;
  kind: string;
  baseUrl: string;
  note: string;
}
interface KindSpec {
  kind: string;
  label: string;
  needs_base_url: boolean;
  supported: boolean;
}
interface Routing {
  local_only: boolean;
  roles: { role: string; chain: (EgressLink & { model: string | null })[] }[];
  providers: EgressProvider[];
}
interface TestResult {
  ok: boolean;
  stage?: string;
  detail?: string;
  latency_ms?: number;
  model?: string;
  capabilities?: Parameters<typeof CapabilityList>[0]['c'];
  problems?: string[];
}

const ROLE_LABEL: Record<string, string> = {
  security: 'Security',
  performance: 'Performance',
  code_health: 'Code health',
  best_practices: 'Best practices',
  ai_slop: 'AI slop',
  test_coverage: 'Test coverage',
  triage: 'Triage',
  patch: 'Patch',
};

const WHERE_CHOICES: { id: Where; title: string; blurb: string; leaves: string }[] = [
  {
    id: 'local',
    title: 'On this machine or my network',
    blurb: 'LM Studio, Ollama, vLLM, MLX or Unsloth running where you control it.',
    leaves: 'Nothing leaves your network.',
  },
  {
    id: 'proxy',
    title: 'Through a gateway I run',
    blurb: 'A proxy such as LiteLLM that forwards to one or more models.',
    leaves: `The gateway receives ${WHAT_IS_SENT}. Wherever it forwards them, that place receives them too.`,
  },
  {
    id: 'hosted',
    title: "A vendor's API, with my key",
    blurb: 'Gemini, Anthropic, an OpenAI-compatible service, Vertex or Bedrock.',
    leaves: `The vendor receives ${WHAT_IS_SENT}. Every request is recorded in the egress audit.`,
  },
];

const HOSTED_KINDS = ['gemini', 'anthropic', 'openai_compatible', 'vertex', 'bedrock'];

const STEPS = ['Where it runs', 'Connect and test', 'Choose roles', 'Review'] as const;

export function ModelsWizard() {
  const queryClient = useQueryClient();
  const kindsQuery = useApiQuery<{ kinds: KindSpec[]; presets?: Preset[] }>(KINDS);
  const routingQuery = useApiQuery<Routing>(ROUTING);
  const kinds = kindsQuery.data?.kinds ?? [];
  const presets = kindsQuery.data?.presets ?? [];

  const [step, setStep] = useState(0);
  const [where, setWhere] = useState<Where>('local');
  const [kind, setKind] = useState('openai_compatible');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [outside, setOutside] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [createdName, setCreatedName] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set(Object.keys(ROLE_LABEL)));
  const [saved, setSaved] = useState(false);

  // Move focus to the new step's heading, so a keyboard or screen-reader user
  // lands where the content changed instead of back at the top of the page.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const spec = kinds.find((k) => k.kind === kind);
  const hostedKinds = kinds.filter((k) => HOSTED_KINDS.includes(k.kind) && k.supported);
  const needsUrl = where !== 'hosted' || spec?.needs_base_url !== false;
  // A hosted vendor is outside the network by definition; the person must say so.
  const mustAcknowledge = where === 'hosted';

  const body = (): Record<string, unknown> => ({
    name,
    kind,
    base_url: needsUrl ? baseUrl || null : null,
    model,
    api_key: apiKey || null,
    allow_public_host: mustAcknowledge || where === 'proxy' ? outside : false,
    probe: true,
  });

  const test = useApiMutation<Record<string, unknown>, TestResult>({
    endpoint: '/admin/llm-providers/test',
    method: 'POST',
  });
  const create = useApiMutation<Record<string, unknown>, { id: number | null }>(
    { endpoint: '/admin/llm-providers', method: 'POST' },
    { invalidate: [queryKeyFor(LIST), queryKeyFor(ROUTING)] },
  );
  const saveRouting = useApiMutation<Record<string, unknown>, unknown>(
    { endpoint: '/admin/llm-routing', method: 'PUT' },
    { invalidate: [queryKeyFor(ROUTING)] },
  );

  const choose = (w: Where) => {
    setWhere(w);
    setResult(null);
    setOutside(false);
    setKind(w === 'hosted' ? (hostedKinds[0]?.kind ?? 'gemini') : 'openai_compatible');
  };

  async function assignRoles() {
    const current = routingQuery.data;
    if (!current || createdId === null) return;
    const roles: Record<string, { provider_id: number; model: string | null }[]> = {};
    for (const r of current.roles) {
      const existing = r.chain.map((l) => ({ provider_id: l.provider_id, model: l.model }));
      // The new connection becomes the FIRST choice for the roles picked; what
      // was there stays behind it as fallbacks, so nothing is silently dropped.
      const chain = picked.has(r.role)
        ? [{ provider_id: createdId, model: null }, ...existing]
        : existing;
      if (chain.length > 0) roles[r.role] = chain;
    }
    saveRouting.mutate(
      { local_only: current.local_only, roles },
      {
        onSuccess: () => {
          setSaved(true);
          setStep(3);
        },
      },
    );
  }

  const providers = routingQuery.data?.providers ?? [];
  const localOnly = routingQuery.data?.local_only ?? false;

  return (
    <WidgetFrame title="Set up a model" state="ready">
      <div className="flex flex-col gap-4" data-testid="models-wizard">
        <ol
          aria-label="Setup steps"
          className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
          data-testid="wizard-steps"
        >
          {STEPS.map((label, i) => (
            <li
              key={label}
              {...(i === step ? { 'aria-current': 'step' as const } : {})}
              className={i === step ? 'font-semibold text-fg' : 'text-fg-muted'}
            >
              {i + 1}. {label}
              {i < step ? ' ✓' : ''}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <section aria-labelledby="wiz-h0" className="flex flex-col gap-3">
            <h3
              id="wiz-h0"
              ref={heading}
              tabIndex={-1}
              className="text-sm font-semibold outline-none"
            >
              Where does your model run?
            </h3>
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">Where the model runs</legend>
              {WHERE_CHOICES.map((c) => (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-start gap-2 rounded-sm border border-border p-3 text-sm"
                >
                  <input
                    type="radio"
                    name="wizard-where"
                    value={c.id}
                    data-testid={`wizard-where-${c.id}`}
                    checked={where === c.id}
                    onChange={() => choose(c.id)}
                    className="mt-1"
                  />
                  <span>
                    <strong>{c.title}</strong>
                    <span className="block text-xs text-fg-muted">{c.blurb}</span>
                    <span
                      className="mt-1 block text-xs text-fg"
                      data-testid={`wizard-leaves-${c.id}`}
                    >
                      <strong>What leaves your network:</strong> {c.leaves}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div>
              <button
                type="button"
                data-testid="wizard-next-0"
                onClick={() => setStep(1)}
                className="rounded-sm border border-border bg-accent-strong px-3 py-1.5 text-sm text-accent-fg"
              >
                Continue
              </button>
            </div>
          </section>
        )}

        {step === 1 && (
          <section aria-labelledby="wiz-h1" className="flex flex-col gap-3">
            <h3
              id="wiz-h1"
              ref={heading}
              tabIndex={-1}
              className="text-sm font-semibold outline-none"
            >
              Connect and test it
            </h3>

            {where === 'local' && presets.length > 0 ? (
              <div
                className="flex flex-wrap items-center gap-2 text-xs"
                role="group"
                aria-label="Local server presets"
              >
                <span className="text-fg-muted">Start from:</span>
                {presets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    data-testid={`wizard-preset-${p.id}`}
                    title={p.note}
                    onClick={() => {
                      setBaseUrl(p.baseUrl);
                      if (name === '') setName(p.label);
                    }}
                    className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-fg"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                Name
                <input
                  data-testid="wizard-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={
                    where === 'local'
                      ? 'Workstation LM Studio'
                      : where === 'proxy'
                        ? 'Team gateway'
                        : 'Gemini'
                  }
                  className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 text-sm text-fg"
                />
              </label>
              {where === 'hosted' ? (
                <label className="flex flex-col gap-1 text-xs text-fg-muted">
                  Vendor
                  <select
                    data-testid="wizard-kind"
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                    className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 text-sm text-fg"
                  >
                    {hostedKinds.map((k) => (
                      <option key={k.kind} value={k.kind}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>

            {needsUrl ? (
              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                Address
                <input
                  data-testid="wizard-base-url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={
                    where === 'proxy'
                      ? 'http://gateway.internal:4000/v1'
                      : 'http://localhost:1234/v1'
                  }
                  className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 font-mono text-sm text-fg"
                />
              </label>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                Model
                <input
                  data-testid="wizard-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="exactly as the server names it"
                  className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 font-mono text-sm text-fg"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                {kind === 'vertex'
                  ? 'Service-account key (JSON)'
                  : where === 'local'
                    ? 'API key (usually none)'
                    : 'API key'}
                <input
                  data-testid="wizard-api-key"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 text-sm text-fg"
                />
                <span className="text-fg-faint">Encrypted at rest and never shown again.</span>
              </label>
            </div>

            {mustAcknowledge || where === 'proxy' ? (
              <label className="flex items-start gap-2 text-xs text-fg">
                <input
                  type="checkbox"
                  data-testid="wizard-outside"
                  checked={outside}
                  onChange={(e) => setOutside(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  {where === 'hosted'
                    ? `I understand ${WHAT_IS_SENT} will be sent to this vendor.`
                    : `This gateway is outside my network. It will receive ${WHAT_IS_SENT}.`}
                </span>
              </label>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="wizard-test"
                disabled={test.isPending || model.trim() === ''}
                onClick={() => {
                  setResult(null);
                  test.mutate(
                    { ...body(), name: name || 'test' },
                    { onSuccess: (r) => setResult(r) },
                  );
                }}
                className="rounded-sm border border-border bg-surface-2 px-3 py-1.5 text-sm text-fg disabled:opacity-50"
              >
                {test.isPending ? 'Testing… this can take a minute' : 'Test connection'}
              </button>
              <button
                type="button"
                data-testid="wizard-save"
                disabled={
                  create.isPending ||
                  name.trim() === '' ||
                  model.trim() === '' ||
                  (mustAcknowledge && !outside)
                }
                onClick={() =>
                  create.mutate(body(), {
                    onSuccess: (r) => {
                      setCreatedId(r.id);
                      setCreatedName(name);
                      setStep(2);
                    },
                  })
                }
                className="rounded-sm border border-border bg-accent-strong px-3 py-1.5 text-sm text-accent-fg disabled:opacity-50"
              >
                {create.isPending ? 'Saving…' : 'Save and continue'}
              </button>
              <button type="button" onClick={() => setStep(0)} className="text-sm underline">
                Back
              </button>
            </div>
            {mustAcknowledge && !outside ? (
              <p className="text-xs text-fg-muted">
                Tick the box above to save: sending code to a vendor is a decision, not a default.
              </p>
            ) : null}

            <ErrorNote error={create.error} testId="wizard-error" />
            {(create.error as { detail?: string } | null)?.detail ? (
              <p className="text-xs text-crit" data-testid="wizard-error-detail">
                {(create.error as { detail?: string }).detail}
              </p>
            ) : null}
            <ErrorNote error={test.error} testId="wizard-test-error" />

            {result ? (
              <div
                role="status"
                data-testid="wizard-test-result"
                className={`rounded-sm border px-2 py-1.5 text-xs ${result.ok ? 'border-ok/40 bg-ok/10' : 'border-crit/40 bg-crit/10'}`}
              >
                {result.ok ? (
                  <>
                    <strong>Reached it.</strong> {result.latency_ms}ms, answered as{' '}
                    <code className="font-mono">{result.model}</code>.
                  </>
                ) : (
                  <>
                    <strong>
                      {result.stage === 'config'
                        ? 'Configuration'
                        : result.stage === 'transport'
                          ? 'Could not connect'
                          : 'The endpoint refused'}
                      .
                    </strong>{' '}
                    <span className="font-mono">{result.detail}</span>
                  </>
                )}
                {result.capabilities ? (
                  <div className="mt-2">
                    <CapabilityList c={result.capabilities} />
                    {(result.problems ?? []).map((p) => (
                      <p
                        key={p}
                        className="mt-1 font-semibold text-crit"
                        data-testid="wizard-problem"
                      >
                        {p}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        )}

        {step === 2 && (
          <section aria-labelledby="wiz-h2" className="flex flex-col gap-3">
            <h3
              id="wiz-h2"
              ref={heading}
              tabIndex={-1}
              className="text-sm font-semibold outline-none"
            >
              Which kinds of analysis should use {createdName ?? 'it'}?
            </h3>
            <p className="text-xs text-fg-muted">
              It becomes the first choice for the roles you tick; anything already set up stays
              behind it as a fallback. Roles you leave unticked are unchanged.
            </p>
            <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <legend className="sr-only">Roles</legend>
              {Object.entries(ROLE_LABEL).map(([role, label]) => (
                <label key={role} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid={`wizard-role-${role}`}
                    checked={picked.has(role)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(role);
                      else next.delete(role);
                      setPicked(next);
                    }}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="wizard-assign"
                disabled={saveRouting.isPending || !routingQuery.data}
                onClick={() => void assignRoles()}
                className="rounded-sm border border-border bg-accent-strong px-3 py-1.5 text-sm text-accent-fg disabled:opacity-50"
              >
                {saveRouting.isPending ? 'Saving…' : 'Save and review'}
              </button>
              <button
                type="button"
                data-testid="wizard-skip"
                onClick={() => setStep(3)}
                className="text-sm underline"
              >
                Skip - leave roles as they are
              </button>
            </div>
            <ErrorNote error={saveRouting.error} testId="wizard-routing-error" />
            {(saveRouting.error as { detail?: string } | null)?.detail ? (
              <p className="text-xs text-crit" data-testid="wizard-routing-detail">
                {(saveRouting.error as { detail?: string }).detail}
              </p>
            ) : null}
          </section>
        )}

        {step === 3 && (
          <section aria-labelledby="wiz-h3" className="flex flex-col gap-3">
            <h3
              id="wiz-h3"
              ref={heading}
              tabIndex={-1}
              className="text-sm font-semibold outline-none"
            >
              What leaves your network, role by role
            </h3>
            {saved ? (
              <p role="status" className="text-xs text-fg-muted" data-testid="wizard-saved">
                Saved. Changes apply within about a minute.
              </p>
            ) : null}
            {localOnly ? (
              <p className="text-xs text-fg-muted">
                Local only is on: nothing is sent outside your network.
              </p>
            ) : null}
            <table className="table-plain w-full text-sm" data-testid="wizard-review">
              <caption className="sr-only">What each role sends where</caption>
              <thead>
                <tr className="text-left text-xs text-fg-muted">
                  <th scope="col">Role</th>
                  <th scope="col">What happens to your code</th>
                </tr>
              </thead>
              <tbody>
                {(routingQuery.data?.roles ?? []).map((r) => {
                  const s = summarizeRole({ chain: r.chain, providers, localOnly });
                  return (
                    <tr
                      key={r.role}
                      className="border-t border-border align-top"
                      data-testid={`wizard-review-${r.role}`}
                    >
                      <th scope="row" className="py-2 pr-3 text-left font-normal">
                        {ROLE_LABEL[r.role] ?? r.role}
                      </th>
                      <td className="py-2 text-xs">
                        <span className="font-semibold">
                          {s.tone === 'stays'
                            ? '✓ Stays home. '
                            : s.tone === 'leaves'
                              ? '⚠ Leaves. '
                              : '— Not set up. '}
                        </span>
                        {s.text}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-xs text-fg-muted" data-testid="wizard-tier3">
              {TIER3_NOTE}
            </p>
            <p className="text-xs text-fg-muted">
              How good is each model at each role? See{' '}
              <a href="#quality-per-model" className="underline">
                quality per model
              </a>{' '}
              below.
            </p>
            <div>
              <button
                type="button"
                data-testid="wizard-done"
                onClick={() => {
                  setStep(0);
                  setResult(null);
                  setName('');
                  setBaseUrl('');
                  setModel('');
                  setApiKey('');
                  setOutside(false);
                  setSaved(false);
                  setCreatedId(null);
                  void queryClient.invalidateQueries({ queryKey: queryKeyFor(ROUTING) });
                }}
                className="rounded-sm border border-border bg-surface-2 px-3 py-1.5 text-sm text-fg"
              >
                Set up another
              </button>
            </div>
          </section>
        )}
      </div>
    </WidgetFrame>
  );
}
