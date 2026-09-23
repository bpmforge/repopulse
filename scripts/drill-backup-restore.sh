#!/usr/bin/env bash
# Backup / restore / upgrade drill against DISPOSABLE compose projects (W17-29).
#
#   scripts/drill-backup-restore.sh --source=rp-drill-a --target=rp-drill-b \
#       --version=0.1.0-rc1 [--prefix=localhost/repopulse] [--work=$HOME/tmp/rp-drill] \
#       [--port-base=8300] [--keep] [--log=<file>]
#
# WHAT IT PROVES, live, on the runtime it is pointed at (podman by default):
#   1. backup.sh dumps a stack that holds a known marker row and a forge
#      credential encrypted under its TOKEN_ENC_KEY, and records row counts;
#      restore.sh loads that dump into a DIFFERENT compose project and the
#      marker, the counts and the credential's decryptability all survive.
#   2. A wrong key is refused before anything is dropped (manifest fingerprint),
#      and — for a dump with no manifest — is caught after loading and the
#      restore exits non-zero instead of declaring success. A missing key is
#      refused outright. The key value never appears in the drill's output.
#   3. A migration that fails halts startup through up.sh (api and worker are
#      not started), leaves the ledger and data untouched, and the stack
#      recovers once the migration is fixed. Stopped services come back.
#   4. restore.sh refuses an unspecified target and the live project name.
#
# WHAT IT NEVER DOES: touch the compose project `repopulse` (the live install)
# — both names are required and that one is refused, with no override — print
# or copy TOKEN_ENC_KEY anywhere but the disposable .env files it deletes on
# exit, or publish anything. Images must already exist as
# <prefix>/{migrate,api,worker,scan-runner,web}:<version> (deploy/bundle.sh
# builds them); nothing is built here.
#
# --work must be somewhere the container runtime can bind-mount. Under podman
# machine that means under $HOME, which is why the default is there.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="${RUNTIME:-podman}"
SRC=""; DST=""; VERSION=""; PREFIX="localhost/repopulse"
WORK=""; PORT_BASE=8300; KEEP=0; LOG=""
for arg in "$@"; do
  case "$arg" in
    --source=*) SRC="${arg#*=}" ;;
    --target=*) DST="${arg#*=}" ;;
    --version=*) VERSION="${arg#*=}" ;;
    --prefix=*) PREFIX="${arg#*=}" ;;
    --work=*) WORK="${arg#*=}" ;;
    --port-base=*) PORT_BASE="${arg#*=}" ;;
    --log=*) LOG="${arg#*=}" ;;
    --keep) KEEP=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

refuse() { echo "DRILL REFUSED: $*" >&2; exit 2; }
[ -n "$SRC" ] && [ -n "$DST" ] || refuse "--source= and --target= are both required: this drill creates and DESTROYS both compose projects, so neither is ever assumed."
[ "$SRC" != "repopulse" ] && [ "$DST" != "repopulse" ] || refuse "'repopulse' is the live install's compose project. The drill tears its projects down with their volumes; it will not do that to production, and there is no flag that makes it."
[ "$SRC" != "$DST" ] || refuse "--source and --target must differ: restoring into the project the dump came from proves nothing about restore."
[ -n "$VERSION" ] || refuse "--version= is required (the image tag to run; dev/latest are not versions)."
case "$VERSION" in dev | latest | demo) refuse "--version=$VERSION is a floating tag, not a version." ;; esac
for name in migrate api worker scan-runner web; do
  "$RUNTIME" image exists "$PREFIX/$name:$VERSION" 2>/dev/null ||
    refuse "image $PREFIX/$name:$VERSION is not present; build it with deploy/bundle.sh --version=$VERSION first."
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
: "${WORK:=$HOME/tmp/rp-drill-$STAMP}"
: "${LOG:=$PWD/drill-backup-restore-$STAMP.log}"
mkdir -p "$WORK"
# Everything the drill prints goes to the log too; the final step greps it.
exec > >(tee -a "$LOG") 2>&1

