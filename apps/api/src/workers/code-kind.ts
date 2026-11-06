// W25-16: one answer to "is this test code?" for every step that spends model
// time. W27-01 moved the definition to @repopulse/shared so the scanners in
// packages/* can use it too; this re-export keeps the workers' imports as they
// were.
export { TEST_PATH_PATTERN, isTestPath } from '@repopulse/shared';
