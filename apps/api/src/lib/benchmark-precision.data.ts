// GENERATED from docs/benchmarks/report.json by benchmark-precision.test.ts
// (UPDATE_BENCHMARK_BUNDLE=1). Do not edit by hand: the drift test compares
// this file with the committed report and fails when they disagree.
import type { BenchmarkSummary } from './rule-precision.js';

export const BENCHMARK_PRECISION: BenchmarkSummary = {
  "ticket": "W18-17",
  "engine": "opengrep 1.27.1",
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
    "bpm-inj-cmd-java": {
      "tp": 47,
      "fp": 19,
      "fn": 0,
      "precision": 0.712,
      "suites": [
        "juliet-java",
        "owasp-benchmark"
      ],
      "engine": "yaml"
    },
    "bpm-inj-redirect-java": {
      "tp": 15,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "juliet-java"
      ],
      "engine": "yaml"
    },
    "bpm-inj-sql-java": {
      "tp": 122,
      "fp": 89,
      "fn": 0,
      "precision": 0.578,
      "suites": [
        "juliet-java",
        "owasp-benchmark"
      ],
      "engine": "yaml"
    },
    "bpm-inj-xss-java": {
      "tp": 134,
      "fp": 62,
      "fn": 0,
      "precision": 0.684,
      "suites": [
        "juliet-java",
        "owasp-benchmark"
      ],
      "engine": "yaml"
    },
    "bpm-java-command-concat": {
      "tp": 55,
      "fp": 153,
      "fn": 0,
      "precision": 0.264,
      "suites": [
        "juliet-java",
        "owasp-benchmark"
      ],
      "engine": "yaml"
    },
    "bpm-java-sql-string-concat": {
      "tp": 195,
      "fp": 332,
      "fn": 0,
      "precision": 0.37,
      "suites": [
        "juliet-java",
        "owasp-benchmark"
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
  "cwes": [
    {
      "suite": "juliet-java",
      "cwe": 78,
      "tp": 56,
      "fp": 120,
      "fn": 38,
      "tn": 58,
      "tpr": 0.596,
      "fpr": 0.674,
      "youden": -0.078
    },
    {
      "suite": "juliet-java",
      "cwe": 79,
      "tp": 28,
      "fp": 0,
      "fn": 254,
      "tn": 546,
      "tpr": 0.099,
      "fpr": 0,
      "youden": 0.099
    },
    {
      "suite": "juliet-java",
      "cwe": 89,
      "tp": 52,
      "fp": 126,
      "fn": 49,
      "tn": 264,
      "tpr": 0.515,
      "fpr": 0.323,
      "youden": 0.192
    },
    {
      "suite": "juliet-java",
      "cwe": 90,
      "tp": 0,
      "fp": 0,
      "fn": 94,
      "tn": 178,
      "tpr": 0,
      "fpr": 0,
      "youden": 0
    },
    {
      "suite": "juliet-java",
      "cwe": 259,
      "tp": 0,
      "fp": 0,
      "fn": 93,
      "tn": 178,
      "tpr": 0,
      "fpr": 0,
      "youden": 0
    },
    {
      "suite": "juliet-java",
      "cwe": 327,
      "tp": 0,
      "fp": 0,
      "fn": 34,
      "tn": 60,
      "tpr": 0,
      "fpr": 0,
      "youden": 0
    },
    {
      "suite": "juliet-java",
      "cwe": 328,
      "tp": 0,
      "fp": 0,
      "fn": 51,
      "tn": 90,
      "tpr": 0,
      "fpr": 0,
      "youden": 0
    },
    {
      "suite": "juliet-java",
      "cwe": 601,
      "tp": 15,
      "fp": 0,
      "fn": 80,
      "tn": 181,
      "tpr": 0.158,
      "fpr": 0,
      "youden": 0.158
    },
    {
      "suite": "juliet-java",
      "cwe": 643,
      "tp": 0,
      "fp": 0,
      "fn": 90,
      "tn": 360,
      "tpr": 0,
      "fpr": 0,
      "youden": 0
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 22,
      "tp": 0,
      "fp": 0,
      "fn": 133,
      "tn": 135,
      "tpr": 0,
      "fpr": 0,
      "youden": 0
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 78,
      "tp": 46,
      "fp": 52,
      "fn": 80,
      "tn": 83,
      "tpr": 0.365,
      "fpr": 0.385,
      "youden": -0.02
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 79,
      "tp": 106,
      "fp": 62,
      "fn": 140,
      "tn": 147,
      "tpr": 0.431,
      "fpr": 0.297,
      "youden": 0.134
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 89,
      "tp": 265,
      "fp": 295,
      "fn": 7,
      "tn": 12,
      "tpr": 0.974,
      "fpr": 0.961,
      "youden": 0.013
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 90,
      "tp": 0,
      "fp": 0,
      "fn": 27,
      "tn": 32,
      "tpr": 0,
      "fpr": 0,
      "youden": 0
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 327,
      "tp": 0,
      "fp": 0,
      "fn": 130,
      "tn": 116,
      "tpr": 0,
      "fpr": 0,
      "youden": 0
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 328,
      "tp": 0,
      "fp": 0,
      "fn": 129,
      "tn": 107,
      "tpr": 0,
      "fpr": 0,
      "youden": 0
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 330,
      "tp": 0,
      "fp": 0,
      "fn": 218,
      "tn": 275,
      "tpr": 0,
      "fpr": 0,
      "youden": 0
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 501,
      "tp": 0,
      "fp": 0,
      "fn": 83,
      "tn": 43,
      "tpr": 0,
      "fpr": 0,
      "youden": 0
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 614,
      "tp": 0,
      "fp": 0,
      "fn": 36,
      "tn": 31,
      "tpr": 0,
      "fpr": 0,
      "youden": 0
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 643,
      "tp": 0,
      "fp": 0,
      "fn": 15,
      "tn": 20,
      "tpr": 0,
      "fpr": 0,
      "youden": 0
    }
  ],
  "publicSuites": [
    {
      "id": "juliet-java",
      "title": "Juliet Test Suite for Java v1.3 (subset)"
    },
    {
      "id": "owasp-benchmark",
      "title": "OWASP Benchmark (Java) v1.2"
    }
  ],
  "measured": {
    "date": "2026-10-16",
    "commit": "a7d15eadba0b90a56197c2753bbb0b7c4cfeb72f"
  }
};
