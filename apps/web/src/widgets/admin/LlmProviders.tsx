import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ErrorNote, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';

// Admin → Models (W16-07, D-LLM-1).
//
// The screen the product did not have. Every LLM setting used to be an
// environment variable, so pointing RepoPulse at your own model meant editing a
// file on the host and restarting the container — for a standalone product
// whose premise is that you bring your own model, that was the largest gap the
// end-user review found (F5).
//
// Two things this screen is careful about:
//
//   The API KEY IS WRITE-ONLY. It is never sent to the browser, so an existing
//   provider shows a fingerprint and Test uses the key from the vault. A
//   settings screen that redisplays a secret is how one ends up in a screenshot.
//
//   TEST IS A REAL ROUND TRIP, and it reports the endpoint's own words. "Invalid
//   API key", "model not found" and a refused connection are three different
//   problems with three different fixes; collapsing them into "connection
//   failed" would make the button worthless.

const LIST = { endpoint: '/admin/llm-providers' } as const;
const KINDS = { endpoint: '/admin/llm-providers/kinds' } as const;
const ROUTING = { endpoint: '/admin/llm-routing' } as const;

const ROLE_WORD: Record<string, string> = {
  security: 'Security',
  performance: 'Performance',
  code_health: 'Code health',
  best_practices: 'Best practices',
  ai_slop: 'AI slop',
  test_coverage: 'Test coverage',
  triage: 'Triage',
  patch: 'Patch',
};

/** The roles whose routing chain names a connection, as words. */
export function rolesUsing(
  roles: readonly { role: string; chain: readonly { provider_id: number }[] }[],
  id: number,
): string[] {
  return roles
    .filter((r) => r.chain.some((l) => l.provider_id === id))
    .map((r) => ROLE_WORD[r.role] ?? r.role);
}

interface ProviderRow {
  id: number;
  name: string;
  kind: string;
  base_url: string | null;
  model: string;
  credential: string | null;
  headers: Record<string, string> | null;
  allow_public_host: boolean;
  enabled: boolean;
  capabilities: Capabilities | null;
  probed_at: string | null;
  /** Where it sends, and whether that leaves the network (IP addresses only count as home). */
  host?: string | null;
  leaves_network?: boolean;
  host_is_name?: boolean;
}

// W19-01: what the probe found. 'unknown' is shown as unknown, never as 'no'.
type Tri = 'yes' | 'no' | 'unknown';
interface Capabilities {
  contextWindow: number | null;
  streaming: Tri;
  jsonMode: Tri;
  toolUse: Tri;
  notes: string[];
  probedAt: string;
}

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
  auth_class: string;
  needs_base_url: boolean;
  supported: boolean;
  unsupported_reason: string | null;
  examples: string[];
  /** W19-08: the customer installs and operates this; never shown as a RepoPulse feature. */
  customer_supplied?: boolean;
  requires_acceptance?: boolean;
}

interface ClaudeCliInfo {
  statement: {
    version: string;
    sha256: string;
    title: string;
    points: { heading: string; text: string }[];
  };
  accepted: { by: string | null; at: string; version: string; current: boolean } | null;
  cli: {
    found: boolean;
    version: string | null;
    reportsLoggedIn: boolean | null;
    reason: string | null;
  };
  /**
   * W20-16 (UX_TODO AI-73): what the WORKER found — the container that runs
   * every pass. null when no worker has reported a check (an older worker,
   * or none running). Absent from an older API.
   */
  worker_cli?: {
    found: boolean;
    version: string | null;
    reportsLoggedIn: boolean | null;
    reason: string | null;
    checked_at: string;
  } | null;
}

/** "Found 2.1 (Claude Code); it reports being signed in" — one container's check. */
function cliSentence(
  where: string,
  c: {
    found: boolean;
    version: string | null;
    reportsLoggedIn: boolean | null;
    reason: string | null;
  },
): string {
  if (!c.found) return `${where}: ${c.reason ?? 'the Claude Code CLI was not found'}.`;
  const login =
    c.reportsLoggedIn === true
      ? 'it reports being signed in'
      : c.reportsLoggedIn === false
        ? 'it reports being signed out'
        : 'it did not say whether it is signed in';
  return `${where}: found ${c.version ?? 'the CLI'}; ${login}.`;
}

interface TestResult {
  ok: boolean;
  stage?: string;
  status?: number;
  detail?: string;
  /** W20-06 (UX_TODO AI-57): why a localhost test failed in a container, in plain words. */
  hint?: string;
  latency_ms?: number;
  model?: string;
  sample?: string;
  capabilities?: Capabilities;
  problems?: string[];
}

