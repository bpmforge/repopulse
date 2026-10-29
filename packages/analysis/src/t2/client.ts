import type { CompleteOpts, CompleteResult } from '../gateway/types.js';
import { type HostSlots, SHARED_HOST_SLOTS } from './host-slots.js';
import { requestHeadersFor, type HostAuth } from '../config/hosts.js';

// Tier-2 LM Studio client (W6-01, ANALYSIS_TIERS.md §2, FR-ANALYSIS-2/NFR-8/C2).
//
// The three behaviours below exist because of how LM Studio actually fails, not
// because of how an API client usually looks:
//
//   45000 maxTokens on EVERY call — thinking models spend most of their budget
//   before emitting a token of answer, and a lower cap truncates the reasoning
//   rather than the output, producing confident nonsense.
//
//   Warm-up before a cold or previously-errored host — the first call after a
//   model load times out often enough that treating it as a failure would make
//   the first analysis of every session fail.
//
//   Crash-match retry — "model crashed" is a normal event on a loaded LAN host,
//   not an exception. Retrying without the warm-up in front just crashes again.

export const T2_MAX_TOKENS = 45000 as const;

/**
 * Normalizes a configured host to its ORIGIN.
 *
 * People write the base URL both ways, and .env in this repo already carries
 * `http://host:1234/v1`. Appending `/v1/chat/completions` to that produces
 * `/v1/v1/chat/completions` and a 404 that reads as "the model is not loaded"
 * — a wrong diagnosis for a URL problem. Accept either form.
 */
export function normalizeHost(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * The PROVIDER failed — unreachable, refused, rate-limited, 5xx, bad key
 * (W19-02). The only error a routing chain may fall back on: a model that
 * answered badly is not a provider error and is never retried elsewhere.
 */
export class ProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderError';
  }
}

/**
 * The model took longer than the request timeout (W22-03). Thrown as the abort
 * reason, so it surfaces as itself mid-stream and as a ProviderError's cause
 * before the headers arrive. A per-call failure, not a broken host: one slow
 * review must not discard the reviews that finished around it.
 */
export class ModelTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelTimeoutError';
  }
}

export interface T2Host {
  baseUrl: string;
  /** The connection's label, for sentences that name it (W19-02). */
  name?: string | undefined;
  /**
   * How the host is called (W19-08). Absent means HTTP chat-completions, which
   * is every provider but the customer-supplied Claude Code CLI.
   */
  transport?: 'claude_cli' | undefined;
  /** Sampling seed sent with every request when set (W19-05 evals); providers may ignore it. */
  seed?: number | undefined;
  /** Context window recorded by the capability probe (W19-01); undefined = never probed or unpublished. */
  contextWindow?: number | undefined;
  modelSlot: string;
  /**
   * Credential and extra headers for a hosted provider (W16-06). Absent for a
   * LAN model, which is still the default and still sends nothing.
   */
  auth?: HostAuth | undefined;
  /** The provider row this host came from, for the egress audit. */
  providerId?: number | undefined;
  /**
   * Full chat-completions URL, for the vendors whose OpenAI-compatible surface
   * does not live at `<origin>/v1/chat/completions` (Gemini, Vertex — W19-01).
   * Absent for everything else, which keeps the derived `/v1` path.
   */
  chatUrl?: string | undefined;
}

export function chatCompletionsUrl(host: T2Host): string {
  return host.chatUrl ?? `${normalizeHost(host.baseUrl)}/v1/chat/completions`;
}

export interface T2Config {
  hosts: T2Host[];
  warmup: { pingPrompt: string; timeoutMs: number; retries: number };
  crashRetry: { matches: string[]; attempts: number; backoffMs: number[] };
  /** Per host (FR-ANALYSIS-8). */
  concurrencyCap: number;
  /**
   * Wall-clock budget for one completion (W16-39).
   *
   * REQUIRED BECAUSE STREAMING REMOVED THE ACCIDENTAL ONE. Before this client
   * streamed, undici's 300-second headersTimeout bounded every call — badly,
   * killing legitimate slow generations, which is the bug streaming fixed. But
   * replacing a too-short timeout with NO timeout is not an improvement: a
   * stalled stream would then hang for ever, and the scan_run would sit at
   * 'running' until someone noticed.
   *
   * Generous rather than tight. A checklist chunk against a 27B reasoning
   * model on a contended LAN host legitimately takes many minutes — measured
   * here at over twelve — so anything under that would recreate the original
   * failure with a different number on it.
   */
  requestTimeoutMs: number;
  /**
   * How long a call may wait for its turn on a host that other analysis in
   * this process is using (see host-slots.ts). The request timeout above
   * starts only once the call is sent.
   */
  queueTimeoutMs: number;
}

