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
| W19-08 | Claude Max plan option | Opt-in Claude Code CLI backend the customer installs and signs in to themselves, off by default, behind an accept-responsibility switch with an audit row (Brad, 2026-10-17); depends on W19-01 |
| W19-07 | Settings experience | Admin → Models wizard: pick local, proxy or hosted, test, assign roles, see the eval table and what leaves the container |

## Recommendation and order

W19-01 and W19-02 first (they unlock customers connecting anything), then W19-04 (the part that makes the AI useful on top of the scanners), then W19-03, W19-05, W19-07; W19-06 runs alongside as the standing upgrade track.

## Decisions I took on the recommendation (reversible)

- Gemini and local servers go through the OpenAI-compatible adapter first; native adapters follow only where a feature needs them.
- Hosted subscription plans: Brad asked for a Max plan option. The supported route today is an Anthropic API key. I have not verified that Anthropic's terms allow a product to use a consumer subscription login, so I will not build that unverified. The proposal is an opt-in "Claude Code CLI backend" that the customer installs and signs in to themselves inside their own container, after a terms check; it is a separate ticket, not part of W19-01.
- AI never auto-suppresses or auto-merges: verdicts and patches are suggestions for a human (D9a and the VEX rule stay).

## Decided by Brad (2026-10-17)

- The specialist agents are the attest experts (`~/Code/attest`, v3.13 lineage); W19-03 is rebased on the attest roster once docs/design/ATTEST_EXPERTS.md is written.
- The Max-plan option is built now, as W19-08, behind an accept-responsibility switch (off by default, audited). The project has not verified the consumer plans' terms; the switch makes the responsibility explicit and API keys stay the supported route.

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

## W19-02 as built (2026-10-18)

**Roles** (the names in `ATTEST_EXPERTS.md`): `security`, `performance`,
`code_health`, `best_practices`, `ai_slop`, `test_coverage`, `triage`, `patch`.
A pass is routed by `meta.role` when it names one, otherwise by its
`dimension`; anything else uses the shared pool.

**Storage** (migration 0040, both tables workspace-scoped): `llm_role_routes`
(one row per link, ordered by `position`, optional per-link model override,
cascade on connection delete) and `llm_routing_policy` (`local_only`).
`GET/PUT /admin/llm-routing` (admin, audited as `llm_routing.updated`) replaces
the whole configuration in one transaction; Admin → Models shows it as a
"Routing" section. Changes reach the worker within the gateway cache TTL
(about a minute), no restart.

**Fallback.** Along a chain only on a `ProviderError` (unreachable, refused,
non-2xx, timeout). A model that answers badly — empty, reasoning-exhausted — is
never retried on another model. Every call records which link served it
(`CompleteResult.route`: role, connection, model, link index, and the links that
failed first with their errors). If every link fails the error names the role
and each failure. A routed role whose connections are all disabled or deleted
refuses by name rather than quietly using the shared pool.

**Local-only.** "Leaves the container" means what the egress audit already means
by leaving the network (`isLocalHost`: loopback, RFC1918, `*.local`,
`*.internal`) — one definition, so a call is audited exactly when local-only
would have refused it. Enforced at save time (422 naming the role and the
connection) and again at call time. With it on, roles without a chain use only
local connections, and Tier-3 is refused with a `denied` audit row. With it off
(the default) nothing about Tier-3, the opt-in, the audit row or the monthly
budget changes; tests pin that.

**Verified against the real LM Studio** (qwen/qwen3.8-27b): a chain whose first
link is a dead port falls back to LM Studio and records the failed link; a
local-only chain naming a hosted connection is refused before any request; an
unrouted role under local-only is served by LM Studio.

**Not built:** per-role budgets (the monthly Tier-3 budget is unchanged), and
persisting `route` on findings — it is returned and passed to `onRouted`; the
egress audit's `modelId` already identifies the model for non-local calls.

## W19-03 as built (2026-10-18)

**Roster** (`packages/analysis/src/specialists`): `security`, `performance`,
`code_health`, `test_coverage` and the two new ones, `best_practices` and
`ai_slop`. One name is the routing role (W19-02), the finding dimension and the
checklist file (`checklists/{id}.v{N}.md`). The dimension joins
`FINDING_DIMENSIONS` (migration 0041) so the facet, the API filter and the CHECK
constraint all know it. Findings use the existing schema unchanged.

