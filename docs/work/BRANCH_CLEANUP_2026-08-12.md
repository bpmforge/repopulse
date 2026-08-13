# Branch cleanup — 2026-08-12

Deleted 35 stale remote branches after verifying every one is SUPERSEDED by
`main`, not merely un-merged. Verification method, not assumption:

- `git rev-list --count main..<branch>` showed them "ahead", but by SHA only —
  their work reached `main` through a different merge path.
- `git diff --numstat main..<branch>` was then read line-by-line for the
  largest gaps. Every apparent addition was an OLD version of a file since
  rewritten: e.g. `w4-00-e2e-harness` "adds" `const BASE =
  Date.parse('2026-06-01T00:00:00Z')` — the absolute seeder date W4-13
  replaced with run-time anchoring. Nothing unique was lost.

Restore any branch with: `git push <remote> <sha>:refs/heads/<name>`

| Branch | Remote | SHA |
|---|---|---|
| `feat/w1-03-oauth-sessions` | github | `46fddac091e9836c7c94d727cc4b4e7f40b2222d` |
| `feat/w1-03-oauth-sessions` | origin | `46fddac091e9836c7c94d727cc4b4e7f40b2222d` |
| `feat/w1-04-workspace-rbac-skeleton` | origin | `1007da87a8d0e7bdc8c72eca5e047ee5887ac8b7` |
| `feat/w1-05-forge-core` | origin | `44599179db66f44adf663ad05af1aed5b0593cac` |
| `feat/w1-07-tenancy-isolation` | origin | `2ef3026919427ad270746236b2c91d211f0e7392` |
| `feat/w1-08-api-hardening` | origin | `f05ab65fb3576b8fe927b9c369d528aa5ea0b446` |
| `feat/w1-09-ops-endpoints` | origin | `3d6295aca4847a5a237f43f570bded4433492e36` |
| `feat/w3-01-metrics-engine-core` | origin | `ef4d7eac2eb7832a251206f96a0b3674b4f31467` |
| `feat/w3-02-churn-hotspots` | origin | `c88fecd3d16ec8afdc6c2ce906980c749a27f124` |
| `feat/w3-03-ownership` | origin | `81a8ff3db8f64435c1f11e40606e5b5b2df97fcf` |
| `feat/w3-04-cycle-stages` | origin | `4d8c3c86edad44ff70264abaff6bf1604d588188` |
| `feat/w3-05-review-coverage` | origin | `5e330520f1c04d12f4c83dd35432a2285153d6d7` |
| `feat/w3-06-size-stale` | origin | `e5235b40f2184973e7b2a0f45b42466dea7e69e9` |
| `feat/w3-07-ci-metrics` | origin | `18c355523515de5b04358bdb71d3008b895d568a` |
| `feat/w3-08-issues-releases` | origin | `ca636e1ce49f1bdd551aef446715adfcde1ca6fd` |
| `feat/w3-09-dora` | origin | `4bdf20acff8ad96603bfc547092c3166ab24f0e9` |
| `feat/w3-10-rollups-snapshots-scoped` | origin | `05cb538c063221cad5fa2d7ff371e982be3b2ee7` |
| `w0-04-fixture-recorder` | origin | `a8d21c6ad34277d20a92d2f11c30639a5957a0cc` |
| `w0-05-fixture-repo-seeded` | origin | `8bbe650a7deea6360666a04e3422b1f51f05be2e` |
| `w0-05-github-app-instructions` | origin | `09957e9e7308dbfa00ad271ec890faed8fbb1770` |
| `w0-05-split-fixture-prereq` | origin | `438e247decaef428651733b89891f4ab83006322` |
| `w1-06-github-provider` | origin | `df0aa3509e115d6658af27f29f8476b5f93d78ef` |
| `w2-01-credential-vault` | origin | `20cec5e0ff9f9cea820ece89a80c740401155adf` |
| `w2-02-queue-topology` | origin | `da72ce01f97b4910d130887e00ee9e4408f192a6` |
| `w2-03-backfill-workers` | origin | `94c81433b7320c0c05919146877774d7725c2ecc` |
| `w2-04-webhook-receiver` | origin | `d2e41d07e00b3c7fd7f2ca5c5117a29e0c4132c0` |
| `w2-05-reconciliation` | origin | `322f2ba4519017d1136967248ee2c4e4bcea3961` |
| `w3-10-metrics-compute` | origin | `a5a3d9b0a586285ac4633dfa9a69668e6cb91e24` |
| `w3-11-health-score` | origin | `87933525f894b3b75c4dd77c9f2c974215df85b0` |
| `w3-12-metrics-api` | origin | `82f4f78c3c62d55e2952e0238b2426c5e28208be` |
| `w3-13-retention` | origin | `baa5365f32dcf3557f4391ae09c4e173c32752f4` |
| `w4-00-e2e-harness` | origin | `c1dee6ceee35f05175ae5b614f41b467abab0e5e` |
| `w4-01-drilldown-api` | origin | `0d97b17d8f4b558220c5b3d572da604383b1cc87` |
| `w5-01-saved-views` | origin | `42050b76f8316865b2a598a462f8b1402abcd3fd` |
