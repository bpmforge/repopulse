// GENERATED from docs/benchmarks/report.json by
// `pnpm --filter @repopulse/security starter-set` (starter-set-cli.ts).
// Do not edit by hand: starter-set.test.ts fails when this file and the
// committed report disagree, or when an entry falls below the bar.
import type { StarterSetManifest } from './starter-set.js';

export const STARTER_SET_MANIFEST: StarterSetManifest = {
  "source": "docs/benchmarks/report.json",
  "ticket": "W18-17",
  "measured": {
    "date": "2026-10-16",
    "commit": "e49421c6ccd61c52d3db5034859d1f4fa44a1e16"
  },
  "bar": {
    "minPrecision": 0.8,
    "minTruePositives": 5
  },
  "evidence": [
    {
      "suite": "owasp-benchmark"
    },
    {
      "suite": "juliet-java"
    },
    {
      "suite": "juice-shop"
    },
    {
      "suite": "iac-adapters",
      "trees": [
        "real"
      ]
    }
  ],
  "rules": [
    {
      "ruleId": "bpm-inj-cmd-java",
      "engine": "yaml",
      "dimension": "sast",
      "tp": 77,
      "fp": 17,
      "precision": 0.819,
      "suites": [
        {
          "suite": "juliet-java",
          "tp": 13,
          "fp": 0
        },
        {
          "suite": "owasp-benchmark",
          "tp": 64,
          "fp": 17
        }
      ]
    },
    {
      "ruleId": "bpm-inj-ldap-java",
      "engine": "yaml",
      "dimension": "sast",
      "tp": 37,
      "fp": 7,
      "precision": 0.841,
      "suites": [
        {
          "suite": "juliet-java",
          "tp": 13,
          "fp": 0
        },
        {
          "suite": "owasp-benchmark",
          "tp": 24,
          "fp": 7
        }
      ]
    },
    {
      "ruleId": "bpm-inj-redirect-java",
      "engine": "yaml",
      "dimension": "sast",
      "tp": 16,
      "fp": 0,
      "precision": 1,
      "suites": [
        {
          "suite": "juliet-java",
          "tp": 16,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-inj-sql-java",
      "engine": "yaml",
      "dimension": "sast",
      "tp": 230,
      "fp": 54,
      "precision": 0.81,
      "suites": [
        {
          "suite": "juliet-java",
          "tp": 15,
          "fp": 0
        },
        {
          "suite": "owasp-benchmark",
          "tp": 215,
          "fp": 54
        }
      ]
    },
    {
      "ruleId": "bpm-inj-xpath-java",
      "engine": "yaml",
      "dimension": "sast",
      "tp": 26,
      "fp": 3,
      "precision": 0.897,
      "suites": [
        {
          "suite": "juliet-java",
          "tp": 12,
          "fp": 0
        },
        {
          "suite": "owasp-benchmark",
          "tp": 14,
          "fp": 3
        }
      ]
    },
    {
      "ruleId": "bpm-java-cookie-insecure",
      "engine": "yaml",
      "dimension": "sast",
      "tp": 36,
      "fp": 0,
      "precision": 1,
      "suites": [
        {
          "suite": "owasp-benchmark",
          "tp": 36,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-java-weak-cipher",
      "engine": "yaml",
      "dimension": "sast",
      "tp": 164,
      "fp": 0,
      "precision": 1,
      "suites": [
        {
          "suite": "juliet-java",
          "tp": 34,
          "fp": 0
        },
        {
          "suite": "owasp-benchmark",
          "tp": 130,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-java-weak-hash",
      "engine": "yaml",
      "dimension": "sast",
      "tp": 140,
      "fp": 0,
      "precision": 1,
      "suites": [
        {
          "suite": "juliet-java",
          "tp": 51,
          "fp": 0
        },
        {
          "suite": "owasp-benchmark",
          "tp": 89,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-java-weak-random",
      "engine": "yaml",
      "dimension": "sast",
      "tp": 218,
      "fp": 0,
      "precision": 1,
      "suites": [
        {
          "suite": "owasp-benchmark",
          "tp": 218,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "bpm-js-sql-string-concat",
      "engine": "yaml",
      "dimension": "sast",
      "tp": 6,
      "fp": 0,
      "precision": 1,
      "suites": [
        {
          "suite": "juice-shop",
          "tp": 6,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "tool.hadolint.DL3018",
      "engine": "adapter",
      "dimension": "correctness",
      "tp": 9,
      "fp": 0,
      "precision": 1,
      "suites": [
        {
          "suite": "iac-adapters",
          "trees": [
            "real"
          ],
          "tp": 9,
          "fp": 0
        }
      ]
    },
    {
      "ruleId": "tool.hadolint.DL4006",
      "engine": "adapter",
      "dimension": "correctness",
      "tp": 7,
      "fp": 0,
      "precision": 1,
      "suites": [
        {
          "suite": "iac-adapters",
          "trees": [
            "real"
          ],
          "tp": 7,
          "fp": 0
        }
      ]
    }
  ],
  "belowBar": [
    {
      "ruleId": "bpm-inj-path-java",
      "engine": "yaml",
      "dimension": "sast",
      "tp": 144,
      "fp": 44,
      "precision": 0.766,
      "suites": [
        {
          "suite": "juliet-java",
          "tp": 26,
          "fp": 0
        },
        {
          "suite": "owasp-benchmark",
          "tp": 118,
          "fp": 44
        }
      ]
    },
    {
      "ruleId": "bpm-inj-trust-java",
      "engine": "yaml",
      "dimension": "sast",
      "tp": 72,
      "fp": 20,
      "precision": 0.783,
      "suites": [
        {
          "suite": "owasp-benchmark",
          "tp": 72,
          "fp": 20
        }
      ]
    },
    {
      "ruleId": "bpm-inj-xss-java",
      "engine": "yaml",
      "dimension": "sast",
      "tp": 183,
      "fp": 60,
      "precision": 0.753,
      "suites": [
        {
          "suite": "juliet-java",
          "tp": 34,
          "fp": 0
        },
        {
          "suite": "owasp-benchmark",
          "tp": 149,
          "fp": 60
        }
      ]
    },
    {
      "ruleId": "bpm-java-command-concat",
      "engine": "yaml",
      "dimension": "sast",
      "tp": 46,
      "fp": 159,
      "precision": 0.224,
      "suites": [
        {
          "suite": "juliet-java",
          "tp": 46,
          "fp": 126
        },
        {
          "suite": "owasp-benchmark",
          "tp": 0,
          "fp": 33
        }
      ]
    },
    {
      "ruleId": "bpm-java-sql-string-concat",
      "engine": "yaml",
      "dimension": "sast",
      "tp": 54,
      "fp": 121,
      "precision": 0.309,
      "suites": [
        {
          "suite": "juliet-java",
          "tp": 54,
          "fp": 121
        }
      ]
    }
  ]
};