const TRI_MARK: Record<Tri, string> = { yes: '✓', no: '✗', unknown: '?' };

/** One line per capability, with the words next to the mark so colour is not the only signal. */
export function CapabilityList({ c }: { c: Capabilities }) {
  return (
    <div data-testid="capabilities">
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        <li>
          Context window:{' '}
          <strong>
            {c.contextWindow === null ? 'not published' : `${c.contextWindow} tokens`}
          </strong>
        </li>
        <li>
          Streaming:{' '}
          <strong>
            {TRI_MARK[c.streaming]} {c.streaming}
          </strong>
        </li>
        <li>
          JSON mode:{' '}
          <strong>
            {TRI_MARK[c.jsonMode]} {c.jsonMode}
          </strong>
        </li>
        <li>
          Tool use:{' '}
          <strong>
            {TRI_MARK[c.toolUse]} {c.toolUse}
          </strong>
        </li>
      </ul>
      {c.notes.map((n) => (
        <p key={n} className="mt-1 text-fg-muted">
          {n}
        </p>
      ))}
    </div>
  );
}

/**
 * A plain next step for a failed Test (W20-11, UX_TODO AI-21). The endpoint's
 * own words stay, in monospace, because they are what an operator searches
 * for; but "model crashed", "loading" or a refused key each have one obvious
 * thing to do, and the raw sentence did not say it. Null when nothing fits.
 */
export function testNextStep(r: { ok: boolean; status?: number; detail?: string }): string | null {
  if (r.ok) return null;
  const d = r.detail ?? '';
  if (/crash|exited unexpectedly|terminated/i.test(d)) {
    return 'The model crashed. In LM Studio, reload it (a smaller context length or model helps if it ran out of memory), wait for it to finish loading, and test again.';
  }
  if (/loading|not (yet )?loaded|no models? (are )?loaded/i.test(d)) {
    return 'The model may still be loading in LM Studio. Wait until it is ready, and test again.';
  }
  if (/reasoning/i.test(d)) {
    return 'The model used its whole answer on reasoning and gave no reply. Choose a model or setting with reasoning off or limited, and test again.';
  }
  if (
    r.status === 401 ||
    r.status === 403 ||
    /unauthori[sz]ed|invalid.*key|api key|permission/i.test(d)
  ) {
    return 'The key was refused. Check the API key (paste it again with Edit), and that it is allowed to use this model.';
  }
  if (
    r.status === 404 ||
    /model.*(not found|does not exist|unknown)|unknown model|no such model/i.test(d)
  ) {
    return 'The server does not know that model name. Copy the name exactly as the server lists it, and test again.';
  }
  if (r.status === 429 || /rate.?limit|quota/i.test(d)) {
    return 'The vendor is limiting this key (rate or quota). Wait a minute, or check the plan, and test again.';
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|timed? ?out|fetch failed|socket/i.test(d)) {
    return 'Nothing answered at that address. Check the server is running and reachable from the machine RepoPulse runs on, then test again.';
  }
  return null;
}

