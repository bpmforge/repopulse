# Repo Pulse: configurable AI layer and the continuous upgrade track (plan, 2026-10-17)

Source: Brad's direction in the project chat on 2026-10-17. Focus is Repo Pulse only. Two parts: (1) the mechanical checks keep getting stronger after Snyk parity; (2) a customer-configurable AI layer that reads the mechanical output plus the code and helps decide, using the specialist agents (security, performance, code health, best practices, AI slop) rather than Snyk's security-only scope.

Assumption to confirm: "AT test" is read as the bpm-opencode-experts specialist-agent work already ported into `docs/design/ANALYSIS_TIERS.md` §4 (dimension checklists). If it means something else, say so and the roster in ticket W19-03 is rebased on it.

## What already exists (verified in main at 4aaa251)

- Provider registry (W16-06..08): `openai_compatible` (covers LM Studio, Ollama, vLLM, LiteLLM, llama.cpp, MLX servers, OpenRouter, Groq, and Google Gemini through its OpenAI-compatible endpoint), `anthropic` (API key) and `bedrock` are supported; `vertex`, `copilot` and `openai_subscription` are registered but unsupported (W16-09, deferred). Credentials are encrypted at rest; there is an admin UI with Test connection.
- Gateway with T2 (local) and T3 (Claude API, per-repo opt-in, egress audit row), chunking, retry, escalation rules and monthly budget (`ANALYSIS_TIERS.md`).
- Dimension checklists for `code_health`, `security`, `performance`, `test_coverage`, plus anti-slop and verified patches (W18-19).

## What is missing

1. Provider breadth and honesty: native Gemini and Vertex, a capability probe (context window, JSON mode, streaming, tool use) so the settings page can say what a given model can do, and presets for MLX/mtplx, Unsloth, LiteLLM and vLLM.
2. Routing is by tier, not by role: a customer cannot say "security triage on the big hosted model, slop and health on the local one, or everything local only".
3. The specialists review diffs. They do not yet read the mechanical findings, reachability and a code slice together to decide.
4. Nobody can tell which model is good enough: there is no per-model quality table.
5. Mechanical checks have no update channel or regression guard after Snyk parity.

## Tickets (wave W19, proposed)

| Ticket | What | Notes |
|---|---|---|
| W19-01 | Provider breadth and capability probe | Gemini and Vertex native, presets (MLX, Unsloth, LiteLLM, vLLM, Ollama), probe stored on the connection; finishes the useful half of W16-09 |
| W19-02 | Per-role model routing and policy | Workspace settings map role (security, performance, health, best practices, slop, triage, patch) to provider and model with a fallback chain, a local-only switch and budget; T3 opt-in and egress audit rules unchanged |
| W19-03 | Specialist roster, repo-wide mode | Add best_practices and ai_slop dimensions beside the existing four; versioned assets; run on a file or module as well as a diff; conditional waves so only relevant specialists run |
| W19-04 | Evidence-fed triage | The specialist receives the mechanical finding, reachability tier, a bounded code slice and rule provenance, and returns a verdict (real / likely false positive / needs human) with a citation and optional verified patch; it can propose a VEX justification but never suppresses on its own |
| W19-05 | Model eval harness and published table | Run the specialists over labelled fixtures (OWASP/Juliet slices, slop and performance fixtures) per model; publish a per-model table in the admin UI and docs; not-yet-run shown as such |
| W19-06 | Mechanical upgrade track | Versioned rulepack update channel, advisory data refresh schedule, nightly benchmark regression gate, and a loop where clusters of AI-judged false positives become human-reviewed rule-tweak proposals |
| W19-07 | Settings experience | Admin → Models wizard: pick local, proxy or hosted, test, assign roles, see the eval table and what leaves the container |

## Recommendation and order

W19-01 and W19-02 first (they unlock customers connecting anything), then W19-04 (the part that makes the AI useful on top of the scanners), then W19-03, W19-05, W19-07; W19-06 runs alongside as the standing upgrade track.

## Decisions I took on the recommendation (reversible)

- Gemini and local servers go through the OpenAI-compatible adapter first; native adapters follow only where a feature needs them.
- Hosted subscription plans: Brad asked for a Max plan option. The supported route today is an Anthropic API key. I have not verified that Anthropic's terms allow a product to use a consumer subscription login, so I will not build that unverified. The proposal is an opt-in "Claude Code CLI backend" that the customer installs and signs in to themselves inside their own container, after a terms check; it is a separate ticket, not part of W19-01.
- AI never auto-suppresses or auto-merges: verdicts and patches are suggestions for a human (D9a and the VEX rule stay).

## Open for Brad (one question)

Should the Max-plan option wait for a terms check (recommended), or be built now behind a "you accept responsibility" switch?

## W19-01 as built (2026-10-17)

**Kinds.** `gemini` rides Google's OpenAI-compatible endpoint
(`generativelanguage.googleapis.com/v1beta/openai`) with an ordinary AI Studio
key; `vertex` takes the project/region OpenAI endpoint URL and a Google
**service-account key** (JSON) as its credential. Both need a `chatPath`
because their chat URL is not `<origin>/v1/chat/completions`
(`T2Host.chatUrl`). Both are public hosts, so the per-row `allow_public_host`
opt-in (SC-24) still applies.

**Vertex auth.** The stored service-account JSON signs an RS256 JWT
(`node:crypto`, no dependency), Google's token endpoint returns an access token
(cached in memory until a minute before expiry), and only that token reaches the
model endpoint. The JSON is encrypted at rest like any other credential; a token
URI that is not Google's is refused. Not verified against a real Google project
(none available here) — covered by unit tests with a generated key and a faked
token endpoint.

**Not built: Gemini's native `generateContent` wire format.** The compatible
endpoint is Google's first-party surface and carries everything the gateway uses
(chat, streaming, JSON mode, tools). A native adapter would add a second
request/response shape for no capability the passes need; it can be added behind
the same `kind` if a feature appears that only the native API has.

**Presets** (a URL and a note, not an integration): LM Studio `:1234`, Ollama
`:11434`, MLX `mlx_lm.server` `:8080`, Unsloth `:8888`, vLLM `:8000`, LiteLLM
`:4000`. Ports are the servers' usual defaults, shown as a starting point the
person edits; only LM Studio was run and verified here.

**Capability probe** (`probeCapabilities`): context window (read from the
server's own model metadata — LM Studio `/api/v0/models/{id}`, vLLM
`max_model_len`, Ollama `/api/show`, LiteLLM `max_input_tokens` — never
guessed), streaming, JSON mode (`json_object`, then `json_schema`), tool use.
Each is `yes` / `no` / `unknown`; `unknown` is never collapsed into `no`. Probes
run **sequentially**: against a real LM Studio, four requests arriving together
while the model loaded came back as HTTP 500s that read as "unsupported".
Stored on the connection (`llm_providers.capabilities`, `probed_at`, migration
0039), returned by the list route, shown in Admin → Models. Creating with
`probe: true` is refused (422, one sentence each) only for what makes a pass
impossible — no streaming, or a context window under 8192 tokens; missing JSON
mode or tool use is recorded, not fatal.
