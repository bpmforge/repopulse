import { validateHostUrl, type HostAuth } from '../config/hosts.js';
import type { T2Host } from '../t2/client.js';

// Provider registry (W16-06, D-LLM-1).
//
// One place that knows what each provider KIND needs, so the answer to "can
// this deployment talk to Groq" is a table entry rather than a branch scattered
// across the gateway, the admin API and the UI.
//
// The shape follows what OpenCode does — a provider is an id, an adapter, an
// options bag and a model — without using its code. What makes that shape worth
// copying is that ONE adapter covers most of the field: Ollama, LM Studio,
// vLLM, llama.cpp, OpenRouter, Groq, Together, Fireworks, DeepSeek, Azure and
// OpenAI itself all speak `/v1/chat/completions`, which packages/analysis
// already speaks. The vendors that need their own entry need it because of
// AUTH, not because of the wire format.
//
// Auth classes, and why `kind` is not a boolean: an unsupported class must fail
// when someone CONFIGURES it, with a sentence naming what is missing, rather
// than at call time inside a scheduled pass nobody is watching.

export type LlmProviderKind =
  | 'openai_compatible'
  | 'anthropic'
  | 'gemini'
  | 'vertex'
  | 'bedrock'
  | 'copilot'
  | 'openai_subscription';

export type AuthClass = 'api_key' | 'none' | 'cloud_credentials' | 'oauth_device';

export interface ProviderSpec {
  kind: LlmProviderKind;
  label: string;
  authClass: AuthClass;
  /** False for vendors whose endpoint is fixed, so the UI hides the field. */
  needsBaseUrl: boolean;
  /** Anthropic authenticates with `x-api-key`, not a bearer token. */
  authHeader?: string;
  /** Filled in when the endpoint is fixed by the vendor. */
  defaultBaseUrl?: string;
  /** Implemented? W16-09 flips the remaining four. */
  supported: boolean;
  /** Shown in the UI when unsupported, so "why not" is answered on the screen. */
  unsupportedReason?: string;
  /** Examples, purely to make the form's Base URL field self-explanatory. */
  examples?: string[];
  /**
   * Path appended to the base URL for chat completions, for vendors whose
   * OpenAI-compatible surface is not at `/v1/chat/completions` (W19-01). When
   * set, the base URL is used verbatim, with no `/v1` normalisation.
   */
  chatPath?: string;
}

/** A one-click starting point for a local or self-hosted server (W19-01). */
export interface ProviderPreset {
  id: string;
  label: string;
  kind: LlmProviderKind;
  baseUrl: string;
  /** What the person must still do, in a sentence. */
  note: string;
}

/**
 * Starting points, not guarantees: the port is the server's usual default and
 * the person edits it if theirs differs. Every one of these is the same
 * adapter, which is the point — a preset is a URL, not an integration.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = Object.freeze([
  {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'openai_compatible',
    baseUrl: 'http://localhost:1234/v1',
    note: 'Start the local server in LM Studio (or `lms server start`) and load a model.',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'openai_compatible',
    baseUrl: 'http://localhost:11434/v1',
    note: 'Run `ollama serve`; the model id is the tag you pulled, e.g. `llama3.1:8b`.',
  },
  {
    id: 'mlx',
    label: 'MLX server (mlx_lm.server)',
    kind: 'openai_compatible',
    baseUrl: 'http://localhost:8080/v1',
    note: 'Run `mlx_lm.server --model <repo>`; the model id is the repo or path you passed.',
  },
  {
    id: 'unsloth',
    label: 'Unsloth (Studio / llama.cpp server)',
    kind: 'openai_compatible',
    baseUrl: 'http://localhost:8888/v1',
    note: 'Unsloth serves an OpenAI-compatible API; check the port it printed on start.',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    kind: 'openai_compatible',
    baseUrl: 'http://localhost:8000/v1',
    note: 'Run `vllm serve <model>`; the model id is the name you served.',
  },
  {
    id: 'litellm',
    label: 'LiteLLM proxy',
    kind: 'openai_compatible',
    baseUrl: 'http://localhost:4000/v1',
    note: 'Use a virtual key as the API key; the model id is a model_name from your LiteLLM config.',
  },
]);

export const PROVIDER_REGISTRY: Readonly<Record<LlmProviderKind, ProviderSpec>> = Object.freeze({
  openai_compatible: {
    kind: 'openai_compatible',
    label: 'OpenAI-compatible endpoint',
    authClass: 'api_key',
    needsBaseUrl: true,
    supported: true,
    // Deliberately spanning local and hosted: the point of this entry is that
    // the distinction is a URL and a key, not a different integration.
    examples: [
      'http://localhost:11434/v1 (Ollama)',
      'http://192.168.1.50:1234/v1 (LM Studio)',
      'http://localhost:8000/v1 (vLLM)',
      'https://openrouter.ai/api/v1',
      'https://api.groq.com/openai/v1',
      'https://api.openai.com/v1',
    ],
  },
  anthropic: {
    kind: 'anthropic',
    label: 'Anthropic (Claude API)',
    authClass: 'api_key',
    needsBaseUrl: false,
    authHeader: 'x-api-key',
    defaultBaseUrl: 'https://api.anthropic.com',
    supported: true,
  },
  gemini: {
    kind: 'gemini',
    label: 'Google Gemini (API key)',
    authClass: 'api_key',
    needsBaseUrl: false,
    // Google's own first-party OpenAI-compatible surface, so the key is the
    // ordinary bearer key from AI Studio. No local default: it is a hosted API.
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    chatPath: '/chat/completions',
    supported: true,
    examples: ['model id: gemini-2.5-flash'],
  },
  vertex: {
    kind: 'vertex',
    label: 'Google Vertex AI (service account)',
    authClass: 'cloud_credentials',
    needsBaseUrl: true,
    chatPath: '/chat/completions',
    supported: true,
    // The region and project are in the URL, so there is no single default.
    examples: [
      'https://us-central1-aiplatform.googleapis.com/v1/projects/PROJECT/locations/us-central1/endpoints/openapi',
      'model id: google/gemini-2.5-flash',
    ],
  },
  bedrock: {
    kind: 'bedrock',
    label: 'Amazon Bedrock',
    // API KEY, not cloud credentials (W16-09).
    //
    // This entry said `cloud_credentials` and "Bedrock signs each request with
    // the AWS credential chain (SigV4) rather than sending a key". That was
    // true when it was written and is not any more: AWS exposes an
    // OpenAI-compatible Chat Completions API on bedrock-runtime that accepts
    // EITHER SigV4 or an Amazon Bedrock API key as `Authorization: Bearer`
    //
    //   https://bedrock-runtime.{region}.amazonaws.com/openai/v1/chat/completions
    //
    // (verified against the AWS docs, Law 2). So Bedrock is base-URL-plus-key
    // after all, and rides the same transport as every other OpenAI-compatible
    // endpoint. Implementing SigV4 would be about a hundred lines of HMAC plus
    // a dependency decision, for no capability the key does not already give.
    //
    // The REGION is in the URL, so this needs a base URL rather than carrying
    // a default: there is no single Bedrock endpoint to default to.
    authClass: 'api_key',
    needsBaseUrl: true,
    supported: true,
    examples: [
      'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
      'https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1',
    ],
  },
  copilot: {
    kind: 'copilot',
    label: 'GitHub Copilot',
    authClass: 'oauth_device',
    needsBaseUrl: false,
    supported: false,
    unsupportedReason:
      'Copilot needs a browser OAuth device flow, not a key you can paste. Support is W16-09.',
  },
  openai_subscription: {
    kind: 'openai_subscription',
    label: 'OpenAI subscription plan (ChatGPT Plus / Pro)',
    authClass: 'oauth_device',
    needsBaseUrl: false,
    supported: false,
    unsupportedReason:
      'A subscription plan authenticates through a browser sign-in rather than an API key. Support is W16-09.',
  },
});

export const SUPPORTED_KINDS = Object.values(PROVIDER_REGISTRY)
  .filter((s) => s.supported)
  .map((s) => s.kind);

/** One configured provider, as the gateway needs it. */
export interface ProviderConfig {
  id: number;
  name: string;
  kind: LlmProviderKind;
  baseUrl: string | null;
  model: string;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  allowPublicHost: boolean;
}

