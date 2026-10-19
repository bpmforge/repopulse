# AI layer screens (W19-10, W19-11, W19-12)

Pictures of the AI review pass panel, the scheduled-passes section and the finding
drawer's AI suggestions, each in the **dark** and **light** theme, plus the schedule form
and a suggestion at **375 px** (phone). The data is made up for the pictures.

Regenerate them (they are opt-in, because the spec seeds rows and removes them again):

```bash
E2E_AI_TOUR=1 pnpm e2e e2e/ai-ui-tour.spec.ts
```

The same run asserts **axe-clean** on every state and **no sideways scroll at 375 px**.

| # | Screen |
|---|---|
| 01 | AI review pass panel before any pass has run: "Not yet run", schedule off |
| 02 | Enable form, models on your network |
| 03 | Enable form, a hosted model would receive source (the acknowledgement is required) |
| 04 | A schedule that is on |
| 05 | A schedule whose routing changed since it was acknowledged: not running, said loudly |
| 06 | Pass history: a path pass, a pull-request pass, a failed commit range, and the refused scheduled run |
| 07 | Finding drawer, no AI review recorded ("Not yet run") |
| 08 | Finding drawer, an open AI suggestion with citation, route and the pass it came from |
| 09 | Finding drawer, an accepted false-positive suggestion: the finding is still open and dismissing is offered, not done |
| 10 | Finding drawer, a finding raised by an AI specialist |
| 11, 12 | Phone width: the schedule form, and a suggestion |
