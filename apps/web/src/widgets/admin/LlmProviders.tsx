import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { WidgetFrame, frameState } from '../../components/index.js';
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
}

interface KindSpec {
  kind: string;
  label: string;
  auth_class: string;
  needs_base_url: boolean;
  supported: boolean;
  unsupported_reason: string | null;
  examples: string[];
}

interface TestResult {
  ok: boolean;
  stage?: string;
  status?: number;
  detail?: string;
  latency_ms?: number;
  model?: string;
  sample?: string;
}

export function LlmProviders() {
  const list = useApiQuery<{ items: ProviderRow[] }>(LIST);
  const kindsQuery = useApiQuery<{ kinds: KindSpec[] }>(KINDS);
  const kinds = kindsQuery.data?.kinds ?? [];

  const [kind, setKind] = useState('openai_compatible');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [allowPublic, setAllowPublic] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const spec = kinds.find((k) => k.kind === kind);

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
      base_url: baseUrl || null,
      model,
      api_key: apiKey || null,
      allow_public_host: allowPublic,
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

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Model
              <input
                data-testid="provider-model"
                required
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="qwen3-coder"
                className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 font-mono text-sm text-fg"
              />
              {/* The failure this prevents: a blank or guessed model is sent as
                  the identifier and the endpoint 400s every call, which reads as
                  "the model is not loaded" rather than "nobody chose one". */}
              <span className="text-fg-faint">
                Exactly as the endpoint names it — a guess produces a 400 on every call.
              </span>
            </label>

            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              API key
              <input
                data-testid="provider-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 text-sm text-fg"
              />
              <span className="text-fg-faint">
                Encrypted at rest and never shown again. A model on your own network needs none.
              </span>
            </label>
          </div>

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

          <div className="flex items-center gap-2">
            <button
              type="submit"
              data-testid="provider-save"
              disabled={create.isPending || spec?.supported === false}
              className="rounded-sm border border-border bg-accent px-3 py-1.5 text-sm text-accent-fg disabled:opacity-50"
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

          {create.error ? (
            <p className="text-xs text-crit" data-testid="provider-error" role="alert">
              {create.error.message}
            </p>
          ) : null}

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
        <table className="w-full text-sm" data-testid="provider-table">
          <caption className="sr-only">Configured LLM providers</caption>
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th scope="col">Name</th>
              <th scope="col">Endpoint</th>
              <th scope="col">Model</th>
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
                <td>{p.name}</td>
                <td className="font-mono text-xs">{p.base_url ?? '—'}</td>
                <td className="font-mono text-xs">{p.model}</td>
                {/* A fingerprint, never the key. */}
                <td className="font-mono text-xs">{p.credential ?? 'none'}</td>
                <td>{p.allow_public_host ? '⚠ yes' : 'no'}</td>
                <td className="text-right">
                  <button
                    type="button"
                    data-testid={`provider-test-${p.id}`}
                    onClick={() => {
                      setResult(null);
                      // By id: the key lives in the vault and the browser has
                      // never had it.
                      test.mutate({ id: p.id }, { onSuccess: (r) => setResult(r) });
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