export class ProviderConfigError extends Error {
  constructor(
    readonly providerName: string,
    reason: string,
  ) {
    super(`Provider "${providerName}": ${reason}`);
    this.name = 'ProviderConfigError';
  }
}

/**
 * Turns a stored provider row into a host the Tier-2 client can call.
 *
 * SC-24 IS ENFORCED HERE, not relaxed. `allowPublicHost` is a per-row decision
 * a human made and an author is recorded against; it is not reachable from a
 * request, which is what the control was always for. A row without it still
 * gets the private-range-only policy, so the default for a provider someone
 * added carelessly is the strict one.
 */
export function resolveProvider(config: ProviderConfig): T2Host {
  const spec = PROVIDER_REGISTRY[config.kind];
  if (!spec) throw new ProviderConfigError(config.name, `unknown kind "${config.kind}"`);
  if (!spec.supported)
    throw new ProviderConfigError(config.name, spec.unsupportedReason ?? 'not supported yet');

  const baseUrl = config.baseUrl ?? spec.defaultBaseUrl;
  if (!baseUrl) {
    throw new ProviderConfigError(config.name, 'no base URL, and this kind has no default');
  }
  if (config.model.trim() === '') {
    // The failure this prevents: a blank model is sent as the model identifier
    // and the endpoint answers 400 on every call, which reads as "the model is
    // not loaded" rather than "nobody chose one".
    throw new ProviderConfigError(
      config.name,
      'no model id — every endpoint rejects a request that does not name one',
    );
  }
  if (spec.authClass === 'api_key' && !config.apiKey && isRemote(baseUrl)) {
    throw new ProviderConfigError(
      config.name,
      'a hosted endpoint needs an API key; only a LAN or loopback model may go without one',
    );
  }

  // Throws HostPolicyError with its own sentence when the URL is not allowed.
  validateHostUrl(baseUrl, { allowPublicHosts: config.allowPublicHost, allowLoopback: true });

  const auth: HostAuth = {
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(spec.authHeader ? { authHeader: spec.authHeader } : {}),
    ...(config.headers ? { extra: config.headers } : {}),
  };

  return {
    baseUrl,
    modelSlot: config.model.trim(),
    providerId: config.id,
    ...(spec.chatPath ? { chatUrl: `${baseUrl.replace(/\/+$/, '')}${spec.chatPath}` } : {}),
    ...(config.apiKey || config.headers ? { auth } : {}),
  };
}

/** True when the URL is neither loopback nor a private-range LAN address. */
function isRemote(raw: string): boolean {
  try {
    validateHostUrl(raw, { allowPublicHosts: false, allowLoopback: true });
    return false;
  } catch {
    return true;
  }
}
