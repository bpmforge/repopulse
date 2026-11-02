# W24 screens: before and after (2026-11-02)

Whole-page pictures of the four screens the UX review flagged, light and dark, from the
cloud dev stack with the seeded fixture workspace. `before/` is main at 273dfdd0 (taken
with axe off, because the Security tab failed axe `link-in-text-block` before W24-05);
`after/` is this wave, axe-clean in both themes.

Regenerate (opt-in, because the spec seeds rows and removes them again):

```bash
E2E_UX24_TOUR=1 pnpm e2e e2e/ux-w24-tour.spec.ts            # writes after/
E2E_UX24_TOUR=1 UX24_OUT=docs/screenshots/w24/before pnpm e2e e2e/ux-w24-tour.spec.ts
```

| # | Screen | Finding | What changed |
|---|---|---|---|
| 01 | Models, no connection | wizard above a duplicate Models form | The wizard is the page; the by-hand form is folded behind Advanced inside it |
| 02 | Models, two connections | same, plus cryptic routing rows and a cramped quality table | Configured providers first, setup folded; shared pool described once; quality table turned to a row per role |
| 03 | Security tab | AI panel buried | One line points to the new AI review tab |
| 04 | AI review tab (new) | AI panel buried | The AI review pass and its schedule, at the top of their own tab (no before picture: the tab did not exist) |
