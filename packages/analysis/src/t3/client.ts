import { createHash } from 'node:crypto';
import type { CompleteOpts, CompleteResult } from '../gateway/types.js';

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
  createMessage?: (params: {
    model: string;
    max_tokens: number;
    messages: { role: 'user'; content: string }[];
  }) => Promise<{
    content: { type: string; text?: string }[];
    model: string;
    usage: { input_tokens: number; output_tokens: number };
  }>;
}

export function contentDigest(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

export function estimateCostUsd(
  usage: { input_tokens: number; output_tokens: number },
  pricing: T3Pricing,
): number {
  return (
    (usage.input_tokens / 1_000_000) * pricing.inputPerMTok +
    (usage.output_tokens / 1_000_000) * pricing.outputPerMTok
  );
}

const DEFAULT_PRICING: T3Pricing = { inputPerMTok: 3, outputPerMTok: 15 };

export function createT3Client(deps: T3Deps) {
  const model = deps.model ?? T3_DEFAULT_MODEL;
  const pricing = deps.pricing ?? DEFAULT_PRICING;

  async function call(params: {
    model: string;
    max_tokens: number;
    messages: { role: 'user'; content: string }[];
  }) {
    if (deps.createMessage) return deps.createMessage(params);
    // Imported lazily so a deployment with no Tier-3 configured never loads the
    // SDK, and so importing this package does not require an API key.
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: deps.apiKey });
    return client.messages.create(params) as unknown as ReturnType<
      NonNullable<T3Deps['createMessage']>
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

    const response = await call({
      model,
      max_tokens: Math.min(opts.maxTokens, 8192),
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    return {
      text,
      model: response.model,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      // A real number, unlike Tier-2's null: this call cost money and the
      // per-repo rollup on the admin tab is built from it.
      costUsd: estimateCostUsd(response.usage, pricing),
      durationMs: Date.now() - started,
    };
  };
}