export const T2_DEFAULTS: Omit<T2Config, 'hosts'> = {
  warmup: { pingPrompt: 'ping', timeoutMs: 15_000, retries: 2 },
  crashRetry: {
    matches: ['model crashed', 'ECONNRESET', 'model_not_loaded'],
    attempts: 3,
    backoffMs: [5_000, 15_000, 60_000],
  },
  concurrencyCap: 1,
  // 20 minutes. Long enough for a big reasoning model on a contended host —
  // twelve was measured here and did not finish — and short enough that a
  // stalled stream is reported the same day it stalls. Overridable per
  // deployment because "a slow model" is a property of someone's hardware.
  requestTimeoutMs: Number(process.env.LMSTUDIO_REQUEST_TIMEOUT_MS ?? 20 * 60 * 1000),
  // 60 minutes: three 20-minute calls ahead of you is a busy host, not a hung one.
  queueTimeoutMs: Number(process.env.LMSTUDIO_QUEUE_TIMEOUT_MS ?? 60 * 60 * 1000),
};

export interface T2Deps {
  /** Injectable transport so tests can drive crash paths deterministically. */
  fetchImpl?: typeof fetch;
  /** Injectable so backoff tests do not actually wait 80 seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-host call slots; defaults to the process-wide table (host-slots.ts). */
  slots?: HostSlots;
  /**
   * Background work (the AI judge): every call waits behind any other
   * analysis waiting for the same host (host-slots.ts), so scans that need the
   * model are not starved or failed by it.
   */
  background?: boolean;
}

interface ChatResponse {
  choices?: {
    message?: {
      content?: string;
      /**
       * Where a REASONING model puts its thinking (W16-38).
       *
       * LM Studio, Ollama and the hosted OpenAI-compatible endpoints all
       * return it alongside `content` for models like qwen3.8 and the gpt-oss
       * family. It is never the answer — read only to tell a model that
       * thought and never concluded from one that returned nothing at all.
       */
      reasoning_content?: string;
    };
    /** `stop` when the model finished, `length` when it hit the cap. */
    finish_reason?: string;
  }[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * A reasoning model that spent its whole budget thinking (W16-38).
 *
 * The header note above already says why the cap is 45000: "thinking models
 * spend most of their budget before emitting a token of answer". What it did
 * not say is what that looks like from here — `content` comes back EMPTY, and
 * an empty string is indistinguishable from a model that answered "nothing".
 *
 * Downstream that is worse than it sounds: the OWASP runner does
 * `JSON.parse(result.text)`, the SyntaxError is caught, and the chunk is
 * counted as one rejected finding. So a model that ran out of room to answer
 * shows up as a checklist that reviewed the code and found it clean.
 *
 * Named here instead, because "the model never answered" and "the model found
 * nothing" are different facts and only one of them is about the model's
 * configuration.
 */
export function noAnswerReason(choice: {
  message?: { content?: string; reasoning_content?: string };
  finish_reason?: string;
}): string | null {
  if ((choice.message?.content ?? '').trim() !== '') return null;
  const thought = (choice.message?.reasoning_content ?? '').trim() !== '';
  if (choice.finish_reason === 'length') {
    return thought
      ? 'the model used its entire token budget on reasoning and never produced an answer — raise the cap or use a non-reasoning model'
      : 'the model hit its token cap before producing any output';
  }
  if (thought) {
    return 'the model produced reasoning but no answer — its output went to reasoning_content and left content empty';
  }
  return null;
}

/**
 * Assembles an SSE chat stream into the same shape a non-streamed reply has
 * (W16-39), so nothing above this function needs to know which it got.
 *
 * `reasoning_content` is accumulated separately rather than folded into the
 * answer: it is how W16-38 tells a model that thought and never concluded from
 * one that returned nothing, and concatenating the two would destroy that
 * distinction and feed a model's thinking to a JSON parser.
 *
 * A malformed data line is SKIPPED rather than thrown on. These streams end
 * with `[DONE]` and can carry keep-alive comments; failing the whole call
 * because one frame did not parse would turn a cosmetic difference between
 * servers into a lost scan.
 */
export async function readChatStream(body: ReadableStream<Uint8Array>): Promise<ChatResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let content = '';
  let reasoning = '';
  let finishReason: string | undefined;
  let model: string | undefined;
  let usage: ChatResponse['usage'];

  const consume = (line: string): void => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '' || data === '[DONE]') return;
    let frame: StreamFrame;
    try {
      frame = JSON.parse(data) as StreamFrame;
    } catch {
      return;
    }
    model ??= frame.model;
    if (frame.usage) usage = frame.usage;
    const choice = frame.choices?.[0];
    if (choice?.delta?.content) content += choice.delta.content;
    if (choice?.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split('\n');
    // The last element is a partial line until the next chunk completes it.
    buffered = lines.pop() ?? '';
    for (const line of lines) consume(line);
  }
  consume(buffered);

