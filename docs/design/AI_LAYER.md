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
by leaving the network (`isLocalHost`: loopback and private IPv4 only; a host
*name* leaves, see "Host names" below) — one definition, so a call is audited
exactly when local-only would have refused it. Enforced at save time (422 naming the role and the
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

## W19-06 as built (2026-10-18)

Three parts, each independent.

**1. Signed rulepack bundles** (`packages/security/src/updates`, `deploy/`).
Builds on the existing host-side sync (`deploy/scan-db-sync.sh`, which already
mounts rulepacks and the grype database read-only into the network-less scan
container) instead of adding a second channel. A bundle is one JSON file: the
whole rulepack tree, SHA-256 per file, an Ed25519 signature over the manifest.
Verification refuses on any altered file, size mismatch, unsafe path, untrusted
key (named) or bad signature; there is no partial install. Install is
stage-verify-rename into `versions/<v>`, an atomic `current` symlink swap, an
audit record (`current.json`), three versions kept; a valid-but-older bundle is
refused (replay), going back is `rollback` (or `--to-shipped`). The offline path
is install-from-file; the online path is HTTPS-only, no redirects, size-capped,
and adds no trust. The operator places the publisher's public key themselves -
the product ships none - and chooses the schedule (the tool is run by their own
cron/timer; there is no scheduler inside the product). The sync script mounts
the installed bundle instead of the shipped packs. For advisory data it adds an
offline grype import (checksum required) and an opt-in previous-DB copy with
`deploy/scan-db-rollback.sh`.
*Verified for real:* the tool end to end on the real 50-file tree; the sync
script's rulepack step with no bundle, with a bundle, and after rollback; the
database-swap rollback and its undo. *Not run:* the grype import and
keep-previous branches (no archive/scan image here; shellcheck and syntax only).
*Gap:* advisory data is Anchore's and we do not sign it; only a checksum the
operator supplies is checked. No publisher infrastructure (key custody, a place
to host bundles) exists yet.

**2. Nightly regression gate** (`bench --compare`, `benchmark/regression.ts`).
Compares to the last committed report; any worse measured row fails; a row it
could not measure fails (an unprepared suite is reported as the one cause); a
failure must reproduce on a second run, a second clean run passes *flagged*
with the load noted. Run for real on this machine, where it correctly failed:
the OWASP/Juliet corpora are not fetched here and the load average was ~37 on 16
cores (another project's builds). `docs/BENCHMARKS.md` has the usage. The
workflow `.gitea/workflows/nightly-benchmark.yaml` has **never run**; the pass
path was exercised by tests and not end to end for lack of the fetched corpora.

**3. Rule-tweak proposals from AI-judged false positives**
(`rules/triage-clusters.ts`). Clusters W19-04's confident `likely_false_positive`
verdicts per rule (>= 3, confidence >= 3, and *more* false positives than real
verdicts for that rule). The real verdicts go into the prompt as cases the
narrower rule must still catch, and the prompt says the examples are AI
judgements, not confirmed. The draft goes through the existing validator
(trigger and clean fixtures required) and is stored `proposed` with provenance
`llm_draft:ai_triage`, set in code, never by the model; from there it is the
existing lifecycle (shadow, evidence, an admin's decision). Nothing in the path
can store any other status or touch an existing rule (tested: the store handed
to it can only insert). *Gap:* triage verdicts are not persisted yet, so nothing
feeds this pass automatically - it takes judgements as input.

## W19-07 as built (2026-10-18)

**The wizard** (Admin → Models → "Set up a model", `ModelsWizard.tsx`): where it
runs (local / a gateway you run / a vendor with your key), connect and test
(presets, address, model, key, the probing Test), choose roles, and a review. It
is a path through the same APIs as the full forms below it, which stay for
editing, reordering fallbacks and removing connections.

**"What leaves the container", stated per role** (`egress.ts`). Built from what
the *server* reports for each connection - its host, and whether that host is on
the operator's network by the same `isLocalHost` the egress audit and local-only
use - never from a connection's name or the form. A hosted connection called
"Local" still reads as leaving; an endpoint it cannot classify reads as leaving.
A role whose first choice is local but whose fallback is hosted is not called
"stays home". Under local-only the shared pool is described as local connections
only. The Tier-3 opt-in is stated once, separately, because it is a different
switch. A hosted connection cannot be saved without ticking that diffs, PR
descriptions and file paths will be sent to it.

**Found and fixed on the way (real defect in W19-01):** the `base_url` CHECK
constraint did not allow a `gemini` row with no base URL, so creating Gemini from
the admin screen failed in the database. Migration 0042 plus a route test (W19-01
only tested LAN connections). It is its own commit.

**Also learned (resolved 2026-10-18, see "Host names are not on the network"):**
model hosts must be IP addresses. The host policy accepted loopback and private
IPv4 only, while the audit's `isLocalHost` trusted `*.local`/`*.internal`. Brad
chose IPs only; the two now share one definition.

**Verified:** component tests for every step (51 admin widget tests); the Models
page in the Playwright axe scan in both themes and a wizard walk in the admin
spec, run in a real browser; and `e2e/models-lm-studio.spec.ts` (opt-in) driving
the whole local path in a real browser against a real LM Studio
(qwen/qwen3.8-27b): test, probe, save, roles, review "Stays home" - 28 seconds.
**Not verified:** the hosted worked example with a real key (none available); the
docs say so. The Playwright runs used a scratch browsers folder that links the
pinned build to an existing newer one, because installing the pinned browser is a
download that was not authorised - the same specs should be re-run once with the
pinned browser in CI.

## W19-08 as built (2026-10-18)

**What it is.** A `claude_cli` provider kind that runs the customer's own Claude
Code CLI - installed and signed in to by them, inside their container - as a model
backend (Brad, 2026-10-17). Shown everywhere as *customer-supplied*, never as a
RepoPulse feature. **Off by default.** The project has not verified that Anthropic's
consumer plan terms allow this; the switch exists so the responsibility is explicit,
and API keys stay the supported route.

**The switch.** `GET/POST /admin/llm-providers/claude-cli[/accept|/revoke]`. The
statement (`claude-cli.v1`, seven plain points, hashed) is served by the server and
shown in full. An admin must send the *current* version and SHA-256 to accept, so a
reworded statement cannot be accepted on an old click. The acceptance is a row in
`llm_responsibility_acceptances` (migration 0043): who, when, topic, version, hash.
Rows are never deleted; revoking sets `revoked_at`/`revoked_by`. One active
acceptance per workspace (a partial unique index); an acceptance of an *older*
statement does not count. Also an audit event (`llm_claude_cli.accepted` /
`.revoked`). It is per workspace (tested): another tenant's acceptance turns nothing on.
Create, Test and the worker all fail closed without a current acceptance; revoking
makes existing connections skip with the reason at the next gateway build.

**No credential, by construction.** The kind takes no API key (refused), ignores any
base URL, stores nothing. The runner reads exactly one boolean from `claude auth
status` (not the email or organisation in the same object).

**Constrained, because the CLI is an agent and this is a completion call.**
`--tools ""` (no tools: it cannot run commands or read files),
`--no-session-persistence`, an empty temporary directory as cwd (no project files or
CLAUDE.md), the prompt on stdin not argv, and an allow-listed environment (PATH,
HOME, the CLI's config dir, proxy and CA variables; none of RepoPulse's secrets;
tested). `--bare` is deliberately *not* used: it would drop the subscription login.

**Through the gateway like any provider.** The host's nominal destination is
`api.anthropic.com`, so the egress audit records it (and refuses to run unauditable),
local-only refuses it naming role and connection, the wizard review says it leaves,
and it counts against the same concurrency cap. Every failure is a `ProviderError`
with a plain message - missing binary, signed out/expired, timeout, bad output - so a
routing chain falls back past it. Cost is reported as null: the plan is flat-rate and
a per-call figure would be invented.

**Verified against the real CLI on this machine (claude 2.1.287):** `--version`,
`auth status --json`, and one real call - which returned *"Failed to
authenticate: OAuth session expired and could not be refreshed"* (exit 1, `is_error:
true`) although `auth status` still said `loggedIn: true`. So: the signed-out path is
tested against the CLI's real words, and `auth status` is only a hint (the UI says
so); Test connection is the proof. **Not verified:** a successful answer from a live
CLI (the login had expired; signing in is the customer's act, not mine, and I did not
attempt it), the success-path parsing is built from the observed result shape
(`result`, `usage`, `modelUsage`) and fakes; installing the CLI inside the hardened
worker image (needs network and a login); `deploy/compose.claude-cli.yaml` (never
run). The worker runs as an unprivileged user with the database URL in its
environment: the CLI runs in that container as the same user. It is started with an
empty environment and no tools, but it is another program there, and the compose
file says to think about that before choosing this over an API key.


## Host names are not on the network (2026-10-18, Brad: "IPs only")

**The rule.** "On the operator's own network" means loopback (the whole 127/8
block, `::1`, and the literal `localhost`) and private IPv4 (10/8, 172.16/12,
192.168/16, and 100.64/10, which the host policy has always treated as private).
Nothing else. A host **name** other than `localhost` is never on-network, however
it ends - `*.local`, `*.internal`, `*.lan`. A name resolves later, elsewhere, and
can change between the check and the call, which is why the host policy already
refused names without an explicit off-network decision.

**One definition.** `isOnNetworkHost` (`config/hosts.ts`) is the host policy's own
predicate; the egress audit's `isLocalHost`, local-only, the shared-pool filter,
the wizard review and `leaves_network` all call it, and a test pins that for a
table of ambiguous hosts `isLocalHost` is true exactly when the policy accepts the
URL without an off-network decision. They can no longer drift apart.

**What changed, concretely.**
- A model reached by `*.local` / `*.internal` (it can only exist with the per-row
  off-network decision, because the policy required one) is now **audited**
  (attempt and outcome rows in `egress_audit`), **refused by local-only** (with the
  reason: "reached by the host name ..., only IP addresses count as on your
  network"), dropped from the shared pool under local-only, and shown as **leaving**
  in the wizard review. Previously none of that happened to it.
- IPv6 loopback was previously treated as remote by the audit (a port-stripping bug
  turned `::1` into `:`); it is now on-network, as the policy always said.
- 100.64/10 (CGNAT, e.g. a Tailscale network) is now on-network for the audit,
  matching the policy. This **reduces** auditing for such hosts - the one change
  in the less-cautious direction, made because the policy accepts them without an
  off-network decision and the two must agree.
- The deprecated `LMSTUDIO_BASE_URLS` environment path does not go through the host
  policy; an entry there that uses a `.local`/`.internal` name is now audited and
  counts as leaving too.

**No silent migration.** No stored connection is rewritten. The admin list marks
each connection reached by a name ("Reached by a host name, so it counts as leaving
your network... Use the machine's IP address") and `docs/DEPLOYMENT.md` §8 has the
query to list them. To restore the old behaviour for such a machine, change its
address to its IP.

## W19-09 as built (2026-10-18): the AI layer in a real pass

**Why it was split.** The coordinator's request - a scheduled/queued pass, an API route,
persistence, and a findings UI - is two tickets. **W19-09** (this) is the pass, the
persistence and the API. **W19-10** is the findings UI, which cannot be designed until
the suggestion row shape and the read API settled here.

**The pass** (`ai.pass` queue, one attempt; `workers/ai-pass-processor.ts`). Started by
an admin (`POST /repos/{id}/ai-pass`) over **named paths** - files or directory
prefixes, at most 50; there is deliberately no "everything". The worker snapshots the
repository at its head commit (an archive, read only, deleted afterwards - C1a, D9a),
reads the files in scope, and:

1. runs `runSpecialists` (`planWaves` decides which specialists are relevant) through
   the workspace's routing chain, with the context window taken from the smallest
   probed window along each role's chain;
2. stores what they raise as **ordinary findings** (their own dimension, no scanner or
   rule, `tier 2`) under one `analysis_runs` row per specialist that raised any, plus
   `ai_finding_provenance`: the specialist, checklist version, model and the full
   **route record** of the call (which routing link served it, which failed first).
   `persistFindings` is called **without `reviewedFiles`**, the only thing that makes it
   auto-resolve other findings, so a pass cannot close anything;
3. runs **triage** on open, rule-raised findings in scope that have the stored code
   context (W18-32) and no earlier suggestion - top ten by effective risk - and stores
   each as a **suggestion**: verdict, confidence, rationale, citations whose text is
   *our* copy of the line, the proposed VEX justification, the model and route.
   Triage uses the stored context, not a forge call, and the stored lines keep their
   real file numbering (`sliceAround` takes the source's first line number).

**Bounds, all enforced and all recorded.** 40 files / 400 KB / 50 paths per pass;
30 gateway calls per pass, retries counted, with a third (at most twenty) held back for
triage so a tight cap cannot starve it; 10 passes per workspace per day; one active
pass per repository (a partial unique index). A scope over the limit is *refused with a
sentence naming the limit*, never silently truncated - reviewing "the first forty files"
would read as a clean pass.

**Every failure lands on the run row, in words** (`reason_code` + `reason`): no model
configured, no forge connection, no archive support, no head commit, no files matched,
too large, and **local-only** - a routed role that would leave the network fails the pass
with the gateway's sentence naming the role and the connection, and nothing is sent.
A scope with nothing for any specialist and nothing to triage is `skipped:
nothing_relevant`, not a success.

**The tables** (migration 0044, all workspace-scoped): `ai_pass_runs` (the plan with
reasons, per-specialist usage, the triage funnel, calls), `ai_finding_provenance`, and
`ai_triage_verdicts`. The verdict row stores the **human's** answer beside the
suggestion - `decision` accepted/dismissed, `decided_by`, `decided_at` - and `superseded`
is reserved for the system. At most one undecided suggestion per finding.

**What can never happen.** Nothing in the pass or the routes changes a finding's
status, dismisses, resolves, suppresses, merges or writes to a repository. Accepting an
AI "false positive" stores that on the suggestion; the finding is dismissed only when
the same person uses the existing `PATCH /findings/{id}`, with a note. Tests assert the
rule-raised finding is byte-for-byte unchanged after a pass, including after a
likely-false-positive verdict that carries a VEX proposal. The pass never uses Tier-3;
non-local providers are audited by the gateway as for any call.

**Verified for real.** 32 DB-backed tests against the actual tables, including tenancy
(another workspace's pass, finding and suggestion 404). And one run of the whole pass
against the real LM Studio (qwen/qwen3.8-27b, `AI_PASS_LIVE_MODEL`, 12 minutes) over a
one-file module with a call cap of 4: it ran security, code health and performance
(one call each), raised a finding each from security and code health, **dropped
test_coverage, best_practices and ai_slop for the cap and recorded that**, held one
call back for triage, and triage returned `real` at confidence 5, citing line 3 with
*our* copy of that line and the routing link that served it. The rule-raised finding
was still `open` afterwards. One small module and one run: it shows the wiring works
on a real model, not how good the answers are (that is the W19-05 table).

**Not built.** *Diff mode* (a pull request's files from the warehouse): the pass reads
a repository snapshot only. *Verified patches from triage:* the pass supplies no rule
runners, so a patch a model offers is dropped and recorded as `not_attempted`; verified
patches remain their own flow (Admin → Verified patches, W18-19). *Scheduling:* the pass
is started by an admin; no cron starts one. *Dependency findings:* they have a
reachability tier but no stored code context, so they are not triaged here. V5's
dependency-CVE proposals were never persisted anywhere; they still are not.
