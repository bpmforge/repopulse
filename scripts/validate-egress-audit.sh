#!/usr/bin/env bash
# validate-egress-audit.sh — SC-15 gate (docs/SECURITY_CONTROLS.md): asserts
# egress_audit is append-only at the DB layer for the repopulse_app role
# (UPDATE/DELETE must fail; INSERT must succeed). Runs against the live
# compose Postgres (scripts/dev-up.sh) via `podman exec` — no host psql
# client required, matches dev-up.sh/dev-down.sh's approach. Never a
# recorded fixture: this is a real DB-privilege check (W1-02).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

CONTAINER="repopulse-postgres"
PGUSER="${POSTGRES_USER:-repopulse}"
PGDB="${POSTGRES_DB:-repopulse}"
PGPASSWORD_VAL="${POSTGRES_PASSWORD:-repopulse_dev_password}"

if ! podman inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "FAIL: $CONTAINER is not running — run scripts/dev-up.sh first" >&2
  exit 1
fi

psql_as_owner() { # $1 = SQL
  podman exec -e PGPASSWORD="$PGPASSWORD_VAL" "$CONTAINER" psql -U "$PGUSER" -d "$PGDB" -qtA -c "$1"
}

FAIL=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAIL=1; }

SEED_SLUG="validate-egress-audit"
WORKSPACE_ID="$(psql_as_owner "
  INSERT INTO workspaces (slug, name) VALUES ('$SEED_SLUG', '$SEED_SLUG')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id;
")"
USER_ID="$(psql_as_owner "
  INSERT INTO users (forge_user_id, login) VALUES ('$SEED_SLUG', '$SEED_SLUG')
    ON CONFLICT (forge_user_id) DO UPDATE SET login = EXCLUDED.login RETURNING id;
")"
CONNECTION_ID="$(psql_as_owner "
  INSERT INTO forge_connections (workspace_id, provider, auth_kind, credential_ciphertext, credential_iv, key_version, credential_fingerprint, status, created_by)
    SELECT $WORKSPACE_ID, 'github', 'pat', '\x00', '\x00', 1, '$SEED_SLUG', 'active', $USER_ID
    WHERE NOT EXISTS (SELECT 1 FROM forge_connections WHERE workspace_id = $WORKSPACE_ID)
    RETURNING id;
")"
if [ -z "$CONNECTION_ID" ]; then
  CONNECTION_ID="$(psql_as_owner "SELECT id FROM forge_connections WHERE workspace_id = $WORKSPACE_ID LIMIT 1;")"
fi
REPO_ID="$(psql_as_owner "
  INSERT INTO repos (workspace_id, connection_id, forge_repo_id, org, name, default_branch, is_private, is_archived, sync_status, tier2_auto)
    SELECT $WORKSPACE_ID, $CONNECTION_ID, '$SEED_SLUG', '$SEED_SLUG', '$SEED_SLUG', 'main', false, false, 'live', false
    WHERE NOT EXISTS (SELECT 1 FROM repos WHERE workspace_id = $WORKSPACE_ID)
    RETURNING id;
")"
if [ -z "$REPO_ID" ]; then
  REPO_ID="$(psql_as_owner "SELECT id FROM repos WHERE workspace_id = $WORKSPACE_ID LIMIT 1;")"
fi
ANALYSIS_RUN_ID="$(psql_as_owner "
  INSERT INTO analysis_runs (workspace_id, repo_id, tier, dimension, checklist_version, model_id, status, chunk_count, prompt_tokens, output_tokens, started_at)
    VALUES ($WORKSPACE_ID, $REPO_ID, 3, 'security', 'validate', 'validate', 'succeeded', 1, 1, 1, now())
    RETURNING id;
")"
EGRESS_ID="$(psql_as_owner "
  INSERT INTO egress_audit (workspace_id, repo_id, analysis_run_id, initiator_user_id, model_id, bytes_sent, tokens_sent, tokens_received, content_sha256)
    VALUES ($WORKSPACE_ID, $REPO_ID, $ANALYSIS_RUN_ID, $USER_ID, 'validate', 1, 1, 1, 'validate')
    RETURNING id;
")"

# INSERT as repopulse_app must succeed.
if OUT="$(podman exec -e PGPASSWORD="$PGPASSWORD_VAL" "$CONTAINER" psql -U "$PGUSER" -d "$PGDB" -qtA -c "
  BEGIN;
  SET ROLE repopulse_app;
  INSERT INTO egress_audit (workspace_id, repo_id, analysis_run_id, initiator_user_id, model_id, bytes_sent, tokens_sent, tokens_received, content_sha256)
    VALUES ($WORKSPACE_ID, $REPO_ID, $ANALYSIS_RUN_ID, $USER_ID, 'validate-insert', 1, 1, 1, 'validate-insert');
  ROLLBACK;
" 2>&1)"; then
  pass "repopulse_app can INSERT into egress_audit"
else
  fail "repopulse_app INSERT into egress_audit failed unexpectedly: $OUT"
fi

# UPDATE as repopulse_app must fail with permission denied.
OUT="$(podman exec -e PGPASSWORD="$PGPASSWORD_VAL" "$CONTAINER" psql -U "$PGUSER" -d "$PGDB" -qtA -c "
  BEGIN;
  SET ROLE repopulse_app;
  UPDATE egress_audit SET model_id = 'tampered' WHERE id = $EGRESS_ID;
  ROLLBACK;
" 2>&1)" && UPDATE_EXIT=0 || UPDATE_EXIT=1
if [ "$UPDATE_EXIT" = 1 ] && printf '%s' "$OUT" | grep -qi 'permission denied'; then
  pass "repopulse_app UPDATE on egress_audit denied"
else
  fail "repopulse_app UPDATE on egress_audit did not fail with permission denied (exit=$UPDATE_EXIT): $OUT"
fi

# DELETE as repopulse_app must fail with permission denied.
OUT="$(podman exec -e PGPASSWORD="$PGPASSWORD_VAL" "$CONTAINER" psql -U "$PGUSER" -d "$PGDB" -qtA -c "
  BEGIN;
  SET ROLE repopulse_app;
  DELETE FROM egress_audit WHERE id = $EGRESS_ID;
  ROLLBACK;
" 2>&1)" && DELETE_EXIT=0 || DELETE_EXIT=1
if [ "$DELETE_EXIT" = 1 ] && printf '%s' "$OUT" | grep -qi 'permission denied'; then
  pass "repopulse_app DELETE on egress_audit denied"
else
  fail "repopulse_app DELETE on egress_audit did not fail with permission denied (exit=$DELETE_EXIT): $OUT"
fi

# Cleanup seeded fixture data.
psql_as_owner "DELETE FROM egress_audit WHERE id = $EGRESS_ID;" >/dev/null
psql_as_owner "DELETE FROM analysis_runs WHERE id = $ANALYSIS_RUN_ID;" >/dev/null

echo
if [ "$FAIL" = 0 ]; then
  echo "validate-egress-audit: all checks PASS"
else
  echo "validate-egress-audit: FAIL — SC-15 violation(s) above"
fi
exit "$FAIL"
