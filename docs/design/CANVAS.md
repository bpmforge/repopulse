# RepoPulse UI canvas — where it lives and how to change it

The visual reference for RepoPulse's shipped screens. One artboard per
UX_SPEC §4 screen, drawn from the real components rather than the spec's
ASCII sketches, using the token values in `apps/web/src/styles/theme.css`
verbatim.

**Published canvas:** https://claude.ai/code/artifact/5df4b606-8a35-4258-adf2-b11de28e6250

## Working files — edit these, never the seeded output

| File | What it is |
|------|-----------|
| `docs/design/canvas/Main.dc.html` | Org Overview (`/`) — entry artboard |
| `docs/design/canvas/RepoDetail.dc.html` | Repo Detail (`/repos/:repo`) |
| `docs/design/canvas/PrDetail.dc.html` | PR Detail (`/repos/:repo/prs/:number`) |
| `docs/design/canvas/FileDetail.dc.html` | File drill-down (`/repos/:repo/files/*path`) |
| `docs/design/canvas/Findings.dc.html` | Findings Explorer (`/findings`) |
| `docs/design/canvas/MyFocus.dc.html` | My Focus (`/me`) |
| `docs/design/canvas/Views.dc.html` | Custom Views (`/views`) |
| `docs/design/canvas/Reports.dc.html` | Report Center (`/reports`) |
| `docs/design/canvas/Plans.dc.html` | Plans (`/plans`, D9) |
| `docs/design/canvas/Admin.dc.html` | Admin (`/admin`) |
| `docs/design/canvas/canvas.json` | Layout: positions, titles, sticky notes |
| `docs/design/canvas/repopulse-ui-canvas.html` | **Generated.** The seeded page that gets published. Never hand-edit it. |

## To update the canvas

Edit the `.dc.html` working files, re-seed a fresh copy, then republish to
the SAME url so the link keeps working:

```
node "<design skill base>/seed-canvas.mjs" \
  --template "<design skill base>/payload.template.html" \
  --out repopulse-ui-canvas.html --title "RepoPulse UI" \
  --artboard Main.dc.html --artboard RepoDetail.dc.html \
  --artboard PrDetail.dc.html --artboard FileDetail.dc.html \
  --artboard Findings.dc.html --artboard MyFocus.dc.html \
  --artboard Views.dc.html --artboard Reports.dc.html \
  --artboard Plans.dc.html --artboard Admin.dc.html \
  --canvas canvas.json
```

Then publish `repopulse-ui-canvas.html` with the same title and favicon
(📊). Publishing a DIFFERENT file path claims a NEW url — which is how one
canvas turns into ten. If the canvas has been edited in the browser since
the last seed, read it back first (`--extract`) so those edits are not
discarded.

## Screens covered — all ten, complete

- [x] §4.a Org Overview — shipped
- [x] §4.b Repo Detail — shipped
- [x] §4.c PR Detail — shipped
- [x] §4.d File drill-down — shipped
- [x] §4.e Findings Explorer — **shipped in full** (W6-04); the spec's "teaser" note is stale
- [x] §4.f My Focus — shipped
- [x] §4.g Custom Views — shipped
- [x] §4.h Report Center — shipped
- [x] §4.h2 Plans — shipped (D9)
- [x] §4.i Admin — shipped

## Rule the canvas is held to

It documents what is SHIPPED. An artboard that contradicts the rendered UI is
worse than no artboard, so each board is drawn from the components in
`apps/web/src/widgets/**` and `apps/web/src/routes/**`, and anything
specified-but-unbuilt is labelled rather than drawn as though it exists.

## What the drawing found — UX_SPEC §4 vs the running app

This list is the real product of building the canvas. **UX_SPEC is the older
document**; in every case below the app is right and the spec is stale. None of
this is a defect list — it is drift, and it is only expensive once nobody
remembers which document to trust.

### The spec is factually wrong in one place

