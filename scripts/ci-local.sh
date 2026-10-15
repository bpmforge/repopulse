#!/usr/bin/env bash
# The CI gate, run on this machine.
#
# GitHub Actions is not enabled for this repository (docs/STATUS.md, W14-03:
# "GitHub should be repo storage only"), and the Gitea runner that
# .gitea/workflows/gate.yaml is written for does not exist yet. Until it does,
# this script IS the CI: it runs every step of both jobs in
# .github/workflows/ci.yml, in the same order, with the same flags. A step
# added there must be added here; two definitions of "the gate passed" that
# drift are worse than one.
#
# Differences from the hosted job, all deliberate:
#   - Postgres and Redis come from .env (scripts/dev-up.sh), not job services.
#     REQUIRE_LIVE_INFRA=1 still makes a missing data tier FAIL, not skip.
#   - Every step runs even after one fails, and a summary lists each one. A
#     hosted job stops at the first red step; locally it is cheaper to see
#     all of them in one pass.
#   - osv-scanner and gitleaks are used from PATH when present; otherwise the
#     pinned release is downloaded once, checksum-verified, into
#     ${XDG_CACHE_HOME:-$HOME/.cache}/repopulse-ci. When api.osv.dev is
#     blocked, osv-scanner retries once against its offline database.
#     --no-supply-chain skips both and says so in the summary.
#
# Usage: scripts/ci-local.sh [--no-supply-chain] [--no-install]
# Exit code: 0 only when every step that ran passed.

set -uo pipefail

OSV_SCANNER_VERSION=2.4.0
GITLEAKS_VERSION=8.30.1

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

supply_chain=1
install=1
for arg in "$@"; do
  case "$arg" in
    --no-supply-chain) supply_chain=0 ;;
    --no-install) install=0 ;;
    -h | --help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

export REQUIRE_LIVE_INFRA=1
cache="${XDG_CACHE_HOME:-$HOME/.cache}/repopulse-ci"
log_dir="$(mktemp -d "${TMPDIR:-/tmp}/repopulse-ci.XXXXXX")"
names=()
results=()

step() {
  local name="$1"
  shift
  local log="$log_dir/$(printf '%02d' "${#names[@]}").log"
  printf '== %s\n' "$name"
  local start=$SECONDS
  if "$@" >"$log" 2>&1; then
    results+=("pass  $(printf '%4ss' $((SECONDS - start)))  $name")
  else
    results+=("FAIL  $(printf '%4ss' $((SECONDS - start)))  $name   (log: $log)")
    tail -n 30 "$log" | sed 's/^/   | /'
  fi
  names+=("$name")
}

skipped() {
  results+=("skip         $1")
  names+=("$1")
}

# Downloads a pinned release asset and checks it against the release's own
# checksum file, the same way the hosted job does. Prints the binary path.
fetch_tool() {
  local tool="$1" version="$2" asset="$3" sums="$4" member="$5"
  local dir="$cache/$tool-$version"
  if [ -x "$dir/$tool" ]; then echo "$dir/$tool"; return 0; fi
  mkdir -p "$dir"
  (
    cd "$dir" || exit 1
    curl -sSfL "$asset" -o "$(basename "$asset")" &&
      curl -sSfL "$sums" -o sums.txt &&
      grep " $(basename "$asset")\$" sums.txt | sha256sum -c - >/dev/null &&
      if [ -n "$member" ]; then tar -xzf "$(basename "$asset")" "$member"; else mv "$(basename "$asset")" "$tool"; fi &&
      chmod +x "$tool"
  ) >&2 || { rm -rf "$dir"; return 1; }
  echo "$dir/$tool"
}

npmrc_baseline() {
  grep -qx 'ignore-scripts=true' .npmrc || { echo ".npmrc missing ignore-scripts=true"; return 1; }
  node -e "const p=require('./package.json'); if (!p.pnpm || !Array.isArray(p.pnpm.onlyBuiltDependencies)) { console.error('package.json missing pnpm.onlyBuiltDependencies array'); process.exit(1); }"
}

osv_scan() {
  local bin
  bin="$(command -v osv-scanner || fetch_tool osv-scanner "$OSV_SCANNER_VERSION" \
    "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_amd64" \
    "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_SHA256SUMS" "")" || {
    echo "osv-scanner is not on PATH and the pinned release could not be downloaded"; return 1; }
  "$bin" scan source --lockfile=pnpm-lock.yaml
  local rc=$?
  # 127 is osv-scanner's "could not get an answer" (1 means vulnerabilities
  # found). Networks that block api.osv.dev often still allow the bulk
  # database bucket, so retry once against a local copy of the database and
  # say so, rather than reporting a network error as a clean bill.
  if [ "$rc" = 127 ]; then
    echo "api.osv.dev unreachable; retrying against the offline database"
    OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY="$cache/osv-db" \
      "$bin" scan source --offline-vulnerabilities --download-offline-databases --lockfile=pnpm-lock.yaml
    rc=$?
  fi
  return "$rc"
}

gitleaks_scan() {
  local bin
  bin="$(command -v gitleaks || fetch_tool gitleaks "$GITLEAKS_VERSION" \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_checksums.txt" gitleaks)" || {
    echo "gitleaks is not on PATH and the pinned release could not be downloaded"; return 1; }
  "$bin" detect --source . --log-opts="--all" --redact
}

echo "RepoPulse local CI at $(git rev-parse --short HEAD)$(git diff --quiet HEAD || echo ' (uncommitted changes present)')"

# --- job: lint / typecheck / test / validators ---
if [ "$install" = 1 ]; then
  step "install" pnpm install --frozen-lockfile --prefer-offline
else
  skipped "install (--no-install)"
fi
step "migrate" pnpm db:migrate
step "lint" pnpm lint
step "typecheck" pnpm typecheck
step "test" pnpm test
step "check:bundle (initial JS <= 200KB gz)" pnpm check:bundle
step "validate-arch (module boundary law)" bash scripts/validate-arch.sh
step "validate-compose (SC-20 dev data-tier baseline)" bash scripts/validate-compose.sh
step "validate-plan (ticket board schema/deps/gates)" node scripts/validate-plan.mjs
step "validate-traceability (FR/story/doc linkage)" node scripts/validate-traceability.mjs

# --- job: supply chain (SC-18/SC-19) ---
step "assert SC-19 .npmrc baseline" npmrc_baseline
if [ "$supply_chain" = 1 ]; then
  step "dependency audit (SC-19) - osv-scanner" osv_scan
  step "gitleaks (SC-18, history-inclusive)" gitleaks_scan
else
  skipped "dependency audit (SC-19) - osv-scanner (--no-supply-chain)"
  skipped "gitleaks (SC-18) (--no-supply-chain)"
fi

echo
echo "Summary ($(git rev-parse --short HEAD)):"
failed=0
for r in "${results[@]}"; do
  echo "  $r"
  case "$r" in FAIL*) failed=1 ;; esac
done
if [ "$failed" = 0 ]; then echo "PASS"; else echo "FAIL"; fi
exit "$failed"
