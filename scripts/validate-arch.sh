#!/usr/bin/env bash
# validate-arch.sh — RepoPulse module-boundary law (CLAUDE.md Laws 4/6/7).
# grep/JSON-based; safe on the docs-only repo (rules skip-pass when the tree
# they police does not exist yet). Prints PASS/FAIL per rule; exit 1 on any FAIL.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
FAIL=0
pass() { printf 'PASS  rule %s — %s\n' "$1" "$2"; }
fail() { printf 'FAIL  rule %s — %s\n' "$1" "$2"; FAIL=1; }

pkg_name() { # $1 = package.json path -> workspace package name
  node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name||"")}catch(e){}' "$1" 2>/dev/null
}
dep_names() { # $1 = package.json path -> one dep name per line (deps+devDeps+peer)
  node -e '
    try {
      const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const d = { ...p.dependencies, ...p.devDependencies, ...p.peerDependencies };
      console.log(Object.keys(d).join("\n"));
    } catch (e) {}' "$1" 2>/dev/null
}

# ---- Rule 1: no packages/* may depend on apps/* -----------------------------
R1_BAD=""
APP_NAMES=""
for f in apps/*/package.json; do
  [ -f "$f" ] && APP_NAMES="$APP_NAMES $(pkg_name "$f")"
done
for f in packages/*/package.json; do
  [ -f "$f" ] || continue
  deps="$(dep_names "$f")"
  for app in $APP_NAMES; do
    [ -n "$app" ] && printf '%s\n' "$deps" | grep -qx "$app" && R1_BAD="$R1_BAD $f->$app"
  done
  printf '%s\n' "$deps" | grep -q '^apps/' && R1_BAD="$R1_BAD $f->apps/*"