- **§4.e calls the Findings Explorer "v1.x — shell ships in MVP as teaser".**
  The full explorer shipped in W6-04: six URL-synced filters (the scanner facet
  driven by the registry, so a later wave's scanner becomes filterable with no
  edit to the screen), bulk confirm/dismiss behind a *required* note, and a
  false-positive-rate widget. The repo-level Findings **tab** is the teaser —
  a different surface. Worth fixing in the spec.

### Screens that grew past their spec

- **Org Overview (§4.a)** carries five widgets the spec never mentions: Weekly
  pulse (pinned top), Improvement plan (D9), Security rollup, Top risks, Risk
  axes.
- **Repo Detail (§4.b)** ships seven routed tabs, not five — Security (W8) and
  Code Health (W9) came later.
- **Report Center (§4.h)** ships five report types, not four (Code Health,
  D11), plus a free-text "Context" annotation stored *with* the report and a
  compare mode that diffs two runs.
- **Admin (§4.i)** ships eight tabs, not four. Connections, Sync, Members and
  Analysis were specified; Identities, Agreements, Rules and Settings arrived
  with later waves.
- **File drill-down (§4.d)** gained the Intent control (Refactor / Supervise /
  Acknowledged, W6-09) and a history banner that reports last-seen and previous
  paths *without* claiming deletion — ingestion cannot tell a deletion from a
  quiet file.

### Things the spec drew that were never built

- **§4.a's health-tile sparkline.** Tiles ship as name + badge + basis only.
- **§4.c's PR Detail furniture** — the horizontal stage bar (shipped as a
  vertical list), risk badges, the findings accordion with evidence quotes,
  per-file hotspot badges, the GitHub ↗ link.
- **§4.f's personal cycle-time-vs-repo-median chart.** Four count tiles stand
  in its place, captioned "not compared to an earlier window" rather than
  showing a delta nobody computed.

### Decisions the canvas makes visible

Not divergences — implementation choices that only become legible when drawn,
and that a redesign should not casually undo:

- **Plans has no "mark done" button.** An item closes when its metric actually
  moves, verified nightly (W5-06). A human cannot declare victory over a number.
- **The FP-rate widget shows an em dash, never 0%,** when nothing has been
  triaged: an untriaged corpus must not read as a flawless model
  (FR-INSIGHTS-1).
- **PR Detail's empty "Automated review" panel says why it is empty.** Per
  FR-WEB-8, an empty panel with no policy line reads as a clean bill of health.
- **My Focus keeps identity-unlinked apart from nothing-to-do.** Both render
  empty; only one is fixable by the user.
- **Admin shows a credential fingerprint and last 4 only** — showing more would
  put a token in the DOM (SC-2) — and surfaces the rate-limit budget per repo,
  because budget is law (Law 7) and an operator must see it *before* a repo
  goes `paused_budget`.
- **Churn bars are grouped, not stacked:** rework is a subset of gross, so
  stacking would read as double the churn that happened.
- **Status is always a glyph plus a word,** never colour alone (§7).

### Corrections to this document, 2026-08-21

Two claims in the first version of this list were **wrong**, both from reading
a component only as far as the screen I was drawing:

- It said the Code Health tab was "spec, not shipped code" because
  `widgets/code-health/` holds only `contracts.ts`. The tab is fully
  implemented — its components live in
  `apps/web/src/routes/repos/$repoId/code-health.tsx`.
- It said §4.d's "recent PRs touching this file" table was not shipped.
  `FileDetail.tsx:217` renders it. The artboard was missing the panel and has
  been redrawn.

Recorded rather than quietly edited: this canvas exists to stop documents from
drifting away from the app, and it drifted first.

### Done, 2026-08-21: the rail icons

The rail's icons were text glyphs (`◈ ▤ ⇄ ◎ ⚑ ◷ ▦ ❏ ⚙`) — the one element
across the ten boards that read as placeholder rather than design, and shapes
that were never really ours since they rendered at the mercy of font fallback.
They are now inline stroke SVGs on a 24px grid in `currentColor`, so they
inherit the active/muted nav colour with no per-state variant. Nine icons did
not justify an icon package. The artboards were re-seeded in the same commit —
a canvas that contradicts the app is the one failure this document forbids.
