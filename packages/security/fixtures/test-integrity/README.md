Test-integrity fixtures (W18-03).

Test files are stored as `*.case.ts` and `case_*.py` so that no test runner
collects them; `src/scanners/anti-slop/test-integrity.test.ts` reads each one
under its real name (`x.case.ts` as `x.test.ts`, `case_x.py` as `test_x.py`).

- `triggering/<rule>/`: every file named like a test must produce findings of
  `test.<rule>`, and only of that rule.
- `clean/`: near misses. No file may produce any finding.
