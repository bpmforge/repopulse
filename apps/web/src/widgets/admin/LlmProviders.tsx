import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ErrorNote, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { apiFetch, buildUrl } from '../../api/client.js';

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
}

interface TestResult {
  ok: boolean;
  stage?: string;
  status?: number;
  detail?: string;
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

const CLAUDE_CLI = { endpoint: '/admin/llm-providers/claude-cli' } as const;

/**
 * The customer-supplied Claude Code CLI option (W19-08). Shown as what it is:
 * something the customer installs and signs in to themselves, off until an
 * admin has read the statement and accepted it. The statement comes from the
 * server - the text, its version and its hash - so what is accepted is exactly
 * what was displayed.
 */
function ClaudeCliPanel({ onAcceptedChange }: { onAcceptedChange: (accepted: boolean) => void }) {
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
      <p className="text-fg-muted" data-testid="claude-cli-status">
        {d.cli.found
          ? `Found ${d.cli.version ?? 'the CLI'} on this server. It ${d.cli.reportsLoggedIn === true ? 'reports being signed in (only Test connection proves it works)' : d.cli.reportsLoggedIn === false ? 'reports being signed out' : 'did not say whether it is signed in'}.`
          : (d.cli.reason ?? 'The Claude Code CLI was not found on this server.')}
      </p>
      {on ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="claude-cli-accepted">
          <span>
            ✓ Accepted by <strong>{d.accepted?.by ?? 'an admin'}</strong> on{' '}
            {d.accepted ? d.accepted.at.slice(0, 10) : ''} (statement {d.accepted?.version}).
          </span>
          <button
            type="button"
            data-testid="claude-cli-revoke"
            disabled={revoke.isPending}
            onClick={() =>
              revoke.mutate(
                {},
                {
                  onSuccess: () =>
                    void queryClient.invalidateQueries({ queryKey: queryKeyFor(CLAUDE_CLI) }),
                },
              )
            }
            className="underline"
          >
            Switch off
          </button>
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
  // Not useApiMutation: its descriptor is fixed when the hook is created, and
  // this needs the row's id in the PATH at call time.
  const queryClient = useQueryClient();
  const remove = useMutation<unknown, Error, number>({
    mutationFn: (id) =>
      apiFetch(buildUrl('/admin/llm-providers/{id}', { path: { id } }), { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeyFor(LIST) }),
  });
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

  return (
    <div className="flex flex-col gap-4" data-testid="llm-providers">
      <WidgetFrame title="Models" state="ready">
        <p className="text-xs text-fg-muted">
          RepoPulse runs its analysis on a model you provide. Anything speaking the OpenAI
          chat-completions API works — Ollama, LM Studio, vLLM and llama.cpp locally, or OpenRouter,
          Groq, Together and OpenAI itself over the network.
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
            <div
              className="flex flex-wrap items-center gap-2 text-xs"
              data-testid="provider-presets"
            >
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

          {result ? (
            <div
              className={`rounded-sm border px-2 py-1.5 text-xs ${
                result.ok ? 'border-ok/40 bg-ok/10' : 'border-crit/40 bg-crit/10'
              }`}
              data-testid="provider-test-result"
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
                </>
              )}
              {result.capabilities ? (
                <div className="mt-2">
                  <CapabilityList c={result.capabilities} />
                  {(result.problems ?? []).map((pr) => (
                    <p
                      key={pr}
                      className="mt-1 font-semibold text-crit"
                      data-testid="capability-problem"
                    >
                      {pr}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </form>
      </WidgetFrame>

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
              <tr
                key={p.id}
                className="border-t border-border"
                data-testid={`provider-row-${p.id}`}
              >
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
                </td>
                <td className="font-mono text-xs">
                  {p.kind === 'claude_cli' ? 'your Claude Code CLI' : (p.base_url ?? '—')}
                  {p.host_is_name ? (
                    <span
                      className="mt-1 block font-sans text-fg-muted"
                      data-testid={`provider-name-host-${p.id}`}
                    >
                      Reached by a host name, so it counts as leaving your network: its calls are
                      audited and Local only refuses it. Use the machine&apos;s IP address to keep
                      it on your network.
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
                  {p.kind === 'claude_cli'
                    ? 'the CLI keeps its own login'
                    : (p.credential ?? 'none')}
                </td>
                <td>{p.allow_public_host || p.kind === 'claude_cli' ? '⚠ yes' : 'no'}</td>
                <td className="text-right">
                  <button
                    type="button"
                    data-testid={`provider-test-${p.id}`}
                    onClick={() => {
                      setResult(null);
                      // By id: the key lives in the vault and the browser has
                      // never had it.
                      test.mutate({ id: p.id, probe: true }, { onSuccess: (r) => setResult(r) });
                    }}
                    className="mr-2 underline"
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    data-testid={`provider-delete-${p.id}`}
                    onClick={() => remove.mutate(p.id)}
                    className="underline"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </WidgetFrame>
    </div>
  );
}