  return {
    choices: [
      {
        message: {
          content,
          ...(reasoning !== '' ? { reasoning_content: reasoning } : {}),
        },
        ...(finishReason !== undefined ? { finish_reason: finishReason } : {}),
      },
    ],
    ...(model !== undefined ? { model } : {}),
    ...(usage ? { usage } : {}),
  };
}

interface StreamFrame {
  model?: string;
  usage?: ChatResponse['usage'];
  choices?: {
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string;
  }[];
}

/**
 * A transport failure with its CAUSE, which Node's fetch hides (W16-39).
 *
 * `fetch failed` is undici's outer wrapper and says nothing on its own — the
 * reason is on `error.cause`, and every layer above here reads `.message`. So
 * a checklist that timed out against a slow model recorded exactly "fetch
 * failed" on the scan_run, and the screen showed that, and it was
 * indistinguishable from a host that was down.
 *
 * Same shape of fix as the sandbox's discarded stderr (W16-37): the reason had
 * been captured all along and thrown away at the one point a person needed it.
 */
export function describeTransportError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts: string[] = [error.message];
  let cause: unknown = (error as { cause?: unknown }).cause;
  // A chain, because undici nests: fetch failed -> the socket error -> errno.
  for (let depth = 0; depth < 3 && cause instanceof Error; depth++) {
    const code = (cause as { code?: string }).code;
    parts.push(code ? `${cause.message} (${code})` : cause.message);
    cause = (cause as { cause?: unknown }).cause;
  }
  return parts.join(': ');
}

function isCrash(error: unknown, matches: string[]): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return matches.some((m) => text.toLowerCase().includes(m.toLowerCase()));
}

export class T2Client {
  /** Hosts that have completed a call since the last error — no warm-up needed. */
  private readonly warm = new Set<string>();
  private readonly inFlight = new Map<string, number>();

  constructor(
    private readonly config: T2Config,
    private readonly deps: T2Deps = {},
  ) {}

