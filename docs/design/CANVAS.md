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
  --artboard Findings.dc.html --artboard MyFocus.dc.html [--artboard …] \
  --canvas canvas.json
```

Then publish `repopulse-ui-canvas.html` with the same title and favicon
(📊). Publishing a DIFFERENT file path claims a NEW url — which is how one
canvas turns into ten. If the canvas has been edited in the browser since
the last seed, read it back first (`--extract`) so those edits are not
discarded.

## Screens covered so far

- [x] §4.a Org Overview — shipped
- [x] §4.b Repo Detail — shipped
- [x] §4.c PR Detail — shipped
- [x] §4.d File drill-down — shipped
- [x] §4.e Findings Explorer — **shipped in full** (W6-04); the spec's "teaser" note is stale
- [x] §4.f My Focus — shipped
- [ ] §4.g Custom Views
- [ ] §4.h Report Center
- [ ] §4.h2 Plans — D9
- [ ] §4.i Admin

## Rule the canvas is held to

It documents what is SHIPPED. An artboard that contradicts the rendered UI
is worse than no artboard, so each board is drawn from the components in
`apps/web/src/widgets/**`, and anything specified-but-unbuilt is labelled
as such rather than drawn as though it exists.

Two places the shipped UI has already outgrown UX_SPEC §4, both recorded on
the canvas as sticky notes:

- **Org Overview carries more than §4.a sketches** — Weekly pulse (pinned
  top), Improvement plan (D9), Security rollup, Top risks and Risk axes were
  all added after the spec. The health tiles ship *without* the sparkline
  §4.a drew: name, badge and basis only.
- **Repo Detail ships seven tabs, not five** — Security (W8) and Code Health
  (W9) came later. `widgets/code-health/` currently holds only
  `contracts.ts`, so that tab's content is spec, not shipped code.
- **PR Detail diverges most.** §4.c drew a horizontal stage bar, risk badges, a
  findings accordion with evidence quotes, per-file hotspot badges and a GitHub
  ↗ link. What ships is a vertical stage list, a size chip, review/checks side
  by side and a plain files table. Its "Automated review" panel is permanently
  empty because Tier-2 (W6) has not run — and per FR-WEB-8 it says *why*
  rather than reading as a clean bill of health.
- **§4.e's "v1.x teaser" line is stale.** The full Findings Explorer shipped in
  W6-04 — six URL-synced filters (the scanner facet driven by the registry, so a
  later wave's scanner becomes filterable with no edit to the screen), bulk
  confirm/dismiss behind a *required* note, and a false-positive-rate widget
  that shows an em dash rather than 0% when nothing has been triaged. What is
  still a teaser is the repo-level Findings **tab**, not this screen.
- **My Focus drops §4.f's personal-cycle-time chart.** Four count tiles stand in
  its place, captioned "not compared to an earlier window" rather than showing a
  delta never computed. The screen keeps identity-unlinked and nothing-to-do as
  distinct states: both render empty, but only one is fixable by the user.
- **File drill-down gained two things the spec never had** — the Intent control
  (Refactor / Supervise / Acknowledged, W6-09) sits first, and the history
  banner reports "last seen" and previous paths without claiming deletion,
  because ingestion cannot tell a deletion from a quiet file. §4.d's "recent
  PRs touching this file" table is **not** shipped.