SRC_DIR="$WORK/src/deploy"; DST_DIR="$WORK/dst/deploy"
SRC_PORT=$((PORT_BASE + 1)); DST_PORT=$((PORT_BASE + 2))
export REPOPULSE_UP_TIMEOUT="${REPOPULSE_UP_TIMEOUT:-600}"

RESULTS=()
pass() { RESULTS+=("PASS  $1"); echo "== PASS: $1"; }
fail() { RESULTS+=("FAIL  $1"); echo "== FAIL: $1"; FAILED=1; }
FAILED=0
step() { echo; echo "===== $(date -u +%H:%M:%S) $*"; }

compose_p() { # $1 project, rest compose args; run from that project's deploy dir
  local proj="$1"; shift
  local dir="$SRC_DIR"; [ "$proj" = "$DST" ] && dir="$DST_DIR"
  (cd "$dir" && "$RUNTIME" compose -p "$proj" -f compose.yaml "$@")
}
container_of() { # $1 project $2 service -> name or empty
  "$RUNTIME" ps -a --filter "label=com.docker.compose.project=$1" \
    --filter "label=com.docker.compose.service=$2" --format '{{.Names}}' | head -1
}
state_of() { # $1 project $2 service -> running|exited|... or "absent"
  local c; c="$(container_of "$1" "$2")"
  [ -n "$c" ] && "$RUNTIME" inspect "$c" --format '{{.State.Status}}' || echo absent
}
psql_p() { # $1 project; SQL on stdin
  local c pw; c="$(container_of "$1" postgres)"
  pw="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$([ "$1" = "$DST" ] && echo "$DST_DIR" || echo "$SRC_DIR")/.env" | tail -n1)"
  "$RUNTIME" exec -i -e PGPASSWORD="$pw" "$c" psql -U repopulse -d repopulse -tA -v ON_ERROR_STOP=1 --quiet
}
up_p() { (cd "$([ "$1" = "$DST" ] && echo "$DST_DIR" || echo "$SRC_DIR")" && REPOPULSE_PROJECT="$1" ./up.sh "${@:2}"); }
# Stop + remove app containers by label, in dependency order (podman refuses to
# remove api while web exists). NOT `compose rm`: podman-compose has no such
# subcommand — the W11-03 restore.sh relied on it and silently never stopped
# anything under podman, which this drill found.
stop_app() { # $1 project, rest: services
  local proj="$1"; shift
  compose_p "$proj" stop "$@" >/dev/null 2>&1 || true
  local svc id
  for svc in "$@"; do
    for id in $("$RUNTIME" ps -a --filter "label=com.docker.compose.project=$proj" --filter "label=com.docker.compose.service=$svc" -q); do
      "$RUNTIME" rm -f "$id" >/dev/null
    done
  done
}
healthz() { curl -fsS -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/healthz" || echo "curl-failed"; }

TORN_DOWN=0
teardown() {
  set +e
  [ "$TORN_DOWN" -eq 0 ] || return 0
  TORN_DOWN=1
  step "teardown"
  if [ "$KEEP" -eq 1 ]; then
    echo "--keep: leaving projects $SRC and $DST and $WORK in place (they hold a live TOKEN_ENC_KEY in .env — delete when done)"
    return
  fi
  compose_p "$SRC" down -v >/dev/null 2>&1
  compose_p "$DST" down -v >/dev/null 2>&1
  chmod -R u+w "$WORK" 2>/dev/null
  rm -rf "$WORK"
  echo "projects $SRC and $DST removed with their volumes; $WORK deleted"
}
trap teardown EXIT

echo "drill $STAMP: runtime=$RUNTIME images=$PREFIX/*:$VERSION source=$SRC (:$SRC_PORT) target=$DST (:$DST_PORT) work=$WORK log=$LOG"

# ------------------------------------------------------------ 0. stage -------
step "0 stage two deploy directories from $REPO_ROOT/deploy (no .env)"
for d in "$SRC_DIR" "$DST_DIR"; do
  mkdir -p "$d"
  # Not the vulnerability database: it is gigabytes, read-only, and the drill
  # is about the database, not the scanner. Scans report "unavailable".
  (cd "$REPO_ROOT/deploy" && tar --exclude=.env --exclude=./bundle --exclude=./scan-tools \
     --exclude='./scan-rules/vuln-db*' -cf - .) | (cd "$d" && tar -xf -)
done
(cd "$SRC_DIR" && ADMIN_PASSWORD="drill-passphrase-$STAMP" ./configure.sh \
  --url="http://localhost:$SRC_PORT" --port="$SRC_PORT" --admin-email="drill@example.com" >/dev/null)
{
  echo "REPOPULSE_VERSION=$VERSION"
  echo "REPOPULSE_IMAGE_PREFIX=$PREFIX"
  echo "SCAN_IMAGE=$PREFIX/scan:$VERSION"
} >> "$SRC_DIR/.env"
# The target is the same install (same secrets, same key) on another port and
# another project: the disaster-recovery shape, where the dump goes to a
# freshly provisioned host carrying the operator's .env.
sed -e "s/:$SRC_PORT/:$DST_PORT/g" -e "s/^REPOPULSE_PORT=.*/REPOPULSE_PORT=$DST_PORT/" "$SRC_DIR/.env" > "$DST_DIR/.env"
chmod 600 "$DST_DIR/.env"
KEY="$(sed -n 's/^TOKEN_ENC_KEY=//p' "$SRC_DIR/.env" | tail -n1)"   # held for the final "never printed" check only
[ "${#KEY}" -eq 64 ] || { fail "configure.sh wrote a TOKEN_ENC_KEY that is not 64 hex chars"; exit 1; }
echo "configured; .env mode $(stat -f %Lp "$SRC_DIR/.env" 2>/dev/null || stat -c %a "$SRC_DIR/.env")"

# ------------------------------------------------------- 1. source stack -----
step "1 bring up SOURCE project $SRC"
if up_p "$SRC"; then pass "source stack up (up.sh verified all services)"; else fail "source up.sh"; exit 1; fi

step "1b seed: marker row + a forge credential encrypted with the real vault"
psql_p "$SRC" <<SQL
create table drill_marker (note text not null, at timestamptz not null default now());
insert into drill_marker (note) values ('written-before-backup $STAMP');
insert into workspaces (slug, name) values ('drill', 'Drill') on conflict (slug) do nothing;
SQL
PLAINTEXT="drill-token-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
# The token goes in through the environment (never argv, never the log) and is
# encrypted by packages/auth's own encryptCredential inside the api image.
(cd "$SRC_DIR" && SCAN_RULES_DIR="$SRC_DIR/scan-rules" EXTRA_CA_DIR="$SRC_DIR/ca" "$RUNTIME" compose -p "$SRC" -f compose.yaml \
  run --rm --no-deps -T -e DRILL_TOKEN="$PLAINTEXT" api sh -c 'cd /app/apps/api && exec tsx -' <<'TS'
import { credentials } from '@repopulse/auth';
import { createDb } from '@repopulse/shared';
const key = credentials.loadTokenKey();
const db = createDb(process.env.DATABASE_URL ?? '');
try {
  const enc = credentials.encryptCredential(process.env.DRILL_TOKEN ?? '', key);
  const ws = (await db.$client`select id from workspaces where slug = 'drill'`) as unknown as { id: number }[];
  await db.$client`insert into forge_connections
    (workspace_id, provider, auth_kind, credential_ciphertext, credential_iv, key_version, credential_fingerprint, base_url, status)
    values (${ws[0]!.id}, 'gitea', 'pat', ${enc.ciphertext}, ${enc.iv}, ${enc.keyVersion}, ${enc.fingerprint}, 'https://drill.invalid', 'active')`;
  console.log('[seed] forge connection stored (ciphertext only)');
} finally { await db.$client.end(); }
TS
)
SRC_COUNTS="$(psql_p "$SRC" <<<"select 'workspaces='||(select count(*) from workspaces)||' repos='||(select count(*) from repos)||' forge_connections='||(select count(*) from forge_connections)||' drill_marker='||(select count(*) from drill_marker)||' migrations='||(select count(*) from drizzle.__drizzle_migrations)")"
echo "source rows: $SRC_COUNTS"
step "1c the seeded credential decrypts in the source (restore.sh --verify-only)"
if (cd "$SRC_DIR" && ./restore.sh --project="$SRC" --verify-only | tee "$WORK/verify-src.txt") && grep -q "1 of 1 decrypt" "$WORK/verify-src.txt"; then
  pass "source credential decrypts (1 of 1)"; else fail "source verify-only"; fi

# ------------------------------------------------------------ 2. backup ------
step "2 backup.sh --project=$SRC"
mkdir -p "$WORK/backups"
if (cd "$SRC_DIR" && OUT_DIR="$WORK/backups" ./backup.sh --project="$SRC"); then pass "backup.sh exit 0"; else fail "backup.sh"; exit 1; fi
DUMP="$(ls "$WORK"/backups/repopulse-*.sql | head -1)"
echo "--- manifest:"; cat "$DUMP.manifest"
grep -q "ROWS_FORGE_CONNECTIONS=1" "$DUMP.manifest" && pass "manifest records 1 forge connection" || fail "manifest counts"
grep -q "$KEY" "$DUMP" "$DUMP.manifest" && fail "KEY VALUE FOUND in dump or manifest" || pass "dump and manifest do not contain the key"
grep -q "$PLAINTEXT" "$DUMP" && fail "PLAINTEXT TOKEN FOUND in dump" || pass "dump does not contain the plaintext token"

# ----------------------------------------------- 3. refusals (acceptance 4) --
step "3 restore.sh refuses an unspecified target and the live project name"
set +e
(cd "$DST_DIR" && env -u REPOPULSE_PROJECT -u PROJECT ./restore.sh --yes "$DUMP"); rc=$?
set -e
[ "$rc" -ne 0 ] && pass "no --project → refused (exit $rc)" || fail "no --project was accepted"
set +e
(cd "$DST_DIR" && ./restore.sh --project=repopulse --yes "$DUMP"); rc=$?
set -e
[ "$rc" -ne 0 ] && pass "--project=repopulse without --production → refused (exit $rc)" || fail "live project accepted"
[ "$(state_of repopulse postgres)" != running ] || echo "(note: a live 'repopulse' project is running on this host — it was not touched: $(state_of repopulse api))"

# -------------------------------------------------------- 4. target stack ----
step "4 bring up TARGET project $DST (fresh volumes) and restore into it"
if up_p "$DST"; then pass "target stack up"; else fail "target up.sh"; exit 1; fi
echo "target rows before restore: $(psql_p "$DST" <<<"select 'workspaces='||(select count(*) from workspaces)||' forge_connections='||(select count(*) from forge_connections)")"
psql_p "$DST" <<<"select 1 from drill_marker" >/dev/null 2>&1 && fail "target already had drill_marker" || echo "target has no drill_marker (as expected)"
if (cd "$DST_DIR" && ./restore.sh --project="$DST" --yes "$DUMP" | tee "$WORK/restore-ok.txt"); then pass "restore.sh into $DST exit 0"; else fail "restore.sh into $DST"; fi
grep -q "1 of 1 decrypt" "$WORK/restore-ok.txt" && pass "restore's own decrypt check: 1 of 1" || fail "restore decrypt check output"
DST_COUNTS="$(psql_p "$DST" <<<"select 'workspaces='||(select count(*) from workspaces)||' repos='||(select count(*) from repos)||' forge_connections='||(select count(*) from forge_connections)||' drill_marker='||(select count(*) from drill_marker)||' migrations='||(select count(*) from drizzle.__drizzle_migrations)")"
echo "target rows after restore: $DST_COUNTS"
[ "$SRC_COUNTS" = "$DST_COUNTS" ] && pass "row counts identical before backup and after restore" || fail "row counts differ: src=$SRC_COUNTS dst=$DST_COUNTS"
psql_p "$DST" <<<"select note from drill_marker" | grep -q "written-before-backup $STAMP" && pass "marker row restored in $DST" || fail "marker row missing in $DST"
h="$(healthz "$DST_PORT")"; [ "$h" = 200 ] && pass "target /healthz 200 after restore" || fail "target /healthz $h"
step "4b independent decrypt check on the target (--verify-only)"
(cd "$DST_DIR" && ./restore.sh --project="$DST" --verify-only | grep -q "1 of 1 decrypt") && pass "target credential decrypts with the operator's key" || fail "target verify-only"

step "4c rollback shape: restore.sh --no-migrate (migrate not run, app started with --no-deps)"
LEDGER_PRE="$(psql_p "$DST" <<<"select count(*) from drizzle.__drizzle_migrations")"
if (cd "$DST_DIR" && ./restore.sh --project="$DST" --yes --no-migrate "$DUMP" > "$WORK/restore-nomigrate.txt" 2>&1); then pass "restore --no-migrate exit 0"; else fail "restore --no-migrate"; sed -e 's/^/    /' "$WORK/restore-nomigrate.txt" | tail -20; fi
grep -E "skipping migrations|migrate deliberately|1 of 1 decrypt|All services" "$WORK/restore-nomigrate.txt" | sed -e 's/^/    /'
[ "$(state_of "$DST" migrate)" = absent ] && pass "no migrate container exists after --no-migrate (nothing re-applied)" || fail "migrate container present: $(state_of "$DST" migrate)"
[ "$(psql_p "$DST" <<<"select count(*) from drizzle.__drizzle_migrations")" = "$LEDGER_PRE" ] && pass "ledger unchanged by --no-migrate ($LEDGER_PRE)" || fail "ledger changed under --no-migrate"
h="$(healthz "$DST_PORT")"; [ "$h" = 200 ] && pass "/healthz 200 after --no-migrate restore" || fail "/healthz $h after --no-migrate restore"

# ---------------------------------------------------- 5. wrong / missing key --
step "5 wrong key: refused by the manifest fingerprint BEFORE anything is dropped"
cp "$DST_DIR/.env" "$WORK/dst.env.good"
WRONG="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
sed -i.bak "s/^TOKEN_ENC_KEY=.*/TOKEN_ENC_KEY=$WRONG/" "$DST_DIR/.env" && rm -f "$DST_DIR/.env.bak"
set +e
(cd "$DST_DIR" && ./restore.sh --project="$DST" --yes "$DUMP" > "$WORK/restore-wrongkey.txt" 2>&1); rc=$?
set -e
sed -e 's/^/    /' "$WORK/restore-wrongkey.txt"
[ "$rc" -ne 0 ] && grep -q "not the key this dump was taken under" "$WORK/restore-wrongkey.txt" && pass "wrong key refused before load (exit $rc)" || fail "wrong key not refused by manifest"
[ "$(state_of "$DST" api)" = running ] && pass "target api still running (nothing was stopped or dropped)" || fail "target api state: $(state_of "$DST" api)"

step "5b wrong key with NO manifest (older backup): loads, then FAILS the decrypt check, exits non-zero"
cp "$DUMP" "$WORK/backups/nomanifest.sql"
set +e
(cd "$DST_DIR" && ./restore.sh --project="$DST" --yes "$WORK/backups/nomanifest.sql" > "$WORK/restore-wrongkey-nomanifest.txt" 2>&1); rc=$?
set -e
grep -E "verify|RESTORE INCOMPLETE|rows" "$WORK/restore-wrongkey-nomanifest.txt" | sed -e 's/^/    /'
[ "$rc" -ne 0 ] && grep -q "0 of 1 decrypt" "$WORK/restore-wrongkey-nomanifest.txt" && grep -q "RESTORE INCOMPLETE" "$WORK/restore-wrongkey-nomanifest.txt" && pass "wrong key without manifest → 0 of 1 decrypt, RESTORE INCOMPLETE, exit $rc" || fail "wrong key without manifest was not caught (exit $rc)"
[ "$(state_of "$DST" api)" != running ] && pass "app containers NOT started after the failed key check" || fail "api was started despite undecryptable credentials"

step "5c missing key: refused outright"
sed -i.bak "s/^TOKEN_ENC_KEY=.*/TOKEN_ENC_KEY=/" "$DST_DIR/.env" && rm -f "$DST_DIR/.env.bak"
set +e
(cd "$DST_DIR" && ./restore.sh --project="$DST" --yes "$DUMP" > "$WORK/restore-nokey.txt" 2>&1); rc=$?
set -e
sed -e 's/^/    /' "$WORK/restore-nokey.txt"
[ "$rc" -ne 0 ] && grep -q "TOKEN_ENC_KEY is not set" "$WORK/restore-nokey.txt" && pass "missing key refused (exit $rc)" || fail "missing key not refused"
set +e
(cd "$DST_DIR" && OUT_DIR="$WORK" ./backup.sh --project="$DST" > "$WORK/backup-nokey.txt" 2>&1); rc=$?
set -e
[ "$rc" -ne 0 ] && grep -q "BACKUP REFUSED" "$WORK/backup-nokey.txt" && pass "backup.sh with no key refused (exit $rc)" || fail "backup.sh ran without a key"

step "5d the right key back: verify-only passes again and the stack recovers via restore"
cp "$WORK/dst.env.good" "$DST_DIR/.env"
if (cd "$DST_DIR" && ./restore.sh --project="$DST" --yes "$DUMP" > "$WORK/restore-again.txt" 2>&1) && grep -q "1 of 1 decrypt" "$WORK/restore-again.txt"; then
  pass "restore with the correct key succeeds again (1 of 1 decrypt), app started"; else fail "re-restore with correct key"; sed -e 's/^/    /' "$WORK/restore-again.txt"; fi

# ------------------------------------------------- 6. migration failure -----
step "6 a failing migration halts startup through up.sh; ledger and data untouched"
BROKEN="$WORK/broken-drizzle"
cp -R "$REPO_ROOT/packages/shared/drizzle" "$BROKEN"
LAST_IDX="$(node -e "const j=require('$BROKEN/meta/_journal.json');console.log(j.entries[j.entries.length-1].idx)")"
NEW_IDX=$((LAST_IDX + 1))
TAG="$(printf '%04d_w17_29_broken_on_purpose' "$NEW_IDX")"
printf 'CREATE TABLE drill_should_not_exist (id int);\n--> statement-breakpoint\nSELECT 1/0;\n' > "$BROKEN/$TAG.sql"
node -e "
const fs=require('fs');const p='$BROKEN/meta/_journal.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));
j.entries.push({idx:$NEW_IDX,version:'7',when:Date.now(),tag:'$TAG',breakpoints:true});
fs.writeFileSync(p,JSON.stringify(j,null,2));"
LEDGER_BEFORE="$(psql_p "$DST" <<<"select count(*) from drizzle.__drizzle_migrations")"
stop_app "$DST" web api worker scan-runner migrate
echo "    before the broken up: api=$(state_of "$DST" api) worker=$(state_of "$DST" worker) migrate=$(state_of "$DST" migrate)"
# Point the disposable copy's migrate service at the broken folder. The
# migrate block is the only one with `restart: "no"`, which is the anchor.
cp "$DST_DIR/compose.yaml" "$WORK/compose.yaml.good"
awk -v vol="$BROKEN" '{print} /^    restart: "no"$/ {print "    volumes:"; print "      - " vol ":/app/packages/shared/drizzle:ro"}' "$WORK/compose.yaml.good" > "$DST_DIR/compose.yaml"
set +e
up_p "$DST" > "$WORK/up-broken.txt" 2>&1; rc=$?
set -e
grep -E "MIGRATION FAILED|schema was not applied|Nothing else|^\[migrate\]" "$WORK/up-broken.txt" | sed -e 's/^/    /'
[ "$rc" -ne 0 ] && grep -q "DATABASE MIGRATION FAILED" "$WORK/up-broken.txt" && pass "up.sh exit $rc: DATABASE MIGRATION FAILED" || fail "up.sh did not fail on the broken migration (exit $rc)"
echo "    migrate: $(state_of "$DST" migrate) exit $("$RUNTIME" inspect "$(container_of "$DST" migrate)" --format '{{.State.ExitCode}}')  api: $(state_of "$DST" api)  worker: $(state_of "$DST" worker)"
"$RUNTIME" logs "$(container_of "$DST" migrate)" 2>&1 | grep -iE "division by zero|error" | head -2 | sed -e 's/^/    migrate log: /'
[ "$(state_of "$DST" api)" != running ] && [ "$(state_of "$DST" worker)" != running ] && pass "api and worker are not running against the failed migration (up.sh stopped them: podman-compose starts them regardless)" || fail "api/worker running against a failed migration"
LEDGER_AFTER="$(psql_p "$DST" <<<"select count(*) from drizzle.__drizzle_migrations")"
[ "$LEDGER_BEFORE" = "$LEDGER_AFTER" ] && pass "migration ledger unchanged ($LEDGER_AFTER)" || fail "ledger changed $LEDGER_BEFORE → $LEDGER_AFTER"
psql_p "$DST" <<<"select 1 from drill_should_not_exist" >/dev/null 2>&1 && fail "half-applied migration left drill_should_not_exist behind" || pass "failed migration rolled back (no drill_should_not_exist table)"
psql_p "$DST" <<<"select note from drill_marker" | grep -q "written-before-backup" && pass "data intact after the failed upgrade" || fail "marker lost"

step "6b recovery: fixed migration → up.sh brings everything back"
cp "$WORK/compose.yaml.good" "$DST_DIR/compose.yaml"
stop_app "$DST" web api worker scan-runner migrate
if up_p "$DST" > "$WORK/up-recover.txt" 2>&1; then pass "up.sh after the fix: all services running"; else fail "recovery up.sh"; sed -e 's/^/    /' "$WORK/up-recover.txt"; fi
"$RUNTIME" logs "$(container_of "$DST" migrate)" 2>&1 | grep '^\[migrate\]' | sed -e 's/^/    /'
h="$(healthz "$DST_PORT")"; [ "$h" = 200 ] && pass "/healthz 200 after recovery" || fail "/healthz $h after recovery"

# ------------------------------------------------ 7. stopped services -------
step "7 stopped services recover"
compose_p "$DST" stop api worker >/dev/null 2>&1
echo "    after stop: api=$(state_of "$DST" api) worker=$(state_of "$DST" worker)"
[ "$(state_of "$DST" api)" != running ] || fail "api did not stop"
if up_p "$DST" > "$WORK/up-restart.txt" 2>&1; then pass "up.sh restarts stopped api/worker"; else fail "restart via up.sh"; fi
echo "    after up: api=$(state_of "$DST" api) worker=$(state_of "$DST" worker)"
# Through the web tier, deliberately. nginx resolves the api upstream ONCE at
# startup, and a restarted api container gets a new address, so web keeps
# proxying to the old one. Recorded, not hidden: the documented recovery is a
# full `down` + up.sh, which is what the next lines do if this shows it.
h="$(healthz "$DST_PORT")"
if [ "$h" = 200 ]; then pass "/healthz 200 through web after api restart"; else
  echo "    FINDING: /healthz via web = $h after api alone was restarted (api $(state_of "$DST" api); web still holds the old api address)"
  compose_p "$DST" down >/dev/null 2>&1
  if up_p "$DST" > "$WORK/up-restart2.txt" 2>&1 && [ "$(healthz "$DST_PORT")" = 200 ]; then
    pass "documented remedy works: down + up.sh → /healthz 200 (web re-resolves api on recreate)"
  else fail "down + up.sh did not restore /healthz"; fi
fi
step "7b crash (SIGKILL) of the worker: does restart: unless-stopped bring it back on this runtime?"
"$RUNTIME" kill "$(container_of "$DST" worker)" >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do sleep 5; [ "$(state_of "$DST" worker)" = running ] && break; done
if [ "$(state_of "$DST" worker)" = running ]; then pass "worker restarted by the runtime after SIGKILL"; else
  echo "    worker after 60s: $(state_of "$DST" worker) — runtime restart policy did not act; up.sh is the documented recovery"
  if up_p "$DST" > /dev/null 2>&1 && [ "$(state_of "$DST" worker)" = running ]; then pass "worker recovered via up.sh (runtime auto-restart did NOT fire — recorded)"; else fail "worker did not recover"; fi
fi

# ------------------------------------------------------ 8. upgrade -----------
step "8 RUNBOOK upgrade sequence on $DST: backup → down → up.sh → healthz, data intact"
if (cd "$DST_DIR" && OUT_DIR="$WORK/backups" ./backup.sh --project="$DST" >/dev/null); then pass "pre-upgrade backup"; else fail "pre-upgrade backup"; fi
compose_p "$DST" down >/dev/null 2>&1
echo "    after down: containers=$("$RUNTIME" ps -a --filter "label=com.docker.compose.project=$DST" --format '{{.Names}}' | wc -l | tr -d ' ')"
t0=$(date +%s)
if up_p "$DST" > "$WORK/up-upgrade.txt" 2>&1; then pass "up.sh after down ($(( $(date +%s) - t0 ))s)"; else fail "upgrade up.sh"; fi
"$RUNTIME" logs "$(container_of "$DST" migrate)" 2>&1 | grep '^\[migrate\]' | sed -e 's/^/    /'
h="$(healthz "$DST_PORT")"; [ "$h" = 200 ] && pass "/healthz 200 after upgrade" || fail "/healthz $h after upgrade"
psql_p "$DST" <<<"select note from drill_marker" | grep -q "written-before-backup" && pass "data intact across the upgrade" || fail "marker lost across upgrade"
(cd "$DST_DIR" && ./restore.sh --project="$DST" --verify-only | grep -q "1 of 1 decrypt") && pass "credential still decrypts after upgrade" || fail "credential after upgrade"

# ------------------------------------------------------- 9. secrecy ---------
step "9 the key and the plaintext token never appeared in this drill's output"
sync; sleep 1
if grep -q "$KEY" "$LOG"; then fail "TOKEN_ENC_KEY VALUE APPEARS IN THE LOG"; else pass "key value absent from the log"; fi
if grep -q "$PLAINTEXT" "$LOG"; then fail "plaintext token appears in the log"; else pass "plaintext token absent from the log"; fi
if grep -rq "$KEY" "$WORK/backups"; then fail "key in backups dir"; else pass "key absent from every backup artifact"; fi

echo; echo "===== RESULTS"; printf '%s\n' "${RESULTS[@]}"
if [ "$FAILED" -ne 0 ]; then echo "DRILL FAILED"; exit 1; fi
echo "DRILL PASSED ($(printf '%s\n' "${RESULTS[@]}" | grep -c '^PASS') checks)"