  private get fetchImpl(): typeof fetch {
    return this.deps.fetchImpl ?? globalThis.fetch;
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Least-loaded host under the cap, or null when every host is saturated.
   *
   * Returning null rather than queueing internally keeps the decision where it
   * belongs: the scheduler parks the job and retries, so a saturated LAN never
   * turns into an unbounded in-process queue nobody can see.
   */
  pickHost(): T2Host | null {
    const candidates = this.config.hosts
      .map((h) => ({ host: h, load: this.inFlight.get(h.baseUrl) ?? 0 }))
      .filter((c) => c.load < this.config.concurrencyCap)
      .sort((a, b) => a.load - b.load);
    return candidates[0]?.host ?? null;
  }

  /**
   * Runs `fn` while counting it against the host's concurrency cap. For
   * transports that are not HTTP chat-completions (the CLI), which still must
   * not exceed the cap or share a machine more than the operator allowed.
   */
  async track<T>(host: T2Host, fn: () => Promise<T>): Promise<T> {
    this.inFlight.set(host.baseUrl, (this.inFlight.get(host.baseUrl) ?? 0) + 1);
    let release: (() => void) | undefined;
    try {
      release = await this.acquireSlot(host);
      return await fn();
    } finally {
      release?.();
      this.inFlight.set(host.baseUrl, Math.max(0, (this.inFlight.get(host.baseUrl) ?? 1) - 1));
    }
  }

  /** Waits for this host's turn across every client in the process. */
  private acquireSlot(host: T2Host): Promise<() => void> {
    const slots = this.deps.slots ?? SHARED_HOST_SLOTS;
    return slots.acquire(host.baseUrl, this.config.concurrencyCap, this.config.queueTimeoutMs, {
      background: this.deps.background ?? false,
    });
  }

  /** True when this host is under the concurrency cap (used by routing chains). */
  hasCapacity(host: T2Host): boolean {
    return (this.inFlight.get(host.baseUrl) ?? 0) < this.config.concurrencyCap;
  }

  private async chat(
    host: T2Host,
    prompt: string,
    maxTokens: number,
    timeoutMs?: number,
  ): Promise<ChatResponse> {
    const controller = new AbortController();
    // The reason travels with the abort, so the scan_run says "the model did
    // not finish in 20 minutes" rather than the bare "This operation was
    // aborted" that an argument-less abort() produces (W16-39).
    const timer = timeoutMs
      ? setTimeout(
          () =>
            controller.abort(
              new ModelTimeoutError(
                `the model did not finish within ${Math.round(timeoutMs / 1000)}s — it may be ` +
                  'loaded on a busy host, or the prompt may be too large for it',
              ),
            ),
          timeoutMs,
        )
      : undefined;
    try {
      const res = await this.fetchWithCause(chatCompletionsUrl(host), {
        method: 'POST',
        // SC-24: credential-free unless a stored provider row carries a key.
        // Nothing user-supplied at call time can introduce a header — that,
        // rather than the frozen constant, was always the real control.
        headers: requestHeadersFor(host.auth),
        body: JSON.stringify({
          model: host.modelSlot,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.1,
          ...(host.seed !== undefined ? { seed: host.seed } : {}),
          // STREAMED, and not for latency (W16-39).
          //
          // Non-streaming, the endpoint sends no response headers until the
          // whole generation is done — and undici's default headersTimeout is
          // 300 seconds. A 27B reasoning model on this tier's 45000-token
          // budget takes longer than that, so the connection was killed before
          // the first byte and every checklist recorded `fetch failed`.
          // Measured: UND_ERR_HEADERS_TIMEOUT at 301.0s, reproducibly.
          //
          // Streaming makes headers arrive immediately (measured: 0.04s), so
          // that timeout can no longer fire at all. It removes the failure
          // class rather than moving the number, which is why it beats raising
          // a timeout — and it needs no new dependency, whereas configuring
          // undici's dispatcher would mean adding undici itself.
          stream: true,
          // Token accounting survives streaming only if asked for: without
          // this the final chunk carries no `usage` and FR-SEC-7's spend rows
          // would all read zero. Verified against LM Studio, which returns it.
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // The body carries LM Studio's own reason ("model crashed"), which the
        // crash matcher needs — a bare status code would lose it.
        // The body carries the provider's own reason, which the crash matcher
        // needs — a bare status code would lose it. Named generically since
        // W16-06: this client now speaks to any OpenAI-compatible endpoint.
        throw new ProviderError(
          `Model host responded ${res.status}: ${(await res.text()).slice(0, 300)}`,
        );
      }
      // BOTH SHAPES, on purpose. A provider that ignores `stream: true` answers
      // with an ordinary JSON body, and breaking on that would trade one
      // vendor's timeout for another's incompatibility. The content type is
      // the signal the servers themselves use.
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream') || !res.body) {
        return (await res.json()) as ChatResponse;
      }
      return await readChatStream(res.body);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * `fetch`, with the transport's real reason attached (W16-39).
   *
   * Rethrown rather than logged, because the message is what reaches the
   * scan_run row and therefore the screen. The original is kept as the cause
   * so nothing downstream loses it.
   */
  private async fetchWithCause(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      throw new ProviderError(describeTransportError(error), { cause: error });
    }
  }

  /** Warm-up ping. Failure is not fatal — the real call is still attempted. */
  async warmUp(host: T2Host): Promise<boolean> {
    for (let attempt = 0; attempt <= this.config.warmup.retries; attempt++) {
      try {
        await this.chat(host, this.config.warmup.pingPrompt, 8, this.config.warmup.timeoutMs);
        this.warm.add(host.baseUrl);
        return true;
      } catch {
        /* try again; the point of a warm-up is that it may fail while loading */
      }
    }
    return false;
  }

  async complete(prompt: string, opts: CompleteOpts, host: T2Host): Promise<CompleteResult> {
    const started = Date.now();
    const load = this.inFlight.get(host.baseUrl) ?? 0;
    this.inFlight.set(host.baseUrl, load + 1);
    let release: (() => void) | undefined;

    try {
      release = await this.acquireSlot(host);
      for (let attempt = 0; attempt < this.config.crashRetry.attempts; attempt++) {
        // Cold or previously-errored host gets a warm-up FIRST. Retrying a
        // crashed model without reloading it just crashes again.
        if (!this.warm.has(host.baseUrl)) await this.warmUp(host);

        try {
          // 45000 ALWAYS, whatever the caller asked for. The cap is a property
          // of the tier (C2/NFR-8), not a per-call preference — enforcing it
          // here is the whole reason callers may not reach LM Studio directly.
          const body = await this.chat(host, prompt, T2_MAX_TOKENS, this.config.requestTimeoutMs);
          this.warm.add(host.baseUrl);
          // A model that thought and never concluded is a FAILURE with a name,
          // not an empty answer (W16-38). Thrown rather than returned empty,
          // because every caller parses `text` and an empty string becomes a
          // rejected finding — which reads as "reviewed and clean".
          const choice = body.choices?.[0];
          const noAnswer = choice ? noAnswerReason(choice) : null;
          if (noAnswer) throw new Error(`Model returned no answer: ${noAnswer}`);
          return {
            text: choice?.message?.content ?? '',
            model: body.model ?? host.modelSlot,
            tokensIn: body.usage?.prompt_tokens ?? 0,
            tokensOut: body.usage?.completion_tokens ?? 0,
            // null, not 0: a LAN call has no dollar cost, and 0 would read as
            // "measured and free" rather than "does not apply".
            costUsd: null,
            durationMs: Date.now() - started,
          };
        } catch (error) {
          this.warm.delete(host.baseUrl);
          const last = attempt === this.config.crashRetry.attempts - 1;
          if (last || !isCrash(error, this.config.crashRetry.matches)) throw error;
          await this.sleep(this.config.crashRetry.backoffMs[attempt] ?? 60_000);
        }
      }
      throw new Error('unreachable');
    } finally {
      release?.();
      const now = this.inFlight.get(host.baseUrl) ?? 1;
      this.inFlight.set(host.baseUrl, Math.max(0, now - 1));
    }
  }

  async health(host: T2Host): Promise<{ ok: boolean; model?: string }> {
    try {
      const res = await this.fetchImpl(`${normalizeHost(host.baseUrl)}/v1/models`, {
        signal: AbortSignal.timeout(this.config.warmup.timeoutMs),
      });
      if (!res.ok) return { ok: false };
      const body = (await res.json()) as { data?: { id?: string }[] };
      const model = body.data?.[0]?.id;
      return model === undefined ? { ok: true } : { ok: true, model };
    } catch {
      // Unreachable LAN host is a NORMAL state (NFR-7), not an exception: the
      // laptop is closed, the VLAN is down. It parks jobs; it never breaks a
      // Tier-1 dashboard.
      return { ok: false };
    }
  }
}