**Where the new checklists came from.** `ai_slop.v1` keeps only the *judgement*
rules of attest v3.13.3's `ANTI_SLOP_RULES` (R-10, R-05..R-08, R-17, R-18,
R-11/12, R-13/14, R-26, R-27, R-28, R-29); the mechanical ones (phantom imports,
unused exports, docstring ratio, empty catch, stale JSDoc params) stay with the
slop scanner and the rule packs, and the checklist names the scanner's `slop.*`
ids so the two layers dedup into one row. `best_practices.v1` is the roster
*choice* ATTEST_EXPERTS.md said was needed: pattern/naming/comment drift from
the pattern-consistency checker, plus contract and boundary hygiene, narrowed to
what a model can judge from the code in front of it. Provenance is recorded in
each file.

**Run on a diff, a file or a module.** `ReviewInput` is `diff | file | module`.
A file or module is presented as the add-only patch of its contents in numbered
120-line windows, so one chunker, one budget rule and one evidence check serve
all three (a quote must still be a substring of what the model saw). Repo-wide
input is *supplied by the caller*; this code does not fetch it, because Law 4
allows source only through the forge provider / the W8 tarball sandbox.

**Chunking bounded by the probed context window.** `budgetForContext(window)`
shrinks the prompt and output budgets so chunk + fixed overhead + projected
output fit; unknown stays at the defaults (an unknown window is not a small
one). A single hunk larger than the budget is cut at line boundaries (each part
keeps its `@@` header). The probed window is stored on the connection (W19-01),
carried onto its host, and `contextWindowForRole` takes the smallest along a
role's chain, since any link can serve a call.

**Conditional waves.** `planWaves` decides relevance from the change itself —
file kinds, and for performance whether there is anything for it to review (loops,
queries, async) — never a model call. Docs-only: nothing runs, with a reason for
each specialist. Wave 1 security; wave 2 performance, code health, test coverage;
wave 3 the advisory best-practices and AI-slop. `runSpecialists` takes a call
cap and, when it would be exceeded, drops *whole* specialists from the last wave
first and lists them in `droppedForBudget` — a short run says it was short.

**Not built / not verified.** Nothing calls `runSpecialists` from a scheduled
pass or an API route yet (that needs the forge fetch for repo-wide input and a
persistence decision for `route` and the new dimensions); the persistence side
(dimension constraint, facets) is ready. Golden fixtures pin planning, chunking,
prompt assembly and validation per specialist; whether a model *finds* each
planted defect is the W19-05 eval harness, though the live check below ran it
once against the real LM Studio.

**A prompt-template fix found by the live run.** The required-JSON template said
`"dimension":"<dimension>"`, a placeholder, and a real model (qwen3.8-27b) filled
it with `slop` for the ai_slop checklist — a correct finding rejected over a
label. The template now names the exact dimension, and the specialist runner
sets the dimension from the specialist before validating (the checklist decides
what was reviewed, not the answer). This changes the prompt text for every
dimension, so the two golden digests in `checklist-v2.test.ts` were re-recorded
deliberately; the checklist assets themselves are unchanged, so no checklist
version was bumped.

## W19-04 as built (2026-10-18)

Evidence-fed triage of **mechanical** findings: `packages/security/src/triage`.
It is the V5 pattern (`validation/verify`, which triages dependency CVEs)
applied to findings a rule raised, and it keeps V5's vocabulary on purpose — a
funnel with reconcilable invariants, rejection reasons, and a `dismissed`
counter that is always zero — so a person triaging does not learn two shapes.

**What the role receives.** The rule's provenance (scanner, rule id, pack
version, the rule's own description, CWE), the flagged lines and text, the
reachability tier, and a bounded, **line-numbered** slice of the file from the
snapshot (Law 4: never fetched live). Only dependency findings carry a
reachability tier today, so for a rule-raised code finding the prompt says
*"not computed for this scanner"* rather than inventing one. The slice is
sized to the triage role's probed context window (`budgetForContext`, W19-03)
and always contains the flagged lines.

**What it returns.** `real`, `likely_false_positive` or `needs_human` (a normal
answer, never a failure), a confidence, a rationale, **citations**, and
optionally a VEX justification and a patch. The prompt (`checklists/triage.v1.md`,
versioned) writes the verdict values out in the answer template.

**Uncited verdicts are rejected.** Every verdict must cite at least one line by
the number printed in the slice's margin, and a quote, if given, must be on that
line. The stored citation text is *our* copy of the line, never the model's. A
verdict citing nothing (`uncited`) or a line it was not shown (`citation_not_found`)
is thrown away and counted; malformed and uncited answers get one corrective
retry, an out-of-slice citation does not (a second try would be shopping for a
nicer answer).