/** One test result, in the endpoint's own words. Shared by the form and each row. */
function TestResultNote({ result, testId }: { result: TestResult; testId: string }) {
  const next = testNextStep(result);
  return (
    <div
      className={`rounded-sm border px-2 py-1.5 text-xs ${
        result.ok ? 'border-ok/40 bg-ok/10' : 'border-crit/40 bg-crit/10'
      }`}
      data-testid={testId}
      role="status"
    >
      {result.ok ? (
        <>
          <strong>Reached it.</strong> {result.latency_ms}ms, answered as{' '}
          <code className="font-mono">{result.model}</code>
          {result.sample ? <> — “{result.sample}”</> : null}
        </>
      ) : (
        <>
          <strong>
            {result.stage === 'config'
              ? 'Configuration'
              : result.stage === 'transport'
                ? 'Could not connect'
                : `Endpoint replied ${result.status ?? ''}`}
            .
          </strong>{' '}
          {/* The endpoint's own words, not ours. */}
          <span className="font-mono">{result.detail}</span>
          {result.hint ? <span className="mt-1 block">{result.hint}</span> : null}
          {next ? (
            <span className="mt-1 block font-semibold" data-testid="test-next-step">
              What to do: {next}
            </span>
          ) : null}
        </>
      )}
      {result.capabilities ? (
        <div className="mt-2">
          <CapabilityList c={result.capabilities} />
          {(result.problems ?? []).map((pr) => (
            <p key={pr} className="mt-1 font-semibold text-crit" data-testid="capability-problem">
              {pr}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const CLAUDE_CLI = { endpoint: '/admin/llm-providers/claude-cli' } as const;

/**
 * The customer-supplied Claude Code CLI option (W19-08). Shown as what it is:
 * something the customer installs and signs in to themselves, off until an
 * admin has read the statement and accepted it. The statement comes from the
 * server - the text, its version and its hash - so what is accepted is exactly
 * what was displayed.
 */
export function ClaudeCliPanel({
  onAcceptedChange,
}: {
  onAcceptedChange: (accepted: boolean) => void;
}) {
  const info = useApiQuery<ClaudeCliInfo>(CLAUDE_CLI);
  const queryClient = useQueryClient();
  const [read, setRead] = useState(false);
  const accept = useApiMutation<Record<string, unknown>, { id: number }>(
    { endpoint: '/admin/llm-providers/claude-cli/accept', method: 'POST' },
    { invalidate: [queryKeyFor(CLAUDE_CLI)] },
  );
  const revoke = useApiMutation<Record<string, unknown>, unknown>(
    { endpoint: '/admin/llm-providers/claude-cli/revoke', method: 'POST' },
    { invalidate: [queryKeyFor(CLAUDE_CLI)] },
  );
  // W20-11 (UX_TODO AI-67): Switch off says which roles it stops, so it can
  // confirm with them. Shared query keys: no extra request.
  const providers = useApiQuery<{ items: ProviderRow[] }>(LIST);
  const routing = useApiQuery<{ roles: { role: string; chain: { provider_id: number }[] }[] }>(
    ROUTING,
  );
  const cliIds = (providers.data?.items ?? [])
    .filter((p) => p.kind === 'claude_cli')
    .map((p) => p.id);
  const cliRoles = [...new Set(cliIds.flatMap((id) => rolesUsing(routing.data?.roles ?? [], id)))];
  const [confirmOff, setConfirmOff] = useState(false);
  const [switchedOff, setSwitchedOff] = useState(false);
  const d = info.data;
  const on = d?.accepted?.current === true;
  useEffect(() => {
    onAcceptedChange(on);
  }, [on, onAcceptedChange]);

  if (info.isLoading || !d) return <p className="text-xs text-fg-muted">Loading…</p>;

  return (
    <section
      aria-labelledby="claude-cli-h"
      className="flex flex-col gap-2 rounded-sm border border-warn/40 bg-warn/10 p-3 text-xs"
      data-testid="claude-cli-panel"
    >
      <h3 id="claude-cli-h" className="text-sm font-semibold">
        {d.statement.title}
      </h3>
      <p>
        <strong>Customer-supplied.</strong> This runs a Claude Code CLI that <em>you</em> install
        and sign in to inside your own container. It is not a RepoPulse feature and it is off until
        an admin accepts the statement below.
      </p>
      <ol className="ml-4 list-decimal" data-testid="claude-cli-statement">
        {d.statement.points.map((p) => (
          <li key={p.heading}>
            <strong>{p.heading}</strong> {p.text}
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-0.5 text-fg-muted" data-testid="claude-cli-status">
        {/* W20-16 (UX_TODO AI-73): both containers, each named. The worker
            runs every pass; the API container runs this check and Test
            connection, and the overlay now gives it the same CLI volume. */}
        <p data-testid="claude-cli-status-worker">
          {d.worker_cli
            ? cliSentence('Worker container (runs every pass)', d.worker_cli)
            : 'Worker container (runs every pass): no check reported yet — the worker publishes one within a minute of starting.'}
        </p>
        <p data-testid="claude-cli-status-api">
          {cliSentence('API container (runs this check and Test connection)', d.cli)} Only Test
          connection proves a signed-in CLI actually answers.
        </p>
        {d.worker_cli && d.worker_cli.found !== d.cli.found && (
          <p className="text-warn" role="status" data-testid="claude-cli-status-mismatch">
            The two containers disagree. Start the stack with{' '}
            <code>deploy/up.sh --with-claude-cli</code> so both mount the CLI volume.
          </p>
        )}
      </div>
      {switchedOff && !on ? (
        <div
          role="status"
          className="rounded-sm border border-border p-2"
          data-testid="claude-cli-signout"
        >
          {/* W20-11 (UX_TODO AI-75): Switch off revokes the acceptance only. */}
          <strong>Switched off.</strong> RepoPulse no longer uses the CLI, but it is still installed
          and signed in inside the worker. To remove it: sign the CLI out inside the worker
          container, start RepoPulse without <code>compose.claude-cli.yaml</code>, and delete the{' '}
          <code>claude-cli</code> volume. INSTALL.md, &ldquo;Removing it&rdquo;, has the commands.
        </div>
      ) : null}
      {on ? (
        <div className="flex flex-col gap-2" data-testid="claude-cli-accepted">
          <div className="flex flex-wrap items-center gap-2">
            <span>
              ✓ Accepted by <strong>{d.accepted?.by ?? 'an admin'}</strong> on{' '}
              {d.accepted ? d.accepted.at.slice(0, 10) : ''} (statement {d.accepted?.version}).
            </span>
            <button
              type="button"
              data-testid="claude-cli-revoke"
              disabled={revoke.isPending}
              onClick={() => setConfirmOff(true)}
              className="underline"
            >
              Switch off…
            </button>
          </div>
          {confirmOff ? (
            <div
              className="flex flex-col gap-1 rounded-sm border border-warn/40 bg-warn/10 px-2 py-1.5"
              data-testid="claude-cli-revoke-confirm"
            >
              <p>
                Switch off the Claude Code CLI?{' '}
                {cliRoles.length === 0
                  ? 'No routing chain names a CLI connection.'
                  : `Every CLI connection stops serving ${cliRoles.length} role${cliRoles.length === 1 ? '' : 's'}: ${cliRoles.join(', ')}. Each moves to the next connection in its chain, and a role with no other connection refuses and says so.`}
              </p>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  data-testid="claude-cli-revoke-do"
                  disabled={revoke.isPending}
                  onClick={() =>
                    revoke.mutate(
                      {},
                      {
                        onSuccess: () => {
                          setConfirmOff(false);
                          setSwitchedOff(true);
                          void queryClient.invalidateQueries({ queryKey: queryKeyFor(CLAUDE_CLI) });
                        },
                      },
                    )
                  }
                  className="rounded-md border border-crit px-2 py-1 text-xs text-crit hover:bg-crit/10 disabled:opacity-50"
                >
                  {revoke.isPending ? 'Switching off…' : 'Switch off the CLI'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmOff(false)}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          <ErrorNote error={revoke.error} testId="claude-cli-revoke-error" />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {d.accepted && !d.accepted.current ? (
            <p role="status" className="font-semibold">
              The statement has changed since it was accepted. Read it again to continue.
            </p>
          ) : null}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              data-testid="claude-cli-read"
              checked={read}
              onChange={(e) => setRead(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I have read the statement above and I accept responsibility for using my plan this
              way.
            </span>
          </label>
          <div>
            <button
              type="button"
              data-testid="claude-cli-accept"
              disabled={!read || accept.isPending}
              onClick={() =>
                accept.mutate({
                  accept: true,
                  statement_version: d.statement.version,
                  statement_sha256: d.statement.sha256,
                })
              }
              className="rounded-sm border border-border bg-surface-2 px-3 py-1.5 text-sm text-fg disabled:opacity-50"
            >
              {accept.isPending ? 'Recording…' : 'Accept and turn on'}
            </button>
          </div>
          <ErrorNote error={accept.error} testId="claude-cli-error" />
        </div>
      )}
    </section>
  );
}

export function LlmProviders() {
  const list = useApiQuery<{ items: ProviderRow[] }>(LIST);
  const kindsQuery = useApiQuery<{ kinds: KindSpec[]; presets?: Preset[] }>(KINDS);
  const kinds = kindsQuery.data?.kinds ?? [];
  const presets = (kindsQuery.data as { presets?: Preset[] } | undefined)?.presets ?? [];

  const [kind, setKind] = useState('openai_compatible');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [allowPublic, setAllowPublic] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const spec = kinds.find((k) => k.kind === kind);
  const isCli = kind === 'claude_cli';
  const [cliAccepted, setCliAccepted] = useState(false);

  const create = useApiMutation<Record<string, unknown>, { id: number }>(
    { endpoint: '/admin/llm-providers', method: 'POST' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  // Which roles route to each connection, so Remove and Switch off can say what
  // they change (W20-06, UX_TODO AI-04).
  const routing = useApiQuery<{
    roles: { role: string; chain: { provider_id: number }[] }[];
  }>(ROUTING);
  const test = useApiMutation<Record<string, unknown>, TestResult>({
    endpoint: '/admin/llm-providers/test',
    method: 'POST',
  });

  function body(): Record<string, unknown> {
    return {
      name,
      kind,
      base_url: isCli ? null : baseUrl || null,
      model,
      // The CLI option holds no credential and has a fixed destination.
      api_key: isCli ? null : apiKey || null,
      allow_public_host: isCli ? false : allowPublic,
      // Ask the server to check the model can run a pass, and refuse it with a
      // sentence now if it cannot (W19-01).
      probe: true,
    };
  }

  const items = list.data?.items ?? [];

  // The by-hand form. The guided setup above it is the way in, so once a connection
  // exists this sits behind Advanced instead of repeating the wizard at full size.
  const modelsForm = (
    <WidgetFrame title="Models" state="ready">
      {/* W20-11 (UX_TODO AI-23): this named only OpenAI-compatible servers. */}
      <p className="text-xs text-fg-muted" data-testid="provider-form-intro">
        RepoPulse runs its analysis on a model you provide: a server speaking the OpenAI
        chat-completions API (Ollama, LM Studio, vLLM and llama.cpp locally, or OpenRouter, Groq,
        Together and OpenAI over the network), Google Gemini, Anthropic, Google Vertex AI, AWS
        Bedrock, or your own Claude Code CLI. The Provider list below shows which this server
        supports. The &ldquo;Set up a model&rdquo; guide above does the same, step by step.
      </p>

      <form
        className="mt-4 flex flex-col gap-3"
        data-testid="llm-provider-form"
        onSubmit={(e) => {
          e.preventDefault();
          setResult(null);
          create.mutate(body(), {
            onSuccess: () => {
              setName('');
              setBaseUrl('');
              setModel('');
              setApiKey('');
              setAllowPublic(false);
            },
          });
        }}
      >
        {presets.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="provider-presets">
            <span className="text-fg-muted">Start from:</span>
            {presets.map((pr) => (
              <button
                key={pr.id}
                type="button"
                data-testid={`preset-${pr.id}`}
                title={pr.note}
                onClick={() => {
                  setKind(pr.kind);
                  setBaseUrl(pr.baseUrl);
                  if (name === '') setName(pr.label);
                }}
                className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-fg"
              >
                {pr.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Name
            <input
              data-testid="provider-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Workstation Ollama"
              className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 text-sm text-fg"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Provider
            <select
              data-testid="provider-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 text-sm text-fg"
            >
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                  {k.supported ? '' : ' — not supported yet'}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Answered on the screen rather than on submit: a person choosing
              Vertex should learn why it is unavailable before filling the form. */}
        {spec && !spec.supported ? (
          <p
            className="rounded-sm border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs text-fg"
            data-testid="provider-unsupported"
          >
            {spec.unsupported_reason}
          </p>
        ) : null}

        {spec?.needs_base_url !== false ? (
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Base URL
            <input
              data-testid="provider-base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:11434/v1"
              className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 font-mono text-sm text-fg"
            />
            {spec?.examples?.length ? (
              <span className="text-fg-faint">e.g. {spec.examples.join(' · ')}</span>
            ) : null}
          </label>
        ) : null}

        {isCli ? <ClaudeCliPanel onAcceptedChange={setCliAccepted} /> : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Model
            <input
              data-testid="provider-model"
              required
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={isCli ? 'sonnet' : 'qwen3-coder'}
              className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 font-mono text-sm text-fg"
            />
            {/* The failure this prevents: a blank or guessed model is sent as
                  the identifier and the endpoint 400s every call, which reads as
                  "the model is not loaded" rather than "nobody chose one". */}
            <span className="text-fg-faint">
              Exactly as the endpoint names it — a guess produces a 400 on every call.
            </span>
          </label>

          {isCli ? (
            <p className="text-xs text-fg-muted" data-testid="claude-cli-no-key">
              No key or address to enter: the CLI keeps its own login, and nothing is stored here.
            </p>
          ) : (
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              {kind === 'vertex' ? 'Service-account key (JSON)' : 'API key'}
              <input
                data-testid="provider-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 text-sm text-fg"
              />
              <span className="text-fg-faint">
                {kind === 'vertex'
                  ? 'Paste the whole key file. Encrypted at rest and never shown again; only a short-lived access token is sent to Google.'
                  : 'Encrypted at rest and never shown again. A model on your own network needs none.'}
              </span>
            </label>
          )}
        </div>

        {isCli ? null : (
          <label className="flex items-start gap-2 text-xs text-fg">
            <input
              type="checkbox"
              data-testid="provider-allow-public"
              checked={allowPublic}
              onChange={(e) => setAllowPublic(e.target.checked)}
              className="mt-0.5"
            />
            {/* Deliberately awkward, and deliberately per-provider. Tier 2 sends
                DIFFS — the most sensitive thing the warehouse holds — so leaving
                your network with them is a decision worth making explicitly. */}
            <span>
              This endpoint is outside my network. Diffs, pull-request descriptions and file paths
              will be sent to it.
            </span>
          </label>
        )}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            data-testid="provider-save"
            disabled={create.isPending || spec?.supported === false || (isCli && !cliAccepted)}
            className="rounded-sm border border-border bg-accent-strong px-3 py-1.5 text-sm text-accent-fg disabled:opacity-50"
          >
            {create.isPending ? 'Saving…' : 'Add provider'}
          </button>
          <button
            type="button"
            data-testid="provider-test"
            disabled={test.isPending}
            onClick={() => {
              setResult(null);
              test.mutate(body(), { onSuccess: (r) => setResult(r) });
            }}
            className="rounded-sm border border-border bg-surface-2 px-3 py-1.5 text-sm text-fg disabled:opacity-50"
          >
            {test.isPending ? 'Testing…' : 'Test connection'}
          </button>
        </div>

        {/* W16-18: was error.message alone, so a 500 here left the person
              with nothing to quote and the operator nothing to grep. */}
        <ErrorNote error={create.error} testId="provider-error" />

        <ErrorNote error={test.error} testId="provider-test-error" />
        {result ? <TestResultNote result={result} testId="provider-test-result" /> : null}
      </form>
    </WidgetFrame>
  );

  return (
    <div className="flex flex-col gap-4" data-testid="llm-providers">
      {items.length > 0 ? (
        <details className="rounded-sm border border-border px-3 py-2" data-testid="llm-advanced">
          <summary className="cursor-pointer text-sm">
            Advanced: add a connection by hand (the setup above does the same)
          </summary>
          <div className="mt-3">{modelsForm}</div>
        </details>
      ) : (
        modelsForm
      )}

      <WidgetFrame
        title="Configured providers"
        state={frameState({
          isLoading: list.isLoading,
          isError: list.isError,
          isEmpty: list.data !== undefined && items.length === 0,
        })}
        {...(list.error ? { errorMessage: list.error.message } : {})}
        onRetry={() => void list.refetch()}
        emptyMessage="No model configured yet — analysis will skip and say so."
      >
        <table className="table-plain w-full text-sm" data-testid="provider-table">
          <caption className="sr-only">Configured LLM providers</caption>
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th scope="col">Name</th>
              <th scope="col">Endpoint</th>
              <th scope="col">Model</th>
              <th scope="col">Capabilities</th>
              <th scope="col">Key</th>
              <th scope="col">Off-network</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <ProviderTableRow
                key={p.id}
                p={p}
                routedRoles={rolesUsing(routing.data?.roles ?? [], p.id)}
              />
            ))}
          </tbody>
        </table>
      </WidgetFrame>
    </div>
  );
}

/**
 * One configured connection (W20-06, UX_TODO AI-01 to AI-04).
 *
 * Its own component so each row owns its Test result, its errors and its
 * confirmations. The row Test used to write into the by-hand form, which sits
 * folded behind Advanced once a connection exists, so pressing it looked like
 * nothing happened; a failed request showed nothing at all.
 */
function ProviderTableRow({ p, routedRoles }: { p: ProviderRow; routedRoles: string[] }) {
  const queryClient = useQueryClient();
  const one = { endpoint: '/admin/llm-providers/{id}', path: { id: p.id } } as const;
  const invalidate = { invalidate: [queryKeyFor(LIST), queryKeyFor(ROUTING)] };
  const test = useApiMutation<Record<string, unknown>, TestResult>({
    endpoint: '/admin/llm-providers/test',
    method: 'POST',
  });
  const remove = useApiMutation<undefined, unknown>({ ...one, method: 'DELETE' }, invalidate);
  const patch = useApiMutation<Record<string, unknown>, { routed_roles: string[] }>(
    { ...one, method: 'PATCH' },
    invalidate,
  );
  const [result, setResult] = useState<TestResult | null>(null);
  const [confirm, setConfirm] = useState<'remove' | 'off' | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [model, setModel] = useState(p.model);
  const [baseUrl, setBaseUrl] = useState(p.base_url ?? '');
  const [apiKey, setApiKey] = useState('');
  const isCli = p.kind === 'claude_cli';
  const cliInfo = useApiQuery<ClaudeCliInfo>(CLAUDE_CLI, { enabled: isCli });
  // A fixed-endpoint vendor (Gemini, Anthropic) has no address to edit.
  const hasAddress = !isCli && p.base_url !== null;
  const roleList = routedRoles.join(', ');

  const startEdit = () => {
    setName(p.name);
    setModel(p.model);
    setBaseUrl(p.base_url ?? '');
    setApiKey('');
    setEditing(true);
  };

  return (
    <>
      <tr className="border-t border-border align-top" data-testid={`provider-row-${p.id}`}>
        <td>
          {p.name}
          {p.kind === 'claude_cli' ? (
            <span
              className="block text-xs text-fg-muted"
              data-testid={`provider-customer-supplied-${p.id}`}
            >
              Claude Code CLI · customer-supplied
            </span>
          ) : null}
          {/* W20-11 (UX_TODO AI-67): the acceptance was visible only by picking
              the CLI in the Advanced form; a statement changed by an upgrade
              made the gateway skip this row while it looked normal here. */}
          {isCli && cliInfo.data ? (
            <span
              className={`block text-xs ${cliInfo.data.accepted?.current === true ? 'text-fg-muted' : 'font-semibold text-warn'}`}
              data-testid={`provider-cli-acceptance-${p.id}`}
            >
              {cliInfo.data.accepted?.current === true
                ? `Statement accepted by ${cliInfo.data.accepted.by ?? 'an admin'}`
                : cliInfo.data.accepted
                  ? '⚠ Needs re-acceptance: the statement changed, so this connection is not used. Open Advanced → Provider: Claude Code CLI.'
                  : '⚠ Not accepted: this connection is not used until an admin accepts the statement (Advanced → Provider: Claude Code CLI).'}
            </span>
          ) : null}
          {p.enabled ? null : (
            <span className="block text-xs text-fg-muted" data-testid={`provider-off-${p.id}`}>
              Switched off: not used by any role or pass
            </span>
          )}
        </td>
        <td className="font-mono text-xs">
          {p.kind === 'claude_cli' ? 'your Claude Code CLI' : (p.base_url ?? '—')}
          {p.host_is_name ? (
            <span
              className="mt-1 block font-sans text-fg-muted"
              data-testid={`provider-name-host-${p.id}`}
            >
              Reached by a host name, so it counts as leaving your network: its calls are audited
              and Local only refuses it. Use the machine&apos;s IP address to keep it on your
              network.
            </span>
          ) : null}
        </td>
        <td className="font-mono text-xs">{p.model}</td>
        <td className="text-xs" data-testid={`provider-capabilities-${p.id}`}>
          {p.capabilities ? (
            <CapabilityList c={p.capabilities} />
          ) : (
            <span className="text-fg-faint">not probed</span>
          )}
        </td>
        {/* A fingerprint, never the key. */}
        <td className="font-mono text-xs">
          {p.kind === 'claude_cli' ? 'the CLI keeps its own login' : (p.credential ?? 'none')}
        </td>
        {/* W20-06 (UX_TODO AI-86): where the endpoint IS, by the server's
            host rule, not the allow_public_host flag the form saved. */}
        <td data-testid={`provider-off-network-${p.id}`}>
          {(p.leaves_network ?? (p.allow_public_host || isCli)) ? '⚠ yes' : 'no'}
        </td>
        <td className="text-right whitespace-nowrap">
          <button
            type="button"
            data-testid={`provider-test-${p.id}`}
            disabled={test.isPending}
            onClick={() => {
              setResult(null);
              // By id: the key lives in the vault and the browser has never had it.
              test.mutate({ id: p.id, probe: true }, { onSuccess: (r) => setResult(r) });
            }}
            className="mr-2 underline disabled:opacity-50"
          >
            {test.isPending ? 'Testing…' : 'Test'}
          </button>
          <button
            type="button"
            data-testid={`provider-edit-${p.id}`}
            onClick={startEdit}
            className="mr-2 underline"
          >
            Edit
          </button>
          <button
            type="button"
            data-testid={`provider-toggle-${p.id}`}
            disabled={patch.isPending}
            onClick={() => {
              // Switching on changes no route; switching off can, so it asks.
              if (p.enabled) setConfirm('off');
              else patch.mutate({ enabled: true });
            }}
            className="mr-2 underline disabled:opacity-50"
          >
            {p.enabled ? 'Switch off' : 'Switch on'}
          </button>
          <button
            type="button"
            data-testid={`provider-delete-${p.id}`}
            onClick={() => setConfirm('remove')}
            className="underline"
          >
            Remove…
          </button>
        </td>
      </tr>
      {confirm || editing || result || test.error || remove.error || patch.error ? (
        <tr data-testid={`provider-row-detail-${p.id}`}>
          <td colSpan={7} className="pb-2">
            <div className="flex flex-col gap-2">
              {result ? (
                <TestResultNote result={result} testId={`provider-row-test-result-${p.id}`} />
              ) : null}
              <ErrorNote error={test.error} testId={`provider-row-test-error-${p.id}`} />

              {confirm ? (
                <div
                  className="flex flex-col gap-1 rounded-sm border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs"
                  data-testid={`provider-confirm-${p.id}`}
                >
                  <p>
                    {confirm === 'remove' ? (
                      <>
                        Remove <strong>{p.name}</strong>? This cannot be undone.{' '}
                      </>
                    ) : (
                      <>
                        Switch off <strong>{p.name}</strong>?{' '}
                      </>
                    )}
                    {routedRoles.length === 0
                      ? 'No routing chain names it; roles without a chain stop using it.'
                      : `${confirm === 'remove' ? 'It is removed from' : 'It stops serving'} ${routedRoles.length} role${routedRoles.length === 1 ? '' : 's'}: ${roleList}. Each moves to the next connection in its chain, and a role with no other connection refuses and says so.`}
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      data-testid={`provider-confirm-do-${p.id}`}
                      disabled={remove.isPending || patch.isPending}
                      onClick={() => {
                        const done = { onSuccess: () => setConfirm(null) };
                        if (confirm === 'remove') remove.mutate(undefined, done);
                        else patch.mutate({ enabled: false }, done);
                      }}
                      className="rounded-md border border-crit px-2 py-1 text-xs text-crit hover:bg-crit/10 disabled:opacity-50"
                    >
                      {confirm === 'remove' ? `Remove ${p.name}` : `Switch off ${p.name}`}
                    </button>
                    <button
                      type="button"
                      data-testid={`provider-confirm-cancel-${p.id}`}
                      onClick={() => setConfirm(null)}
                      className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              <ErrorNote error={remove.error} testId={`provider-remove-error-${p.id}`} />

              {editing ? (
                <form
                  className="flex flex-col gap-2 rounded-sm border border-border p-2 text-xs"
                  data-testid={`provider-edit-form-${p.id}`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    patch.mutate(
                      {
                        name,
                        model,
                        ...(hasAddress ? { base_url: baseUrl } : {}),
                        // Blank keeps the stored key; it is never shown.
                        ...(apiKey.trim() !== '' ? { api_key: apiKey } : {}),
                      },
                      {
                        onSuccess: () => {
                          setEditing(false);
                          setApiKey('');
                          void queryClient.invalidateQueries({ queryKey: queryKeyFor(LIST) });
                        },
                      },
                    );
                  }}
                >
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-fg-muted">
                      Name
                      <input
                        data-testid={`provider-edit-name-${p.id}`}
                        required
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-sm text-fg"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-fg-muted">
                      Model
                      <input
                        data-testid={`provider-edit-model-${p.id}`}
                        required
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        className="rounded-sm border border-border bg-surface-2 px-2 py-1 font-mono text-sm text-fg"
                      />
                    </label>
                    {hasAddress ? (
                      <label className="flex flex-col gap-1 text-fg-muted">
                        Address
                        <input
                          data-testid={`provider-edit-base-url-${p.id}`}
                          value={baseUrl}
                          onChange={(e) => setBaseUrl(e.target.value)}
                          className="rounded-sm border border-border bg-surface-2 px-2 py-1 font-mono text-sm text-fg"
                        />
                      </label>
                    ) : null}
                    {isCli ? null : (
                      <label className="flex flex-col gap-1 text-fg-muted">
                        New API key
                        <input
                          data-testid={`provider-edit-api-key-${p.id}`}
                          type="password"
                          autoComplete="off"
                          value={apiKey}
                          onChange={(e) => setApiKey(e.target.value)}
                          className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-sm text-fg"
                        />
                        <span className="text-fg-faint">Leave blank to keep the current key.</span>
                      </label>
                    )}
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      type="submit"
                      data-testid={`provider-edit-save-${p.id}`}
                      disabled={patch.isPending}
                      className="rounded-md border border-border bg-accent-strong px-2 py-1 text-xs text-accent-fg disabled:opacity-50"
                    >
                      {patch.isPending ? 'Saving…' : 'Save changes'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : null}
              {/* The server's own sentence: a public address without the opt-in,
                  a duplicate name, a model that cannot be resolved. */}
              <ErrorNote error={patch.error} testId={`provider-patch-error-${p.id}`} />
              {(patch.error as { detail?: string } | null)?.detail ? (
                <p className="text-xs text-crit" data-testid={`provider-patch-detail-${p.id}`}>
                  {(patch.error as { detail?: string }).detail}
                </p>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
