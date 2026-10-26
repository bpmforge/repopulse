// GENERATED from the `brad` column of the HAND_CHECKED_SHEETS by
// `pnpm --filter @repopulse/security hand-checked` (hand-checked-cli.ts).
// Do not edit by hand: hand-checked.test.ts fails when this file and the
// marked sheets disagree, or when an entry falls below the bar.
import type { HandCheckedManifest } from './hand-checked.js';

export const HAND_CHECKED_MANIFEST: HandCheckedManifest = {
  "sources": [
    "docs/benchmarks/perf-hand-check/sheet.csv",
    "docs/benchmarks/perf-hand-check-langs/sheet.csv"
  ],
  "ticket": "W21-20",
  "bar": {
    "minPrecision": 0.8,
    "minTruePositives": 5
  },
  "marked": 627,
  "rules": [
    {
      "ruleId": "bpm-perf-copy-on-append",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 6,
      "fp": 0,
      "small": 9,
      "precision": 1,
      "suites": [
        {
          "suite": "excalidraw/excalidraw",
          "tp": 2,
          "fp": 0
        },
        {
          "suite": "outline/outline",
          "tp": 2,
          "fp": 0
        },
        {
          "suite": "prometheus/prometheus",
          "tp": 2,
          "fp": 0
        },
        {
          "suite": "thingsboard/thingsboard",
          "tp": 0,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-find-by-key-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 5,
      "fp": 0,
      "small": 25,
      "precision": 1,
      "suites": [
        {
          "suite": "immich-app/immich",
          "tp": 0,
          "fp": 0
        },
        {
          "suite": "outline/outline",
          "tp": 1,
          "fp": 0
        },
        {
          "suite": "paperless-ngx/paperless-ngx",
          "tp": 3,
          "fp": 0
        },
        {
          "suite": "thingsboard/thingsboard",
          "tp": 1,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-go-nested-range-join",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 6,
      "fp": 0,
      "small": 15,
      "precision": 1,
      "suites": [
        {
          "suite": "go-gitea/gitea",
          "tp": 5,
          "fp": 0
        },
        {
          "suite": "prometheus/prometheus",
          "tp": 0,
          "fp": 0
        },
        {
          "suite": "traefik/traefik",
          "tp": 1,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-java-contains-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 7,
      "fp": 0,
      "small": 23,
      "precision": 1,
      "suites": [
        {
          "suite": "thingsboard/thingsboard",
          "tp": 7,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-membership-in-list-in-loop-py",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 15,
      "fp": 0,
      "small": 13,
      "precision": 1,
      "suites": [
        {
          "suite": "paperless-ngx/paperless-ngx",
          "tp": 0,
          "fp": 0
        },
        {
          "suite": "saleor/saleor",
          "tp": 7,
          "fp": 0
        },
        {
          "suite": "zulip/zulip",
          "tp": 8,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-sw-find-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 6,
      "fp": 0,
      "small": 23,
      "precision": 1,
      "suites": [
        {
          "suite": "home-assistant/iOS",
          "tp": 2,
          "fp": 0
        },
        {
          "suite": "kickstarter/ios-oss",
          "tp": 0,
          "fp": 0
        },
        {
          "suite": "wikimedia/wikipedia-ios",
          "tp": 4,
          "fp": 0
        }
      ]
    }
  ],
  "notLive": [
    {
      "ruleId": "bpm-perf-await-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 11,
      "fp": 11,
      "small": 8,
      "precision": 0.5,
      "suites": [
        {
          "suite": "immich-app/immich",
          "tp": 6,
          "fp": 6
        },
        {
          "suite": "outline/outline",
          "tp": 4,
          "fp": 5
        },
        {
          "suite": "thingsboard/thingsboard",
          "tp": 1,
          "fp": 0
        },
        {
          "suite": "zulip/zulip",
          "tp": 0,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-await-in-loop-py",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 0,
      "fp": 2,
      "small": 2,
      "precision": 0,
      "suites": [
        {
          "suite": "immich-app/immich",
          "tp": 0,
          "fp": 0
        },
        {
          "suite": "saleor/saleor",
          "tp": 0,
          "fp": 0
        },
        {
          "suite": "zulip/zulip",
          "tp": 0,
          "fp": 2
        }
      ]
    },
    {
      "ruleId": "bpm-perf-find-by-key-in-loop-py",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 0,
      "fp": 0,
      "small": 2,
      "precision": 0,
      "suites": [
        {
          "suite": "paperless-ngx/paperless-ngx",
          "tp": 0,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-go-contains-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 0,
      "fp": 0,
      "small": 23,
      "precision": 0,
      "suites": [
        {
          "suite": "go-gitea/gitea",
          "tp": 0,
          "fp": 0
        },
        {
          "suite": "prometheus/prometheus",
          "tp": 0,
          "fp": 0
        },
        {
          "suite": "traefik/traefik",
          "tp": 0,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-go-db-call-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 2,
      "fp": 0,
      "small": 6,
      "precision": 1,
      "suites": [
        {
          "suite": "go-gitea/gitea",
          "tp": 2,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-go-defer-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 1,
      "fp": 11,
      "small": 3,
      "precision": 0.083,
      "suites": [
        {
          "suite": "go-gitea/gitea",
          "tp": 1,
          "fp": 7
        },
        {
          "suite": "prometheus/prometheus",
          "tp": 0,
          "fp": 4
        },
        {
          "suite": "traefik/traefik",
          "tp": 0,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-go-prepend-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 0,
      "fp": 1,
      "small": 0,
      "precision": 0,
      "suites": [
        {
          "suite": "prometheus/prometheus",
          "tp": 0,
          "fp": 1
        }
      ]
    },
    {
      "ruleId": "bpm-perf-go-regex-compile-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 0,
      "fp": 7,
      "small": 0,
      "precision": 0,
      "suites": [
        {
          "suite": "go-gitea/gitea",
          "tp": 0,
          "fp": 2
        },
        {
          "suite": "prometheus/prometheus",
          "tp": 0,
          "fp": 1
        },
        {
          "suite": "traefik/traefik",
          "tp": 0,
          "fp": 4
        }
      ]
    },
    {
      "ruleId": "bpm-perf-go-string-concat-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 0,
      "fp": 9,
      "small": 21,
      "precision": 0,
      "suites": [
        {
          "suite": "go-gitea/gitea",
          "tp": 0,
          "fp": 7
        },
        {
          "suite": "prometheus/prometheus",
          "tp": 0,
          "fp": 1
        },
        {
          "suite": "traefik/traefik",
          "tp": 0,
          "fp": 1
        }
      ]
    },
    {
      "ruleId": "bpm-perf-includes-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 5,
      "fp": 0,
      "small": 25,
      "precision": 1,
      "suites": [
        {
          "suite": "excalidraw/excalidraw",
          "tp": 2,
          "fp": 0
        },
        {
          "suite": "go-gitea/gitea",
          "tp": 0,
          "fp": 0
        },
        {
          "suite": "outline/outline",
          "tp": 2,
          "fp": 0
        },
        {
          "suite": "paperless-ngx/paperless-ngx",
          "tp": 0,
          "fp": 0
        },
        {
          "suite": "prometheus/prometheus",
          "tp": 1,
          "fp": 0
        },
        {
          "suite": "thingsboard/thingsboard",
          "tp": 0,
          "fp": 0
        },
        {
          "suite": "zulip/zulip",
          "tp": 0,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-java-db-call-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 7,
      "fp": 13,
      "small": 10,
      "precision": 0.35,
      "suites": [
        {
          "suite": "thingsboard/thingsboard",
          "tp": 7,
          "fp": 13
        }
      ]
    },
    {
      "ruleId": "bpm-perf-java-find-by-key-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 1,
      "fp": 1,
      "small": 9,
      "precision": 0.5,
      "suites": [
        {
          "suite": "thingsboard/thingsboard",
          "tp": 1,
          "fp": 1
        }
      ]
    },
    {
      "ruleId": "bpm-perf-java-regex-compile-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 0,
      "fp": 0,
      "small": 1,
      "precision": 0,
      "suites": [
        {
          "suite": "thingsboard/thingsboard",
          "tp": 0,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-java-remove-front-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 0,
      "fp": 1,
      "small": 1,
      "precision": 0,
      "suites": [
        {
          "suite": "thingsboard/thingsboard",
          "tp": 0,
          "fp": 1
        }
      ]
    },
    {
      "ruleId": "bpm-perf-java-string-concat-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 2,
      "fp": 10,
      "small": 13,
      "precision": 0.167,
      "suites": [
        {
          "suite": "thingsboard/thingsboard",
          "tp": 2,
          "fp": 10
        }
      ]
    },
    {
      "ruleId": "bpm-perf-json-deep-clone",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 1,
      "fp": 3,
      "small": 2,
      "precision": 0.25,
      "suites": [
        {
          "suite": "excalidraw/excalidraw",
          "tp": 1,
          "fp": 0
        },
        {
          "suite": "outline/outline",
          "tp": 0,
          "fp": 3
        },
        {
          "suite": "thingsboard/thingsboard",
          "tp": 0,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-kt-db-call-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 0,
      "fp": 0,
      "small": 2,
      "precision": 0,
      "suites": [
        {
          "suite": "thunderbird/thunderbird-android",
          "tp": 0,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-kt-find-by-key-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 1,
      "fp": 0,
      "small": 8,
      "precision": 1,
      "suites": [
        {
          "suite": "immich-app/immich",
          "tp": 0,
          "fp": 0
        },
        {
          "suite": "mihonapp/mihon",
          "tp": 1,
          "fp": 0
        },
        {
          "suite": "thunderbird/thunderbird-android",
          "tp": 0,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-kt-regex-compile-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 2,
      "fp": 0,
      "small": 0,
      "precision": 1,
      "suites": [
        {
          "suite": "thunderbird/thunderbird-android",
          "tp": 2,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-orm-call-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 8,
      "fp": 20,
      "small": 2,
      "precision": 0.286,
      "suites": [
        {
          "suite": "go-gitea/gitea",
          "tp": 0,
          "fp": 1
        },
        {
          "suite": "immich-app/immich",
          "tp": 4,
          "fp": 9
        },
        {
          "suite": "outline/outline",
          "tp": 4,
          "fp": 2
        },
        {
          "suite": "thingsboard/thingsboard",
          "tp": 0,
          "fp": 5
        },
        {
          "suite": "zulip/zulip",
          "tp": 0,
          "fp": 3
        }
      ]
    },
    {
      "ruleId": "bpm-perf-orm-call-in-loop-py",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 2,
      "fp": 13,
      "small": 15,
      "precision": 0.133,
      "suites": [
        {
          "suite": "paperless-ngx/paperless-ngx",
          "tp": 0,
          "fp": 3
        },
        {
          "suite": "saleor/saleor",
          "tp": 1,
          "fp": 8
        },
        {
          "suite": "zulip/zulip",
          "tp": 1,
          "fp": 2
        }
      ]
    },
    {
      "ruleId": "bpm-perf-pop-front-in-loop-py",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 0,
      "fp": 1,
      "small": 2,
      "precision": 0,
      "suites": [
        {
          "suite": "saleor/saleor",
          "tp": 0,
          "fp": 0
        },
        {
          "suite": "zulip/zulip",
          "tp": 0,
          "fp": 1
        }
      ]
    },
    {
      "ruleId": "bpm-perf-regex-compile-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 2,
      "fp": 17,
      "small": 0,
      "precision": 0.105,
      "suites": [
        {
          "suite": "outline/outline",
          "tp": 2,
          "fp": 10
        },
        {
          "suite": "thingsboard/thingsboard",
          "tp": 0,
          "fp": 4
        },
        {
          "suite": "zulip/zulip",
          "tp": 0,
          "fp": 3
        }
      ]
    },
    {
      "ruleId": "bpm-perf-rs-blocking-in-async",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 3,
      "fp": 4,
      "small": 13,
      "precision": 0.429,
      "suites": [
        {
          "suite": "atuinsh/atuin",
          "tp": 1,
          "fp": 4
        },
        {
          "suite": "lldap/lldap",
          "tp": 2,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-rs-db-call-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 2,
      "fp": 0,
      "small": 1,
      "precision": 1,
      "suites": [
        {
          "suite": "atuinsh/atuin",
          "tp": 2,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-rs-find-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 2,
      "fp": 3,
      "small": 8,
      "precision": 0.4,
      "suites": [
        {
          "suite": "atuinsh/atuin",
          "tp": 2,
          "fp": 3
        }
      ]
    },
    {
      "ruleId": "bpm-perf-rs-remove-front-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 0,
      "fp": 1,
      "small": 1,
      "precision": 0,
      "suites": [
        {
          "suite": "atuinsh/atuin",
          "tp": 0,
          "fp": 1
        }
      ]
    },
    {
      "ruleId": "bpm-perf-string-concat-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 2,
      "fp": 5,
      "small": 23,
      "precision": 0.286,
      "suites": [
        {
          "suite": "excalidraw/excalidraw",
          "tp": 0,
          "fp": 1
        },
        {
          "suite": "go-gitea/gitea",
          "tp": 0,
          "fp": 0
        },
        {
          "suite": "outline/outline",
          "tp": 0,
          "fp": 0
        },
        {
          "suite": "thingsboard/thingsboard",
          "tp": 2,
          "fp": 2
        },
        {
          "suite": "zulip/zulip",
          "tp": 0,
          "fp": 2
        }
      ]
    },
    {
      "ruleId": "bpm-perf-string-concat-in-loop-py",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 1,
      "fp": 8,
      "small": 21,
      "precision": 0.111,
      "suites": [
        {
          "suite": "saleor/saleor",
          "tp": 0,
          "fp": 1
        },
        {
          "suite": "zulip/zulip",
          "tp": 1,
          "fp": 7
        }
      ]
    },
    {
      "ruleId": "bpm-perf-sw-fetch-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 1,
      "fp": 1,
      "small": 6,
      "precision": 0.5,
      "suites": [
        {
          "suite": "wikimedia/wikipedia-ios",
          "tp": 1,
          "fp": 1
        }
      ]
    },
    {
      "ruleId": "bpm-perf-sw-remove-front-in-loop",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 1,
      "fp": 0,
      "small": 4,
      "precision": 1,
      "suites": [
        {
          "suite": "home-assistant/iOS",
          "tp": 0,
          "fp": 0
        },
        {
          "suite": "wikimedia/wikipedia-ios",
          "tp": 1,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-sync-io-in-async",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 0,
      "fp": 12,
      "small": 0,
      "precision": 0,
      "suites": [
        {
          "suite": "go-gitea/gitea",
          "tp": 0,
          "fp": 2
        },
        {
          "suite": "immich-app/immich",
          "tp": 0,
          "fp": 4
        },
        {
          "suite": "outline/outline",
          "tp": 0,
          "fp": 3
        },
        {
          "suite": "thingsboard/thingsboard",
          "tp": 0,
          "fp": 3
        }
      ]
    },
    {
      "ruleId": "bpm-perf-unbounded-gather-py",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 0,
      "fp": 0,
      "small": 1,
      "precision": 0,
      "suites": [
        {
          "suite": "zulip/zulip",
          "tp": 0,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-perf-unbounded-promise-all",
      "engine": "yaml",
      "dimension": "performance",
      "tp": 5,
      "fp": 4,
      "small": 21,
      "precision": 0.556,
      "suites": [
        {
          "suite": "excalidraw/excalidraw",
          "tp": 0,
          "fp": 1
        },
        {
          "suite": "immich-app/immich",
          "tp": 4,
          "fp": 1
        },
        {
          "suite": "outline/outline",
          "tp": 1,
          "fp": 2
        }
      ]
    }
  ]
};
