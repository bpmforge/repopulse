#!/usr/bin/env bash
# validate-compose.sh — SC-20 dev-compose baseline gate (CLAUDE.md Law 9,
# docs/SECURITY_CONTROLS.md SC-20). Asserts security-meaningful properties of
# compose.dev.yaml's data-tier services, not just string presence: cap_drop
# ALL, no-new-privileges, non-root user, requirepass, explicit scram-sha-256,
# and no LAN-reachable port publish. Skip-passes if the file doesn't exist yet.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
FILE="compose.dev.yaml"
FAIL=0
pass() { printf 'PASS  rule %s — %s\n' "$1" "$2"; }
fail() { printf 'FAIL  rule %s — %s\n' "$1" "$2"; FAIL=1; }

if [ ! -f "$FILE" ]; then
  pass "*" "$FILE does not exist yet (skipped)"
  echo
  echo "validate-compose: all rules PASS"
  exit 0
fi

svc_block() { # $1 = service name -> that service's YAML block (until next top-level-ish service or EOF)
  awk -v svc="  $1:" '
    $0 == svc { found=1; print; next }
    found && /^  [a-zA-Z0-9_-]+:$/ { exit }
    found { print }
  ' "$FILE"
}

check_service() {
  local svc="$1"
  local block
  block="$(svc_block "$svc")"

  if [ -z "$block" ]; then
    fail "svc:$svc" "service '$svc' not found in $FILE"
    return
  fi

  # cap_drop: ALL
  if printf '%s\n' "$block" | grep -qE '^\s*-\s*ALL\s*$' && printf '%s\n' "$block" | grep -q 'cap_drop:'; then
    pass "cap_drop:$svc" "cap_drop includes ALL"
  else
    fail "cap_drop:$svc" "no 'cap_drop: [ALL]' found"
  fi

  # no-new-privileges
  if printf '%s\n' "$block" | grep -q 'no-new-privileges:true'; then
    pass "nnp:$svc" "no-new-privileges:true present"
  else
    fail "nnp:$svc" "no-new-privileges:true missing"
  fi

  # non-root user (explicit `user:` line, not root/0)
  local userline
  userline="$(printf '%s\n' "$block" | grep -E '^\s*user:\s*' | head -1)"
  if [ -n "$userline" ] && ! printf '%s' "$userline" | grep -qE ':\s*("?)(root|0)("?)\s*$'; then
    pass "nonroot:$svc" "explicit non-root user ($userline)"
  else
    fail "nonroot:$svc" "no explicit non-root 'user:' directive"
  fi

  # port publish must be loopback-only (127.0.0.1:<port>:<port>), never bare or 0.0.0.0
  local portlines
  portlines="$(printf '%s\n' "$block" | grep -E '^\s*-\s*"?[0-9.]*:?[0-9\$\{\}A-Za-z_:-]*:[0-9]+"?\s*$' || true)"
  if printf '%s\n' "$block" | grep -qE '^\s*ports:'; then
    if printf '%s\n' "$block" | grep -A5 'ports:' | grep -qE '"0\.0\.0\.0:|^\s*-\s*"?[0-9]+:[0-9]+"?\s*$'; then
      fail "port:$svc" "port published without loopback binding (0.0.0.0 or bare host:container)"
    elif printf '%s\n' "$block" | grep -A5 'ports:' | grep -q '127.0.0.1:'; then
      pass "port:$svc" "port bound to 127.0.0.1 only"
    else
      fail "port:$svc" "ports: block present but no 127.0.0.1 binding found"
    fi
  else
    pass "port:$svc" "no ports published"
  fi
}

check_service postgres
check_service redis

# Postgres: explicit scram-sha-256 (assertable, not relying on the implicit PG16 default)
if grep -q 'POSTGRES_HOST_AUTH_METHOD: scram-sha-256' "$FILE"; then
  pass "scram" "POSTGRES_HOST_AUTH_METHOD explicitly set to scram-sha-256"
else
  fail "scram" "postgres service does not explicitly set scram-sha-256 auth"
fi

# Redis: requirepass
if grep -q -- '--requirepass' "$FILE"; then
  pass "requirepass" "redis command sets --requirepass"
else
  fail "requirepass" "redis service missing --requirepass"
fi

# ---- W13-06: the CUSTOMER compose file and its .env.example -----------------
#
# Acceptance: "every secret the compose file requires is documented with how to
# generate it, and none has a working default". A variable the compose file
# reads but .env.example never mentions is a knob a customer meets for the
# first time when something breaks; a secret with a default is a password
# everyone has.
DEPLOY_COMPOSE="deploy/compose.yaml"
DEPLOY_ENV="deploy/.env.example"

if [ -f "$DEPLOY_COMPOSE" ] && [ -f "$DEPLOY_ENV" ]; then
  UNDOCUMENTED=""
  for var in $(grep -oE '\$\{[A-Z_0-9]+' "$DEPLOY_COMPOSE" | sed 's/\${//' | sort -u); do
    grep -qE "(^|#[[:space:]]+)${var}([=[:space:]]|$)" "$DEPLOY_ENV" || UNDOCUMENTED="$UNDOCUMENTED $var"
  done
  [ -z "$UNDOCUMENTED" ] \
    && pass "env-documented" "every deploy/compose.yaml variable appears in .env.example" \
    || fail "env-documented" "compose reads these, .env.example never mentions them:$UNDOCUMENTED"

  SECRET_WITH_DEFAULT=""
  for var in POSTGRES_PASSWORD REDIS_PASSWORD SESSION_SECRET TOKEN_ENC_KEY WEBHOOK_SECRET \
             GITHUB_APP_CLIENT_SECRET GITHUB_APP_PRIVATE_KEY ANTHROPIC_API_KEY; do
    grep -qE "^${var}=.+" "$DEPLOY_ENV" && SECRET_WITH_DEFAULT="$SECRET_WITH_DEFAULT $var"
  done
  [ -z "$SECRET_WITH_DEFAULT" ] \
    && pass "no-default-secrets" "every secret in deploy/.env.example is blank" \
    || fail "no-default-secrets" "these ship with a value:$SECRET_WITH_DEFAULT"
else
  pass "env-documented" "deploy/compose.yaml or its .env.example is absent (skipped)"
fi

echo
if [ "$FAIL" = 0 ]; then
  echo "validate-compose: all rules PASS"
else
  echo "validate-compose: FAIL — SC-20 baseline violation(s) above"
fi
exit "$FAIL"
