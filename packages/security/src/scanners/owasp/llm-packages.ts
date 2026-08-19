import { and, desc, eq } from 'drizzle-orm';
import { security, type Database } from '@repopulse/shared';

// owasp_llm auto-enablement (W8-08, SECURITY_SUITE.md §3.4).
//
// The rule: owasp_llm runs only where an LLM client is actually a dependency.
// Running it everywhere would produce confident findings about prompt injection
// in codebases with no model in them — and a security tool that reports
// categories the code cannot contain is one people learn to skim.
//
// The evidence is the SBOM, which the DEPENDENCY scanner writes (W8-06). That
// scanner is currently blocked for missing tools, so in practice no SBOM
// exists yet and this returns `no_sbom` — which is deliberately NOT the same
// answer as `false`. "No LLM packages" is a fact about the repository; "no
// SBOM" is a fact about us, and only the first should ever look like a
// decision.

/** Package names that mean a repository talks to a model. */
export const LLM_PACKAGE_PATTERNS = [
  /^@anthropic-ai\/sdk$/,
  /^openai$/,
  /^@openai\//,
  /^langchain/,
  /^@langchain\//,
  /^llamaindex$/,
  /^@llamaindex\//,
  /^ollama$/,
  /^cohere-ai$/,
  /^@google\/generative-ai$/,
  /^@mistralai\//,
  /^@huggingface\//,
  /^transformers$/,
  /^litellm$/,
  /^vercel-ai$/,
  /^ai$/,
];

export function isLlmPackage(name: string): boolean {
  return LLM_PACKAGE_PATTERNS.some((pattern) => pattern.test(name));
}

/** Component names out of a CycloneDX document, defensively. */
export function componentNames(document: Record<string, unknown>): string[] {
  const components = document['components'];
  if (!Array.isArray(components)) return [];
  return components
    .map((c) => (c as { name?: unknown }).name)
    .filter((n): n is string => typeof n === 'string');
}

export type LlmApplicability =
  | { applies: true; reason: string; packages: string[] }
  | { applies: false; reason: 'no_llm_packages' | 'no_sbom' };

/**
 * Should owasp_llm run for this repo?
 *
 * Returns the REASON, not just a boolean, because the two false cases need
 * different responses: `no_llm_packages` means the scanner correctly does not
 * apply, and `no_sbom` means nobody has looked — which the Security tab must
 * be able to say out loud rather than rendering as "not applicable".
 */
export async function owaspLlmApplies(
  db: Database,
  workspaceId: number,
  repoId: number,
): Promise<LlmApplicability> {
  const [sbom] = await db
    .select({ document: security.sboms.document })
    .from(security.sboms)
    .where(and(eq(security.sboms.workspaceId, workspaceId), eq(security.sboms.repoId, repoId)))
    .orderBy(desc(security.sboms.createdAt))
    .limit(1);

  if (!sbom) return { applies: false, reason: 'no_sbom' };

  const packages = componentNames(sbom.document).filter(isLlmPackage);
  if (packages.length === 0) return { applies: false, reason: 'no_llm_packages' };
  return {
    applies: true,
    reason: `SBOM lists ${packages.length} LLM package(s)`,
    packages: packages.sort(),
  };
}
