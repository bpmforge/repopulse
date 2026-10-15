#!/usr/bin/env bash
# Rules 6 and 7 (W8-03), sourced by validate-arch.sh.
#
# Kept in their own file for one reason: they have to be testable. A rule that
# only ever runs over a clean tree is a rule nobody has seen fire, and a broken
# regex in one passes silently forever. scripts/arch-rules-6-7.test.sh plants
# real violations in a throwaway tree and asserts each rule FAILS on it.
#
# Both take the tree root as $1 so the test can point them somewhere else.

rule6_clone_and_tarball() { # $1 = root -> prints violations, exits nonzero if any
  local root="$1" hits="" scan_dirs
  scan_dirs="$(ls -d "$root"/packages/*/src "$root"/packages/*/sandbox "$root"/apps/*/src 2>/dev/null)"
  [ -z "$scan_dirs" ] && return 0

  # C1a: no clone, anywhere, ever — the command in either argv order
  # (`git clone x`, `execFile('git', ['clone', ...])`) or a library that clones
  # for you. `\bclone\b` rather than `clone`, so lodash cloneDeep is not a
  # violation.
  #
  # Comment-only lines are dropped, on rule 4's precedent: prose naming a thing
  # cannot do it, and a rule that flags the sentence "we never git clone"
  # teaches people to stop writing the sentence.
  #
  # THE FIXTURE FILE IS EXEMPT and nothing else is: arch-rules.test.ts plants
  # these exact strings in a throwaway tree to prove each rule fires. Excluding
  # all test files instead would mean a genuine clone in a test — which really
  # would clone — sails through.
  # shellcheck disable=SC2086
  hits="$(grep -RInE "git.{0,20}\bclone\b|\bclone\b.{0,20}git|simple-git|isomorphic-git|nodegit" $scan_dirs 2>/dev/null \
    | grep -Ev '^[^:]+:[0-9]+:[[:space:]]*(//|/\*|\*|#)' \
    | grep -v 'snapshot/arch-rules.test.ts' || true)"

  # getTarball is callable only from the snapshot service. The forge package
  # DEFINES it (provider port, GitHub/Gitea/GitLab adapters); packages/security
  # CALLS it. Anywhere else, whole-repo source is being pulled outside the one
  # path that extracts under guard and shreds afterwards.
  local tarball_hits
  # shellcheck disable=SC2086
  tarball_hits="$(grep -RIn 'getTarball' $scan_dirs 2>/dev/null \
    | grep -v '/packages/forge/src/' \
    | grep -v '/packages/security/' || true)"

  if [ -n "$hits" ] || [ -n "$tarball_hits" ]; then
    printf '%s\n' "$hits" "$tarball_hits" | grep -v '^$'
    return 1
  fi
  return 0
}

rule7_scan_tool_spawn() { # $1 = root -> prints violations, exits nonzero if any
  local root="$1" hits scan_dirs
  scan_dirs="$(ls -d "$root"/packages/*/src "$root"/apps/*/src 2>/dev/null)"
  [ -z "$scan_dirs" ] && return 0

  # A scan tool spawned outside packages/security/sandbox is a scan tool run
  # outside the profile: with the host network, the host filesystem and this
  # process's environment. The profile is the whole trust boundary (NFR-14).
  # shellcheck disable=SC2086
  hits="$(grep -RInE "(spawn|exec|execFile|execSync|spawnSync)[A-Za-z]*\(\s*['\"](semgrep|gitleaks|trivy|syft|grype|osv-scanner|trufflehog|checkov|shellcheck|hadolint|actionlint|cppcheck|ruff|biome)" $scan_dirs 2>/dev/null \
    | grep -v 'snapshot/arch-rules.test.ts' || true)"

  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
    return 1
  fi
  return 0
}