**Nothing is suppressed, merged or written.** A VEX justification is accepted
only with `likely_false_positive` (on any other verdict it contradicts itself →
`ungrounded`) and is a proposal for a person. A patch is kept only if the **same
deterministic rules** that raised the finding no longer fire after it, via the
existing W18-19 `verifyPatch` path; the model's opinion of its own fix is never
read. With no runner supplied, or for a scanner no runner reproduces, no patch is
offered at all.

**Routing and local-only.** Calls carry `meta.role: 'triage'`, so the
workspace's routing chain, fallback on provider errors and the local-only
switch (W19-02) apply with no code in triage; tests pin that a local-only
policy refuses a triage chain naming a hosted connection before anything is
sent, and that the serving link is recorded on each proposal.

**Agreement, per model** (`docs/TRIAGE_EVAL.md`, rendered from
`docs/triage-eval.json`; scored with `packages/security/src/triage/cli.ts`).
Twelve hand-labelled findings — six real, six false positives, one rule family
each. A verdict *agrees* when it matches the label, *disagrees* when it
contradicts it, *abstains* on `needs_human`, and is *rejected* when no valid
verdict came back. "Missed real" — calling a real finding a false positive — is
counted on its own because it is the error that hides a live problem. **The
labels were written by the same AI assistant that built the ticket and have not
been reviewed by a person;** the table says so, and it is an indicative floor on
a tiny set, not an accuracy estimate.

**Not built.** Nothing calls `runTriage` from a scheduled pass or an API route,
and a verdict is not yet persisted or shown in the findings UI (the findings
table has no place for it; V5's proposals attach to dependency vulnerabilities).
Those are the next step. The benchmark corpus (`fixtures/benchmark`) grades
*detection*, so it has no scanner-hit-with-truth cases; the triage cases are
authored for this ticket.

## W19-05 as built (2026-10-18)

**Harness** (`packages/security/src/eval`): each specialist is run over labelled
fixtures (`packages/security/fixtures/eval/<role>.json`: four cases per role,
two with a planted defect and two clean) for a chosen provider and model, and
scored for **precision** and **recall** per role. A finding matches a planted
defect when it is on the same file and its evidence quote covers the planted
quote; one finding satisfies at most one label (a repeat is a duplicate, neither
right nor wrong). Triage agreement (W19-04) is run in the same pass. The
specialist is forced to run on every case, so the planner's relevance decision
cannot hide a defect from the model being measured.

**Provider errors are reported, not scored.** A case that throws is recorded
with the provider's own words, the role is marked *incomplete*, its precision
and recall are withheld, and the CLI exits 1. A dropped connection is never
published as a model that found nothing. A model that answers but never in the
required format (after the one retry) *is* scored — as nothing found — and
counted separately as a format failure, because that is a property of the model.

**Published table.** `docs/MODEL_EVAL.md` renders from the committed results
(`results.generated.ts`); a test fails if they disagree. The same results are
served by `GET /admin/model-eval`, joined to this workspace's configured models
(workspace-scoped), and shown in Admin → Models: precision/recall per role, the
engine and date of the run, "not yet run" for any unmeasured cell, a configured
model with no result listed as not yet run, and "incomplete" for a run that hit
provider errors.

**Determinism.** Temperature is fixed at 0.1 by the Tier-2 client. The CLI can
send a `--seed`, recorded on the row as *requested*; a server may ignore it (the
page says so). Cases are assigned to concurrency groups by index and run in a
fixed order, so the same cases produce the same prompts regardless of
concurrency (tested). Sampling itself is the provider's.

**First measurement** (qwen/qwen3.8-27b on LM Studio, 54 minutes, no provider
errors): recall 100% on every role; precision 100% for security, code health and
best practices, 67% for performance, test coverage and AI slop (one false
positive each, on a clean case); triage 12/12. The fixtures are small and written
by the same AI assistant that built the ticket, **their labels have not been
reviewed by a person**, so this is an indicative floor and not an accuracy
estimate.

**Not run / not built.** The OWASP Benchmark and Juliet slices in
`fixtures/benchmark` grade scanner *detection*, need a fetched corpus, and are
not part of these runs (the ticket named them; this is the gap). Only one model
has been measured. Nothing runs the evaluation on a schedule.
