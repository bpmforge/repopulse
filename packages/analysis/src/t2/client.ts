import type { CompleteOpts, CompleteResult } from '../gateway/types.js';
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

export interface T2Host {
  baseUrl: string;
  modelSlot: string;
  /**
   * Credential and extra headers for a hosted provider (W16-06). Absent for a
   * LAN model, which is still the default and still sends nothing.
   */
  auth?: HostAuth | undefined;
  /** The provider row this host came from, for the egress audit. */
  providerId?: number | undefined;
}

export interface T2Config {
  hosts: T2Host[];
  warmup: { pingPrompt: string; timeoutMs: number; retries: number };
  crashRetry: { matches: string[]; attempts: number; backoffMs: number[] };
  /** Per host (FR-ANALYSIS-8). */
  concurrencyCap: number;
}

export const T2_DEFAULTS: Omit<T2Config, 'hosts'> = {
  warmup: { pingPrompt: 'ping', timeoutMs: 15_000, retries: 2 },
  crashRetry: {
    matches: ['model crashed', 'ECONNRESET', 'model_not_loaded'],
    attempts: 3,
    backoffMs: [5_000, 15_000, 60_000],
  },
  concurrencyCap: 1,
};

export interface T2Deps {
  /** Injectable transport so tests can drive crash paths deterministically. */
  fetchImpl?: typeof fetch;
  /** Injectable so backoff tests do not actually wait 80 seconds. */
  sleep?: (ms: number) => Promise<void>;
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

  private async chat(host: T2Host, prompt: string, maxTokens: number, timeoutMs?: number): Promise<ChatResponse> {
    const controller = new AbortController();
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const res = await this.fetchImpl(`${normalizeHost(host.baseUrl)}/v1/chat/completions`, {
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
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // The body carries LM Studio's own reason ("model crashed"), which the
        // crash matcher needs — a bare status code would lose it.
        // The body carries the provider's own reason, which the crash matcher
        // needs — a bare status code would lose it. Named generically since
        // W16-06: this client now speaks to any OpenAI-compatible endpoint.
        throw new Error(`Model host responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      return (await res.json()) as ChatResponse;
    } finally {
      if (timer) clearTimeout(timer);
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

    try {
      for (let attempt = 0; attempt < this.config.crashRetry.attempts; attempt++) {
        // Cold or previously-errored host gets a warm-up FIRST. Retrying a
        // crashed model without reloading it just crashes again.
        if (!this.warm.has(host.baseUrl)) await this.warmUp(host);

        try {
          // 45000 ALWAYS, whatever the caller asked for. The cap is a property
          // of the tier (C2/NFR-8), not a per-call preference — enforcing it
          // here is the whole reason callers may not reach LM Studio directly.
          const body = await this.chat(host, prompt, T2_MAX_TOKENS);
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
