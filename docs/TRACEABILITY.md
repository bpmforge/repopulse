# RepoPulse — Traceability

How a requirement travels from founding decision to shipped ticket. Rather
than a 72-row matrix that rots, this doc records the **chain** and where
each link lives; validators + PR discipline keep the links honest.

## The chain

```
FOUNDING_BRIEF (D1-D7, C1-C3, P1-P4)
  → SCOPE.md (S-x)  /  NON_GOALS.md (N-x)  /  RISKS.md (R-x)
    → SRS.md (FR-<MODULE>-n, NFR-n)          ← each FR cites its D/C origin
      → USER_STORIES.md (E1-E10 stories)     ← each story lists FR/NFR IDs
        → plan.json tickets (W0-W8)          ← acceptance cites design-doc sections
          → docs/design/* + UX_SPEC.md       ← the spec the ticket implements
            → commits `feat(Wx-nn): ...`     ← ticket id in every commit message
```

## Epic → wave → module map

| Epic | Theme | Wave(s) | Module(s) |
|------|-------|---------|-----------|
| E1 | Connect + ingest | W1-W2 | forge, ingest, auth |
| E2 | Tier-1 metrics | W3 | metrics, insights |
| E3 | Dashboard shell + drill-down | W4 | web, api |
| E4 | Custom views + sharing | W5 | web, api |
| E5 | Report center + PDF | W5 | reports, web |
| E6 | Tier-2 local LLM review | W6 | analysis, insights, web |
| E7 | Tier-3 + escalation | W7 | analysis |
| E8 | Gitea adapter | W7 | forge |
| E9 | Admin / ops | W2, W4, W7 | auth, api, web, deploy |
| E10 | Security suite | W8 | security, web, reports, deploy |

## Verification of the chain

- `scripts/validate-plan.mjs` — board schema, dep graph, wave gates.
- `scripts/validate-arch.sh` — module-boundary laws from CLAUDE.md.
- PR rule (PLAYBOOK): commit message carries the ticket id; ticket acceptance
  carries the doc section; the doc section carries the FR id. A change with
  no traceable ticket is a process defect (Gap→Gate rule).
- Security: THREAT_MODEL.md T-x ↔ SECURITY_CONTROLS.md SC-x coverage map is
  maintained inside SECURITY_CONTROLS.md; SC verification methods name the
  wave/module where each control lands.

## Known deliberate gaps (v1)

- N-x non-goals have no downstream artifacts by definition.
- v1.x-priority FRs (Gitea adapter, email/Slack delivery, complexity-proxy
  hotspot v2) trace to W7+ or to SCOPE §v1.x with no tickets yet — added at
  reflow when their wave opens.
