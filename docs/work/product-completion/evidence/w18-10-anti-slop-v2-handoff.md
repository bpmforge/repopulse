# W18-10: anti-slop.v2 candidate handoff, measured before and after

2026-10-15, branch `claude/repopulse-slop-v2`. Raw numbers:
[`w18-10-anti-slop-v2-handoff/measure.json`](w18-10-anti-slop-v2-handoff/measure.json).
Harness: `packages/security/src/scanners/anti-slop/handoff.measure.test.ts`.

## What changed

v1 sent the model the whole diff and asked it to search for structural slop. v2 sends
only the fast lane's shadow candidates: rule id, file, line, the rule's quote and claim,
and a ≤24-line excerpt. The model confirms a candidate or stays silent. A finding outside
every candidate's excerpt is rejected, and so is a second finding for the same candidate.
The verify pass (maker ≠ verifier, severity ≥ 3) is unchanged.

## Method: no model was called

**Repository code never left this machine.** Neither side of the comparison called a model.

- **Before (v1)** is the exact prompt v1 built: `chunkDiff(diff, 'code_health')` and
  `buildChecklistPrompt(anti-slop.v1, chunk)`, with tokens counted by the chunker's
  `estimateTokens` (bytes / 3.4). Output is the chunker's own `projectedOutputTokens`.
- **After (v2)** is the real `runAntiSlopScan` against a Postgres (`rp_slop_v2`), with a
  **stubbed gateway**. The stub counts the prompt it is handed with the same estimator.
  It answers deterministically by **confirming every candidate**, quoting the flagged
  line. That makes its judgement count a ceiling: a real model can confirm at most this
  many. Its output size is the most a v2 answer can cost.
- **Judgement finding counts for v1 are not measured.** They depend on what a real model
  says about a whole diff, and no model was run.

### Trees

| Tree | What it is | Commit |
|---|---|---|
| **demo** | The demo repositories. The fixture forge's `fixture-org/{alpha-service,beta-web,gamma-events}` all serve `FIXTURE_SOURCES` as their tree and `FAKE_COMMIT_FILES` as their commit diffs. This tree runs in every gate. | n/a |
| **repopulse** | This product's own monorepo, 1,029 readable source files, and its 20 most recent non-merge commits replayed as pull requests. | `3337699` |
| **slop-scorecard** | bpmforge/slop-scorecard: 29 files, with its single non-merge commit (62 files) replayed as a pull request. | `f3ed525` |

There are two scopes:

- **PR:** the commit's diff is what v1 reviewed, and it scopes v2's candidates to the files the commit touched.
- **Snapshot:** every file goes in as an added-file diff for v1. v2 gets every candidate in the tree.

One approximation in the PR rows: the fast lane read the tree at the measured commit for every replayed commit, not the tree as it stood at each one.

## Results

### Per pull request (the path the judgement layer exists for)

| Tree | PRs | v1 calls | v1 input tokens | v1 projected output | v2 candidates | v2 calls | v2 input tokens | v2 output (stub, ceiling) |
|---|---|---|---|---|---|---|---|---|
| demo | 3 | 3 | 4,073 | 2,482 | 0 | 0 | 0 | 0 |
| repopulse | 20 | 38 | 593,729 | 212,187 | 1 | 1 | 1,868 | 122 |
| slop-scorecard | 1 | 2 | 38,621 | 14,222 | 1 | 1 | 1,790 | 103 |
| **total** | 24 | 43 | **636,423** | 228,891 | 2 | 2 | **3,658** | 225 |

On these trees, PR input tokens fell from 636k to 3.7k, a **99.4%** reduction. Calls fell from 43 to 2. **22 of 24 PRs made no model call at all**, because none of their touched files had a candidate. v1 billed every PR at least one call of about 1.3k tokens, even a one-line change.

The biggest single saving was repopulse `3ea58c1d`, a 5-file commit with large files. v1 needed 18 calls and 420,643 tokens for it. v2 had no candidates in those files and made no call.

### Snapshot pass

| Tree | Files | Deterministic findings | v1 calls / input tokens | v2 candidates (by rule) | v2 calls / input tokens | v2 judgements (stub ceiling) |
|---|---|---|---|---|---|---|
| demo | 6 | 1 | 1 / 2,133 | 1 (unused_export 1) | 1 / 1,836 | 1 |
| repopulse | 1,029 | 130 | 75 / 1,759,000 | 25 (serial_awaits 16, unused_export 8, speculative_param 1) | 1 / 10,098 | 25 |
| slop-scorecard | 29 | 1 | 1 / 18,633 | 1 (delegation_wrapper 1) | 1 / 1,790 | 1 |

In production today, the scheduled pass calls the scanner with `files: []`. v1's judgement layer therefore sent nothing on schedule and judged nothing. v2 makes the snapshot judgement reachable, at 10k tokens for this repository rather than 1.76M.

### Finding counts

- **Deterministic findings are unchanged.** The fast lane runs before the handoff and the model cannot remove anything from it. Shadow findings stay stored and experimental.
- **v2 judgement findings are bounded by candidates:** at most 0, 1 and 1 per PR on these trees, and 25 on the repopulse snapshot. The confirm-all stub reached the ceiling every time, with 0 quote rejections. Every excerpt carried the line it flagged.
- **v1 judgement findings: not measured** (see Method).

## What v2 no longer covers

These have no candidate rule yet, so the model is no longer asked about them:

- Categories v1 could only find by searching: single-use helper, cargo-cult, architectural privilege escalation, LLM output without validation.
- The parts of unwired scaffolding and speculative generalisation that no rule matches.

The candidates come from JS/TS rules only, so a Python or Go diff gets no judgement call. Both gaps are stated in `anti-slop.v2.md`, in CODE_HEALTH_SUITE.md §1 and §4, and in the W18-10 plan note.

## Reproduce

```bash
# demo trees: every gate (DATABASE_URL set)
npx vitest run packages/security/src/scanners/anti-slop/handoff.measure.test.ts
# larger trees: git checkouts, opt-in
ANTI_SLOP_MEASURE_DIRS=/path/repopulse,/path/slop-scorecard ANTI_SLOP_MEASURE_COMMITS=20 \
ANTI_SLOP_MEASURE_OUT=/tmp/measure.json \
npx vitest run packages/security/src/scanners/anti-slop/handoff.measure.test.ts
```