done
if ls packages/*/package.json >/dev/null 2>&1; then
  [ -z "$R1_BAD" ] && pass 1 "no workspace package depends on apps/*" \
                   || fail 1 "package depends on an app:$R1_BAD"
else
  pass 1 "no packages/* yet (skipped)"
fi

# ---- Rule 2: metrics/analysis/insights/reports must not depend on forge -----
FORGE_NAME="$(pkg_name packages/forge/package.json)"
[ -n "$FORGE_NAME" ] || FORGE_NAME="@repopulse/forge"
R2_BAD=""
R2_SEEN=0
for p in metrics analysis insights reports; do
  f="packages/$p/package.json"
  [ -f "$f" ] || continue
  R2_SEEN=1
  dep_names "$f" | grep -qx "$FORGE_NAME" && R2_BAD="$R2_BAD $p(package.json)"
  if [ -d "packages/$p/src" ]; then
    grep -RIl -E "from ['\"]($FORGE_NAME|@repopulse/forge|packages/forge)" "packages/$p/src" >/dev/null 2>&1 \
      && R2_BAD="$R2_BAD $p(src import)"
  fi
done
if [ "$R2_SEEN" = 1 ]; then
  [ -z "$R2_BAD" ] && pass 2 "metrics/analysis/insights/reports do not depend on forge (they read the DB)" \
                   || fail 2 "forge dependency found in:$R2_BAD"
else
  pass 2 "no metrics/analysis/insights/reports packages yet (skipped)"
fi

# ---- Rule 3: only packages/forge may import octokit -------------------------
SRC_DIRS=""
for d in apps/*/src packages/*/src; do
  [ -d "$d" ] || continue
  case "$d" in packages/forge/*) continue ;; esac
  SRC_DIRS="$SRC_DIRS $d"
done
if [ -n "$SRC_DIRS" ]; then
  # shellcheck disable=SC2086
  R3_HITS="$(grep -RIn -E "(from ['\"]|require\(['\"])@?octokit" $SRC_DIRS 2>/dev/null || true)"
  [ -z "$R3_HITS" ] && pass 3 "octokit imported only inside packages/forge" \
                    || { fail 3 "octokit import outside packages/forge:"; printf '%s\n' "$R3_HITS" | sed 's/^/        /'; }
else
  pass 3 "no src trees outside packages/forge yet (skipped)"
fi

# ---- Rule 4: no forge-host fetches (api.github.com) outside packages/forge --
# Exception (SC-12/AC-4, W1-03): packages/auth/src/oauth/** may reference
# api.github.com for the post-login identity fetch (GET /user with the
# user's own OAuth token). SC-12's SSRF allowlist protects against an
# admin-supplied, attacker-controlled forge base URL (Gitea adapter,
# GitHubProvider's workspace-scoped budgeted client) — this call has no
# variable base URL at all, so that control doesn't apply here. Everything
# else outside packages/forge is still policed.
if [ -n "$SRC_DIRS" ]; then
  # shellcheck disable=SC2086
  # Comment lines are dropped, but only when the marker is the FIRST non-space
  # character on the line — a line that merely CONTAINS `//` is still policed,
  # because `const base = 'https://api.github.com'` contains one and stripping
  # from the first `//` would delete the very hit this rule exists to catch.
  # Prose naming the host cannot issue a request; code naming it can.
  R4_HITS="$(grep -RIn 'api\.github\.com' $SRC_DIRS 2>/dev/null \
    | grep -v '^packages/auth/src/oauth/' \
    | grep -Ev '^[^:]+:[0-9]+:[[:space:]]*(//|/\*|\*|#)' || true)"
  [ -z "$R4_HITS" ] && pass 4 "no api.github.com reference outside packages/forge (packages/auth/src/oauth/** exempted, SC-12/AC-4)" \
                    || { fail 4 "api.github.com referenced outside packages/forge:"; printf '%s\n' "$R4_HITS" | sed 's/^/        /'; }
else
  pass 4 "no src trees outside packages/forge yet (skipped)"
fi

# ---- Rule 5: Drizzle tables carry workspace_id (tenancy invariant) ----------
# Heuristic: every schema file that defines pgTable must mention workspace_id,
# or be explicitly marked "tenancy-exempt" (global tables like user/workspace).
SCHEMA_FILES="$(grep -RIl 'pgTable(' packages/*/src apps/*/src 2>/dev/null || true)"
if [ -n "$SCHEMA_FILES" ]; then
  R5_BAD=""
  for f in $SCHEMA_FILES; do
    grep -q 'workspace_id\|workspaceId' "$f" || grep -q 'tenancy-exempt' "$f" || R5_BAD="$R5_BAD $f"
  done
  [ -z "$R5_BAD" ] && pass 5 "every pgTable schema file carries workspace_id (or is marked tenancy-exempt)" \
                   || fail 5 "pgTable file(s) without workspace_id or tenancy-exempt marker:$R5_BAD"
else
  pass 5 "no Drizzle schema files yet (skipped)"
fi

# ---- Rules 6 & 7: C1a (no clone / tarball only via the snapshot service) and
# ---- NFR-14 (scan tools spawn only inside the sandbox) ----------------------
# Defined in their own file so they can be tested by PLANTING violations — see
# packages/security/src/snapshot/arch-rules.test.ts. A rule nobody has watched
# fire is a rule that passes forever with a broken regex.
# shellcheck source=scripts/arch-rules-6-7.sh
. "$ROOT/scripts/arch-rules-6-7.sh"

R6_HITS="$(rule6_clone_and_tarball "$ROOT")" && R6_OK=1 || R6_OK=0
[ "$R6_OK" = 1 ] && pass 6 "no git clone anywhere; getTarball called only from the snapshot service (C1a)" \
                 || { fail 6 "C1a violation:"; printf '%s\n' "$R6_HITS" | sed 's/^/        /'; }

R7_HITS="$(rule7_scan_tool_spawn "$ROOT")" && R7_OK=1 || R7_OK=0
[ "$R7_OK" = 1 ] && pass 7 "scan tools spawn only inside packages/security/sandbox (NFR-14)" \
                 || { fail 7 "scan tool spawned outside the sandbox:"; printf '%s\n' "$R7_HITS" | sed 's/^/        /'; }

echo
if [ "$FAIL" = 0 ]; then
  echo "validate-arch: all rules PASS"
else
  echo "validate-arch: FAIL — module-boundary violation(s) above"
fi
exit "$FAIL"
