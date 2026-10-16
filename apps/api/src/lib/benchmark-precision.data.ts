// GENERATED from docs/benchmarks/report.json by benchmark-precision.test.ts
// (UPDATE_BENCHMARK_BUNDLE=1). Do not edit by hand: the drift test compares
// this file with the committed report and fails when they disagree.
import type { BenchmarkSummary } from './rule-precision.js';

export const BENCHMARK_PRECISION: BenchmarkSummary = {
  "ticket": "W18-17",
  "engine": "semgrep 1.181.0",
  "excludedSuites": [
    {
      "suite": "rule-fixtures",
      "reason": "Each rule was written against its own fixtures, so scoring it there measures nothing."
    }
  ],
  "rules": {
    "bpm-ch-empty-catch": {
      "tp": 2,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes",
        "sampleco"
      ],
      "engine": "yaml"
    },
    "bpm-js-child-process-concat": {
      "tp": 1,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes"
      ],
      "engine": "yaml"
    },
    "bpm-js-eval-dynamic": {
      "tp": 1,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes"
      ],
      "engine": "yaml"
    },
    "bpm-js-jwt-verify-disabled": {
      "tp": 1,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes"
      ],
      "engine": "yaml"
    },
    "bpm-js-math-random-token": {
      "tp": 1,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes"
      ],
      "engine": "yaml"
    },
    "bpm-js-sql-string-concat": {
      "tp": 10,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes",
        "juice-shop",
        "sampleco"
      ],
      "engine": "yaml"
    },
    "bpm-js-weak-hash": {
      "tp": 1,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes"
      ],
      "engine": "yaml"
    },
    "bpm-log-and-rethrow": {
      "tp": 1,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes"
      ],
      "engine": "yaml"
    },
    "bpm-log-console-in-prod": {
      "tp": 1,
      "fp": 1,
      "fn": 0,
      "precision": 0.5,
      "suites": [
        "changes",
        "sampleco"
      ],
      "engine": "yaml"
    },
    "bpm-log-injection": {
      "tp": 1,
      "fp": 1,
      "fn": 0,
      "precision": 0.5,
      "suites": [
        "changes"
      ],
      "engine": "yaml"
    },
    "bpm-log-secret-field": {
      "tp": 1,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes"
      ],
      "engine": "yaml"
    },
    "bpm-perf-await-in-loop": {
      "tp": 1,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes"
      ],
      "engine": "yaml"
    },
    "bpm-perf-orm-call-in-loop": {
      "tp": 0,
      "fp": 0,
      "fn": 1,
      "precision": null,
      "suites": [
        "changes"
      ],
      "engine": "yaml"
    },
    "bpm-perf-sync-io-in-async": {
      "tp": 1,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes"
      ],
      "engine": "yaml"
    },
    "bpm-perf-unbounded-promise-all": {
      "tp": 1,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes"
      ],
      "engine": "yaml"
    },
    "generic-secret-assignment": {
      "tp": 2,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes",
        "juice-shop"
      ],
      "engine": "fast-lane"
    },
    "slop.docstring_inflation": {
      "tp": 1,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes"
      ],
      "engine": "fast-lane"
    },
    "slop.low_logic_density": {
      "tp": 1,
      "fp": 0,
      "fn": 1,
      "precision": 1,
      "suites": [
        "changes"
      ],
      "engine": "fast-lane"
    },
    "slop.phantom_module": {
      "tp": 1,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes"
      ],
      "engine": "fast-lane"
    },
    "slop.phantom_symbol": {
      "tp": 1,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes"
      ],
      "engine": "fast-lane"
    },
    "slop.unused_export": {
      "tp": 1,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "changes"
      ],
      "engine": "fast-lane"
    },
    "stripe-secret-key": {
      "tp": 1,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "sampleco"
      ],
      "engine": "fast-lane"
    }
  },
  "cwes": [],
  "publicSuites": [],
  "measured": {
    "date": null,
    "commit": null
  }
};
