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
| `docs/design/canvas/canvas.json` | Layout: positions, titles, sticky notes |
| `docs/design/canvas/repopulse-ui-canvas.html` | **Generated.** The seeded page that gets published. Never hand-edit it. |

## To update the canvas

Edit the `.dc.html` working files, re-seed a fresh copy, then republish to
the SAME url so the link keeps working:

```
node "<design skill base>/seed-canvas.mjs" \
  --template "<design skill base>/payload.template.html" \
  --out repopulse-ui-canvas.html --title "RepoPulse UI" \
  --artboard Main.dc.html --artboard RepoDetail.dc.html [--artboard …] \
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
- [ ] §4.c PR Detail
- [ ] §4.d File drill-down
- [ ] §4.e Findings Explorer — v1.x, ships as a teaser
- [ ] §4.f My Focus
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
