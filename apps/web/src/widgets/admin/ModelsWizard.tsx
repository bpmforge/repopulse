import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ErrorNote, WidgetFrame } from '../../components/index.js';
import { useApiMutation, useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import { CapabilityList, ClaudeCliPanel, ModelChoices, testNextStep } from './LlmProviders.js';
import {
  summarizeRole,
  TIER3_NOTE,
  WHAT_IS_SENT,
  type EgressLink,
  type EgressProvider,
} from './egress.js';

// Settings → Models → "Set up a model" (W19-07).
//
// Four steps that take a person from "I have a model somewhere" to "I know what
// leaves my network, per role": where it runs, connect and TEST it, choose
// which roles use it, and a review that says plainly what is sent where. It
// uses the same APIs as the full forms below it, so nothing here can do what
// those cannot - it is a path through them, not a second implementation.

const KINDS = { endpoint: '/admin/llm-providers/kinds' } as const;
const LIST = { endpoint: '/admin/llm-providers' } as const;
const ROUTING = { endpoint: '/admin/llm-routing' } as const;

type Where = 'local' | 'proxy' | 'hosted' | 'cli';

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
  examples?: string[];
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
  /** W20-06 (UX_TODO AI-57): the plain-words reason a localhost test failed in a container. */
  hint?: string;
  latency_ms?: number;
  model?: string;
  capabilities?: Parameters<typeof CapabilityList>[0]['c'];
  problems?: string[];
  /** W20-21 (UX_TODO AI-20): the server's model list, from /v1/models. */
  models?: string[];
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

/**
 * W20-11 (UX_TODO AI-17): the customer-supplied CLI was reachable only from
 * the Advanced form's Provider list, so the main path never showed it or its
 * responsibility statement. Offered only when this server supports it.
 */
const CLI_CHOICE = {
  id: 'cli' as const,
  title: 'My own Claude Code CLI (customer-supplied)',
  blurb:
    'A Claude Code CLI you install and sign in to yourself, in your own container. Not a RepoPulse feature: off until an admin accepts a statement.',
  leaves: `Anthropic receives ${WHAT_IS_SENT}, through your own plan. Every request is recorded in the egress audit.`,
};

// Listed in this order, Gemini first: the vendor dropdown opened on
// "OpenAI-compatible endpoint" while the Name placeholder said "Gemini"
// (W20-11, UX_TODO AI-19).
const HOSTED_KINDS = ['gemini', 'anthropic', 'openai_compatible', 'vertex', 'bedrock'];

/** Where to get a key, per vendor (W20-11, UX_TODO AI-19). */
const KEY_HELP: Record<string, { href: string; label: string } | undefined> = {
  gemini: { href: 'https://aistudio.google.com/apikey', label: 'Get a Gemini API key' },
  anthropic: {
    href: 'https://console.anthropic.com/settings/keys',
    label: 'Get an Anthropic API key',
  },
  vertex: {
    href: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    label: 'Create a service-account key',
  },
  bedrock: { href: 'https://console.aws.amazon.com/iam/', label: 'Create AWS access keys' },
};

const STEPS = ['Where it runs', 'Connect and test', 'Choose roles', 'Review'] as const;

const ALL_ROLES = Object.keys(ROLE_LABEL);

/**
 * W20-06 (UX_TODO AI-57): in a container, "localhost" is the container itself,
 * so a preset's localhost address cannot reach a model on the host machine. The
 * preset fills a placeholder the person replaces instead of an address that
 * fails with a raw ECONNREFUSED.
 */
export const MACHINE_IP = '<machine-ip>';
export function presetAddress(baseUrl: string, inContainer: boolean): string {
  return inContainer
    ? baseUrl.replace(/\/\/(localhost|127\.0\.0\.1)(?=[:/]|$)/, `//${MACHINE_IP}`)
    : baseUrl;
}

export function ModelsWizard() {
  const queryClient = useQueryClient();
  const kindsQuery = useApiQuery<{ kinds: KindSpec[]; presets?: Preset[]; in_container?: boolean }>(
    KINDS,
  );
  const routingQuery = useApiQuery<Routing>(ROUTING);
  const kinds = kindsQuery.data?.kinds ?? [];
  const presets = kindsQuery.data?.presets ?? [];
  const inContainer = kindsQuery.data?.in_container === true;

  const [step, setStep] = useState(0);
  const [assignError, setAssignError] = useState(false);
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
  const [picked, setPicked] = useState<Set<string>>(new Set(ALL_ROLES));
  const [saved, setSaved] = useState(false);
  const [presetNote, setPresetNote] = useState<string | null>(null);
  const addressField = useRef<HTMLInputElement>(null);

  // Move focus to the new step's heading, so a keyboard or screen-reader user
  // lands where the content changed instead of back at the top of the page.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const spec = kinds.find((k) => k.kind === kind);
  const hostedKinds = kinds
    .filter((k) => HOSTED_KINDS.includes(k.kind) && k.supported)
    .sort((a, b) => HOSTED_KINDS.indexOf(a.kind) - HOSTED_KINDS.indexOf(b.kind));
  const cliOffered = kinds.some((k) => k.kind === 'claude_cli' && k.supported);
  const whereChoices = cliOffered ? [...WHERE_CHOICES, CLI_CHOICE] : WHERE_CHOICES;
  const isCli = where === 'cli';
  const [cliAccepted, setCliAccepted] = useState(false);
  const onCliAccepted = useCallback((a: boolean) => setCliAccepted(a), []);
  const needsUrl = !isCli && (where !== 'hosted' || spec?.needs_base_url !== false);
  // A hosted vendor is outside the network by definition; the person must say so.
  const mustAcknowledge = where === 'hosted';

  // Why Test / Save are greyed out, said in words next to them.
  const saveBlockers = [
    ...(isCli && !cliAccepted ? ['accept the statement above to turn the CLI option on'] : []),
    ...(name.trim() === '' ? ['give the connection a name'] : []),
    ...(model.trim() === '' ? ['enter the model name'] : []),
    ...(mustAcknowledge && !outside
      ? ['tick the box above - sending code to a vendor is a decision, not a default']
      : []),
  ];
  const testBlocker = model.trim() === '' ? 'enter the model name' : null;

  const body = (): Record<string, unknown> => ({
    name,
    kind,
    base_url: needsUrl ? baseUrl || null : null,
    model,
    api_key: isCli ? null : apiKey || null,
    allow_public_host: mustAcknowledge || where === 'proxy' ? outside : false,
    probe: true,
  });
  // W20-11 (UX_TODO AI-18): Save worked without a passing Test, so a broken
  // endpoint could be saved and handed every role. A save is "tested" only when
  // the last Test passed for exactly these settings; otherwise it asks first.
  const settingsKey = JSON.stringify([kind, needsUrl ? baseUrl : '', model, apiKey, where]);
  const [testedKey, setTestedKey] = useState<string | null>(null);
  const testedOk = result?.ok === true && testedKey === settingsKey;
  const [confirmUntested, setConfirmUntested] = useState(false);

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
    setPresetNote(null);
    setConfirmUntested(false);
    setKind(
      w === 'hosted'
        ? (hostedKinds[0]?.kind ?? 'gemini')
        : w === 'cli'
          ? 'claude_cli'
          : 'openai_compatible',
    );
  };

  const save = () =>
    create.mutate(body(), {
      onSuccess: (r) => {
        setConfirmUntested(false);
        setCreatedId(r.id);
        setCreatedName(name);
        // W20-06 (UX_TODO AI-07): a model on your network starts
        // with every role; a vendor or gateway starts with none,
        // so a new key never becomes first choice for every kind
        // of analysis by default.
        setPicked(new Set(where === 'local' ? ALL_ROLES : []));
        setStep(2);
      },
    });

  async function assignRoles() {
    const current = routingQuery.data;
    if (!current) return;
    // W20-16 (UX_TODO AI-55): a create that returned no id used to make this
    // button do nothing at all. Say so, and where to finish by hand.
    if (createdId === null) {
      setAssignError(true);
      return;
    }
    setAssignError(false);
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
  // W20-06 (UX_TODO AI-06): the connection just added through "a gateway I run"
  // is known to be one, whatever its address; the review must not call it home.
  const gatewayIds = new Set<number>(where === 'proxy' && createdId !== null ? [createdId] : []);

  return (
    <WidgetFrame title="Set up a model" state="ready">
      <div className="flex flex-col gap-4" data-testid="models-wizard">
        <ol
          aria-label="Setup steps"
          className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
          data-testid="wizard-steps"
        >
          {STEPS.map((label, i) => {
            // W20-16 (UX_TODO AI-54): a finished step says "(done)" to a
            // screen reader, and can be gone back to - except the two steps
            // before the connection was saved, once it has been (going back
            // there would add a second connection, not edit this one).
            const done = i < step;
            const canGoBack = done && (createdId === null || i === 2);
            const text = (
              <>
                {i + 1}. {label}
                {done ? (
                  <>
                    <span aria-hidden="true"> ✓</span>
                    <span className="sr-only"> (done)</span>
                  </>
                ) : null}
              </>
            );
            return (
              <li
                key={label}
                {...(i === step ? { 'aria-current': 'step' as const } : {})}
                className={i === step ? 'font-semibold text-fg' : 'text-fg-muted'}
              >
                {canGoBack ? (
                  <button
                    type="button"
                    className="underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    data-testid={`wizard-step-${i}`}
                    onClick={() => setStep(i)}
                  >
                    {text}
                  </button>
                ) : (
                  text
                )}
              </li>
            );
          })}
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
              {whereChoices.map((c) => (
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
            {/* W20-06 (UX_TODO AI-58): said before anything is typed, not after
                the review contradicts itself. */}
            {localOnly && where !== 'local' ? (
              <p
                role="status"
                className="rounded-sm border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs text-fg"
                data-testid="wizard-local-only-warning"
              >
                <strong>Local only is on.</strong>{' '}
                {where === 'hosted'
                  ? 'A vendor is outside your network, so it will not be used until Local only is turned off in Routing below.'
                  : where === 'cli'
                    ? 'The Claude Code CLI sends code to Anthropic, so it will not be used until Local only is turned off in Routing below.'
                    : 'A gateway on a host name or a public address will not be used until Local only is turned off in Routing below.'}
              </p>
            ) : null}
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
                      const address = presetAddress(p.baseUrl, inContainer);
                      setBaseUrl(address);
                      if (name === '') setName(p.label);
                      // The note was only a tooltip, which touch and keyboard
                      // users never see (W20-06, UX_TODO AI-57).
                      setPresetNote(p.note);
                      // Land in the field so the machine's IP gets typed in.
                      if (address.includes(MACHINE_IP)) {
                        setTimeout(() => {
                          const el = addressField.current;
                          if (!el) return;
                          el.focus();
                          const at = address.indexOf(MACHINE_IP);
                          el.setSelectionRange(at, at + MACHINE_IP.length);
                        }, 0);
                      }
                    }}
                    className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-fg"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            ) : null}
            {/* Hidden once a test reached the server: "Start the local server" next
                to "Reached it" contradicted it (2026-10-27 walkthrough). */}
            {where === 'local' && presetNote && !testedOk ? (
              <p className="text-xs text-fg" data-testid="wizard-preset-note">
                <strong>Still to do:</strong> {presetNote}
                {baseUrl.includes(MACHINE_IP)
                  ? ` Replace ${MACHINE_IP} with the address of the machine the model runs on.`
                  : ''}
              </p>
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
                        : where === 'cli'
                          ? 'My Claude Code CLI'
                          : (spec?.label ?? 'Gemini')
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
                  ref={addressField}
                  data-testid="wizard-base-url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={
                    where === 'hosted'
                      ? (spec?.examples?.[0] ?? 'https://api.example.com/v1')
                      : where === 'proxy' || inContainer
                        ? 'http://192.168.1.60:4000/v1'
                        : 'http://localhost:1234/v1'
                  }
                  className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 font-mono text-sm text-fg"
                />
                {where === 'hosted' ? null : (
                  <span className="text-fg-faint" data-testid="wizard-address-hint">
                    Use the server&apos;s IP address, such as http://192.168.1.50:1234/v1. A model
                    on your network is reached by IP; host names are not accepted. If RepoPulse runs
                    in a container, &quot;localhost&quot; is the container itself - use the
                    machine&apos;s network address.
                  </span>
                )}
              </label>
            ) : null}

            {isCli ? <ClaudeCliPanel onAcceptedChange={onCliAccepted} /> : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                Model
                <input
                  data-testid="wizard-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={isCli ? 'sonnet' : 'exactly as the server names it'}
                  className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 font-mono text-sm text-fg"
                />
                <ModelChoices
                  models={result?.models}
                  current={model}
                  onPick={setModel}
                  testId="wizard-model-choices"
                />
              </label>
              {isCli ? (
                <p className="text-xs text-fg-muted" data-testid="wizard-cli-no-key">
                  No key or address to enter: the CLI keeps its own login, and nothing is stored
                  here.
                </p>
              ) : (
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
                  <span className="text-fg-faint">
                    Encrypted at rest and never shown again.
                    {where === 'hosted' && KEY_HELP[kind] ? (
                      <>
                        {' '}
                        <a
                          href={KEY_HELP[kind]!.href}
                          target="_blank"
                          rel="noreferrer"
                          className="underline underline-offset-2"
                          data-testid="wizard-key-help"
                        >
                          {KEY_HELP[kind]!.label}
                        </a>
                        .
                      </>
                    ) : where === 'hosted' ? (
                      " Create one in your vendor's dashboard."
                    ) : null}
                  </span>
                </label>
              )}
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
                aria-describedby={testBlocker ? 'wizard-test-hint' : undefined}
                disabled={test.isPending || model.trim() === ''}
                onClick={() => {
                  setResult(null);
                  setConfirmUntested(false);
                  const key = settingsKey;
                  test.mutate(
                    { ...body(), name: name || 'test' },
                    {
                      onSuccess: (r) => {
                        setResult(r);
                        setTestedKey(key);
                      },
                    },
                  );
                }}
                className="rounded-sm border border-border bg-surface-2 px-3 py-1.5 text-sm text-fg disabled:opacity-50"
              >
                {test.isPending ? 'Testing… this can take a minute' : 'Test connection'}
              </button>
              <button
                type="button"
                data-testid="wizard-save"
                aria-describedby={saveBlockers.length > 0 ? 'wizard-save-hint' : undefined}
                disabled={create.isPending || saveBlockers.length > 0}
                onClick={() => (testedOk ? save() : setConfirmUntested(true))}
                className="rounded-sm border border-border bg-accent-strong px-3 py-1.5 text-sm text-accent-fg disabled:opacity-50"
              >
                {create.isPending ? 'Saving…' : 'Save and continue'}
              </button>
              <button type="button" onClick={() => setStep(0)} className="text-sm underline">
                Back
              </button>
            </div>
            {confirmUntested ? (
              <div
                role="alert"
                className="flex flex-col gap-1 rounded-sm border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs"
                data-testid="wizard-confirm-untested"
              >
                <p>
                  <strong>Save without a successful test?</strong>{' '}
                  {result && !result.ok && testedKey === settingsKey
                    ? 'The last test of these settings failed, so every role you give it will fail too until it is fixed.'
                    : 'These settings have not passed Test connection, so nobody knows yet whether this model answers.'}
                </p>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    data-testid="wizard-save-anyway"
                    disabled={create.isPending}
                    onClick={save}
                    className="rounded-md border border-warn px-2 py-1 text-xs hover:bg-warn/10 disabled:opacity-50"
                  >
                    Save anyway
                  </button>
                  <button
                    type="button"
                    data-testid="wizard-confirm-cancel"
                    onClick={() => setConfirmUntested(false)}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
                  >
                    Go back and test
                  </button>
                </div>
              </div>
            ) : null}
            {/* Why a button is greyed out, in words, next to it (and tied to the buttons
                with aria-describedby): a disabled control that gives no reason reads
                as broken. */}
            {saveBlockers.length > 0 ? (
              <p
                id="wizard-save-hint"
                className="text-xs text-fg-muted"
                data-testid="wizard-save-hint"
              >
                To save: {saveBlockers.join('; ')}.
              </p>
            ) : null}
            {testBlocker ? (
              <p
                id="wizard-test-hint"
                className="text-xs text-fg-muted"
                data-testid="wizard-test-hint"
              >
                To test the connection: {testBlocker}.
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
                    {result.hint ? (
                      <span className="mt-1 block" data-testid="wizard-test-hint-localhost">
                        {result.hint}
                      </span>
                    ) : null}
                    {/* W20-11 (UX_TODO AI-21): the raw text stays; a plain step follows. */}
                    {testNextStep(result) ? (
                      <span
                        className="mt-1 block font-semibold"
                        data-testid="wizard-test-next-step"
                      >
                        What to do: {testNextStep(result)}
                      </span>
                    ) : null}
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
            {where !== 'local' ? (
              <p className="text-xs text-fg" data-testid="wizard-roles-none-ticked">
                Nothing is ticked yet: every role you tick sends {WHAT_IS_SENT} to{' '}
                {where === 'hosted' ? 'this vendor' : 'this gateway'}.{' '}
                <button
                  type="button"
                  data-testid="wizard-roles-all"
                  onClick={() => setPicked(new Set(ALL_ROLES))}
                  className="underline"
                >
                  Tick all roles
                </button>
              </p>
            ) : null}
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
                aria-describedby={!routingQuery.data ? 'wizard-assign-hint' : undefined}
                disabled={saveRouting.isPending || !routingQuery.data}
                onClick={() => void assignRoles()}
                className="rounded-sm border border-border bg-accent-strong px-3 py-1.5 text-sm text-accent-fg disabled:opacity-50"
              >
                {saveRouting.isPending ? 'Saving…' : 'Save and review'}
              </button>
              {assignError ? (
                <p
                  className="w-full text-xs text-crit"
                  role="alert"
                  data-testid="wizard-assign-noid"
                >
                  The connection was saved, but the server did not say which one it is, so its roles
                  cannot be set from here. Set them in the Routing section below: pick it as the
                  first choice for each role you want.
                </p>
              ) : null}
              <button
                type="button"
                data-testid="wizard-skip"
                onClick={() => setStep(3)}
                className="text-sm underline"
              >
                Skip - leave roles as they are
              </button>
            </div>
            {!routingQuery.data ? (
              <p
                id="wizard-assign-hint"
                className="text-xs text-fg-muted"
                data-testid="wizard-assign-hint"
              >
                Save is waiting for your current routing to load; you can skip this step.
              </p>
            ) : null}
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
                  const s = summarizeRole({ chain: r.chain, providers, localOnly, gatewayIds });
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
                            : s.tone === 'gateway'
                              ? '⚠ Through a gateway. '
                              : s.tone === 'leaves'
                                ? '⚠ Leaves. '
                                : '— Not used. '}
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
            {/* W20-11 (UX_TODO AI-68): the wizard ended without saying how AI
                review then actually runs on a repository. */}
            <div className="text-xs" data-testid="wizard-what-next">
              <h4 className="font-semibold">What next</h4>
              <ul className="mt-1 ml-4 list-disc text-fg-muted">
                <li>
                  Run a first AI review: open a repository from{' '}
                  <Link to="/repos" className="underline underline-offset-2">
                    Repositories
                  </Link>
                  , then <strong>Security → AI review pass</strong>, name the files and start it.
                  The same section can schedule passes.
                </li>
                <li>
                  See what has been sent off your network, per repository, in{' '}
                  <Link to="/admin/analysis" className="underline underline-offset-2">
                    Settings → Analysis
                  </Link>
                  .
                </li>
                <li>
                  Check how this model scores on each role in{' '}
                  <a href="#quality-per-model" className="underline underline-offset-2">
                    Quality per model
                  </a>
                  ; a model not measured yet shows how to measure it.
                </li>
              </ul>
            </div>
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
                  setPresetNote(null);
                  setTestedKey(null);
                  setConfirmUntested(false);
                  setPicked(new Set(ALL_ROLES));
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
