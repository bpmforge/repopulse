import { createHash } from 'node:crypto';
import { usablePromptParts, type CompleteOpts, type CompleteResult } from '../gateway/types.js';

// Tier-3 Claude client (W7-01, FR-ANALYSIS-7, NFR-9).
//
// Tier 3 is the only place this product sends a customer's code OFF their
// network. Everything here exists to make that traceable rather than
// convenient: the egress row is written BEFORE the response is processed, so a
// call that crashes mid-parse still leaves evidence it happened.

/** Default model. Workspace-configurable; verified against the SDK at install. */
export const T3_DEFAULT_MODEL = 'claude-sonnet-5';

/** Published per-million-token prices, used to record cost_usd per call. */
export interface T3Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface EgressRecord {
  repoId: string;
  prNumber: number;
  dimension: string;
  checklistVersion: string;
  initiator: string;
  bytes: number;
  /** sha256 of exactly what was sent — the audit's proof of content. */
  contentSha256: string;
  model: string;
}

export interface T3Usage {
  input_tokens: number;
  output_tokens: number;
  /** Anthropic prompt-cache accounting (W23-06); absent when no caching happened. */
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** The request body shape the injected transport and the SDK both receive. */
export interface T3MessageParams {
  model: string;
  max_tokens: number;
  /**
   * W23-06: the static prefix as a system block marked ephemeral, so Anthropic
   * caches the checklist + schema across the chunks of a dimension. Absent
   * when the caller gave no usable split.
   */
  system?: { type: 'text'; text: string; cache_control: { type: 'ephemeral' } }[];
  messages: { role: 'user'; content: string }[];
}

/** The request for one T3 call: static as a cached system block, dynamic as the user turn. */
export function buildT3Params(
  prompt: string,
  opts: Pick<CompleteOpts, 'promptParts'>,
  model: string,
  maxTokens: number,
): T3MessageParams {
  const split = usablePromptParts(prompt, opts.promptParts);
  return split
    ? {
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: split.static, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: split.dynamic }],
      }
    : { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
}

export interface T3Deps {
  apiKey: string;
  model?: string;
  pricing?: T3Pricing;
  /**
   * Writes the egress audit row. REQUIRED, not optional: a Tier-3 client that
   * can run without an auditor is one that can send code off-network with no
   * record, which is precisely what NFR-9 exists to prevent.
   */
  recordEgress: (record: EgressRecord) => Promise<void>;
  /** Injectable transport so tests exercise the whole path without a key. */
  createMessage?: (params: T3MessageParams) => Promise<{
    content: { type: string; text?: string }[];
    model: string;
    usage: T3Usage;
  }>;
}

export function contentDigest(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

export function estimateCostUsd(usage: T3Usage, pricing: T3Pricing): number {
  // Anthropic bills cache reads at 0.1x and cache writes at 1.25x the input
  // price (5-minute ephemeral cache). Both are zero when nothing was cached,
  // which leaves the pre-W23-06 figure unchanged.
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (
    ((usage.input_tokens + cacheRead * 0.1 + cacheWrite * 1.25) / 1_000_000) *
      pricing.inputPerMTok +
    (usage.output_tokens / 1_000_000) * pricing.outputPerMTok
  );
}

const DEFAULT_PRICING: T3Pricing = { inputPerMTok: 3, outputPerMTok: 15 };

export function createT3Client(deps: T3Deps) {
  const model = deps.model ?? T3_DEFAULT_MODEL;
  const pricing = deps.pricing ?? DEFAULT_PRICING;

  async function call(params: T3MessageParams) {
    if (deps.createMessage) return deps.createMessage(params);
    // Imported lazily so a deployment with no Tier-3 configured never loads the
    // SDK, and so importing this package does not require an API key.
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: deps.apiKey });
    // STREAMED, like Tier 2 (W16-39). Every long generation this product makes
    // is streamed, without exception: a non-streamed request sends no response
    // headers until the model has finished, so the only thing bounding it is
    // whatever timeout the transport happens to have — which is exactly how
    // Tier 2 came to die at 301 seconds on undici's default.
    //
    // Anthropic makes the same point from the other side: it rejects
    // non-streaming requests whose max_tokens implies a long generation,
    // because the connection cannot be held open for them. `.stream()` also
    // removes the 10-minute ceiling that applies to a buffered request.
    //
    // `finalMessage()` yields the same assembled shape `create()` returned, so
    // nothing below this line changes.
    const stream = client.messages.stream(params);
    return (await stream.finalMessage()) as unknown as Awaited<
      ReturnType<NonNullable<T3Deps['createMessage']>>
    >;
  }

  return async function complete(prompt: string, opts: CompleteOpts): Promise<CompleteResult> {
    const started = Date.now();

    // WRITTEN FIRST. If the call throws, or the response fails to parse, the
    // record that this repository's code left the network still exists — an
    // audit that only logs successes is not an audit.
    await deps.recordEgress({
      repoId: opts.meta.repoId,
      prNumber: opts.meta.prNumber,
      dimension: opts.meta.dimension,
      checklistVersion: opts.meta.checklistVersion,
      initiator: opts.meta.initiator,
      bytes: Buffer.byteLength(prompt, 'utf8'),
      contentSha256: contentDigest(prompt),
      model,
    });

    const response = await call(buildT3Params(prompt, opts, model, Math.min(opts.maxTokens, 8192)));

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    return {
      text,
      model: response.model,
      // Cached input still went to the model, so it counts as input (the same
      // rule the CLI uses); with no caching this is exactly input_tokens.
      tokensIn:
        response.usage.input_tokens +
        (response.usage.cache_read_input_tokens ?? 0) +
        (response.usage.cache_creation_input_tokens ?? 0),
      tokensOut: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      // A real number, unlike Tier-2's null: this call cost money and the
      // per-repo rollup on the admin tab is built from it.
      costUsd: estimateCostUsd(response.usage, pricing),
      durationMs: Date.now() - started,
    };
  };
}
