// W25-16: one answer to "is this test code?" for every step that spends model
// time. The first look (W25-09), the judge and a folder review all use it, so
// they agree on what a test is.
//
// The pattern is a plain string so the judge can apply it in Postgres (`!~`)
// as well as here: it uses only syntax both engines read the same way
// (groups, alternation, `[^/]`, `\.`, `?`, anchors), and is case-sensitive in
// both, so `latest.go`, `contest.py` and `Testimonial.tsx` are not tests.

/** Test code by directory or file name, across the languages a pass reads. */
export const TEST_PATH_PATTERN =
  '(^|/)(tests?|__tests__|__mocks__|mocks?|specs?|e2e|testutils?|testing|testdata|fixtures?)/' +
  '|(_test\\.(go|py|rs|exs|dart|c|cc|cpp)|\\.(test|spec)\\.[cm]?[jt]sx?|_spec\\.rb|Tests?\\.(java|kt|kts|cs|swift|scala)|Spec\\.(kt|scala|swift))$' +
  '|(^|/)(test_[^/]*\\.py|conftest\\.py|test_?helpers?\\.[a-z]+|testutils?\\.[a-z]+)$';

const TEST_PATH = new RegExp(TEST_PATH_PATTERN);

/** True for a repository-relative path that is test code (a leading "./" is ignored). */
export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path.replace(/^\.?\/+/, ''));
}
