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
      "tp": 77,
      "fp": 17,
      "fn": 0,
      "precision": 0.819,
      "suites": [
        "juliet-java",
        "owasp-benchmark"
      ],
      "engine": "yaml"
    },
    "bpm-inj-ldap-java": {
      "tp": 37,
      "fp": 7,
      "fn": 0,
      "precision": 0.841,
      "suites": [
        "juliet-java",
        "owasp-benchmark"
      ],
      "engine": "yaml"
    },
    "bpm-inj-path-java": {
      "tp": 118,
      "fp": 44,
      "fn": 0,
      "precision": 0.728,
      "suites": [
        "owasp-benchmark"
      ],
      "engine": "yaml"
    },
    "bpm-inj-redirect-java": {
      "tp": 16,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "juliet-java"
      ],
      "engine": "yaml"
    },
    "bpm-inj-sql-java": {
      "tp": 230,
      "fp": 54,
      "fn": 0,
      "precision": 0.81,
      "suites": [
        "juliet-java",
        "owasp-benchmark"
      ],
      "engine": "yaml"
    },
    "bpm-inj-trust-java": {
      "tp": 72,
      "fp": 20,
      "fn": 0,
      "precision": 0.783,
      "suites": [
        "owasp-benchmark"
      ],
      "engine": "yaml"
    },
    "bpm-inj-xpath-java": {
      "tp": 26,
      "fp": 3,
      "fn": 0,
      "precision": 0.897,
      "suites": [
        "juliet-java",
        "owasp-benchmark"
      ],
      "engine": "yaml"
    },
    "bpm-inj-xss-java": {
      "tp": 183,
      "fp": 60,
      "fn": 0,
      "precision": 0.753,
      "suites": [
        "juliet-java",
        "owasp-benchmark"
      ],
      "engine": "yaml"
    },
    "bpm-java-command-concat": {
      "tp": 46,
      "fp": 159,
      "fn": 0,
      "precision": 0.224,
      "suites": [
        "juliet-java",
        "owasp-benchmark"
      ],
      "engine": "yaml"
    },
    "bpm-java-cookie-insecure": {
      "tp": 36,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "owasp-benchmark"
      ],
      "engine": "yaml"
    },
    "bpm-java-sql-string-concat": {
      "tp": 54,
      "fp": 121,
      "fn": 0,
      "precision": 0.309,
      "suites": [
        "juliet-java"
      ],
      "engine": "yaml"
    },
    "bpm-java-weak-cipher": {
      "tp": 164,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "juliet-java",
        "owasp-benchmark"
      ],
      "engine": "yaml"
    },
    "bpm-java-weak-hash": {
      "tp": 140,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
        "juliet-java",
        "owasp-benchmark"
      ],
      "engine": "yaml"
    },
    "bpm-java-weak-random": {
      "tp": 218,
      "fp": 0,
      "fn": 0,
      "precision": 1,
      "suites": [
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
      "tp": 59,
      "fp": 126,
      "fn": 34,
      "tn": 56,
      "tpr": 0.634,
      "fpr": 0.692,
      "youden": -0.058
    },
    {
      "suite": "juliet-java",
      "cwe": 79,
      "tp": 34,
      "fp": 0,
      "fn": 255,
      "tn": 549,
      "tpr": 0.118,
      "fpr": 0,
      "youden": 0.118
    },
    {
      "suite": "juliet-java",
      "cwe": 89,
      "tp": 69,
      "fp": 121,
      "fn": 35,
      "tn": 271,
      "tpr": 0.663,
      "fpr": 0.309,
      "youden": 0.354
    },
    {
      "suite": "juliet-java",
      "cwe": 90,
      "tp": 13,
      "fp": 0,
      "fn": 80,
      "tn": 182,
      "tpr": 0.14,
      "fpr": 0,
      "youden": 0.14
    },
    {
      "suite": "juliet-java",
      "cwe": 259,
      "tp": 0,
      "fp": 0,
      "fn": 95,
      "tn": 186,
      "tpr": 0,
      "fpr": 0,
      "youden": 0
    },
    {
      "suite": "juliet-java",
      "cwe": 327,
      "tp": 34,
      "fp": 0,
      "fn": 0,
      "tn": 60,
      "tpr": 1,
      "fpr": 0,
      "youden": 1
    },
    {
      "suite": "juliet-java",
      "cwe": 328,
      "tp": 51,
      "fp": 0,
      "fn": 0,
      "tn": 90,
      "tpr": 1,
      "fpr": 0,
      "youden": 1
    },
    {
      "suite": "juliet-java",
      "cwe": 601,
      "tp": 16,
      "fp": 0,
      "fn": 81,
      "tn": 184,
      "tpr": 0.165,
      "fpr": 0,
      "youden": 0.165
    },
    {
      "suite": "juliet-java",
      "cwe": 643,
      "tp": 12,
      "fp": 0,
      "fn": 80,
      "tn": 368,
      "tpr": 0.13,
      "fpr": 0,
      "youden": 0.13
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 22,
      "tp": 118,
      "fp": 44,
      "fn": 15,
      "tn": 91,
      "tpr": 0.887,
      "fpr": 0.326,
      "youden": 0.561
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 78,
      "tp": 64,
      "fp": 50,
      "fn": 62,
      "tn": 83,
      "tpr": 0.508,
      "fpr": 0.376,
      "youden": 0.132
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 79,
      "tp": 149,
      "fp": 60,
      "fn": 97,
      "tn": 149,
      "tpr": 0.606,
      "fpr": 0.287,
      "youden": 0.319
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 89,
      "tp": 215,
      "fp": 54,
      "fn": 57,
      "tn": 178,
      "tpr": 0.79,
      "fpr": 0.233,
      "youden": 0.557
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 90,
      "tp": 24,
      "fp": 7,
      "fn": 3,
      "tn": 25,
      "tpr": 0.889,
      "fpr": 0.219,
      "youden": 0.67
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 327,
      "tp": 130,
      "fp": 0,
      "fn": 0,
      "tn": 116,
      "tpr": 1,
      "fpr": 0,
      "youden": 1
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 328,
      "tp": 89,
      "fp": 0,
      "fn": 40,
      "tn": 107,
      "tpr": 0.69,
      "fpr": 0,
      "youden": 0.69
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 330,
      "tp": 218,
      "fp": 0,
      "fn": 0,
      "tn": 275,
      "tpr": 1,
      "fpr": 0,
      "youden": 1
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 501,
      "tp": 72,
      "fp": 20,
      "fn": 11,
      "tn": 23,
      "tpr": 0.867,
      "fpr": 0.465,
      "youden": 0.402
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 614,
      "tp": 36,
      "fp": 0,
      "fn": 0,
      "tn": 31,
      "tpr": 1,
      "fpr": 0,
      "youden": 1
    },
    {
      "suite": "owasp-benchmark",
      "cwe": 643,
      "tp": 14,
      "fp": 3,
      "fn": 1,
      "tn": 17,
      "tpr": 0.933,
      "fpr": 0.15,
      "youden": 0.783
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
    "commit": "bf83839ec1857d9d689727f23673c15f0a19fbc3"
  }
};
