#!/usr/bin/env bash
# Report PDF smoke test for a running install (W20-02, UX_TODO ADM-42).
#
#   deploy/smoke-report-pdf.sh [--url=http://127.0.0.1:8099] [--type=repo_health] [--timeout=180] [--out=report.pdf]
#
# Signs in, generates one report, waits for it, downloads the PDF through the
# api and checks that the bytes are a PDF with at least one page. Exits 0 only
# when all of that worked. --out keeps the downloaded PDF at that path.
#
# WHY THIS EXISTS. A report touches three containers: the api queues it, the
# worker prints it with a headless browser that loads the web service, and the
# api later streams the file the worker wrote. Each container can be healthy on
# its own while the chain is broken: the worker image once had no browser, the
# two never shared a disk, and the printer was pointed at the public URL. All
# three passed every health check, and every Generate ended "failed". Only a
# test that runs the whole chain catches that.
#
# Credentials come from the environment, never argv: SMOKE_EMAIL and
# SMOKE_PASSWORD, else ADMIN_EMAIL and ADMIN_PASSWORD from deploy/.env. The
# account must already be past its first-sign-in password change, because this
# script will not change anyone's password. It generates one real report row in
# the account's workspace; that row stays in the report history.
set -euo pipefail

cd "$(dirname "$0")"

env_value() { # $1 name -> shell value, else the deploy/.env line, else empty
  if [ -n "${!1:-}" ]; then printf '%s' "${!1}"
  elif [ -f .env ]; then sed -n "s/^$1=//p" .env | tail -n1; fi
}

URL=""; TYPE=repo_health; TIMEOUT=180; OUT=""
for arg in "$@"; do
  case "$arg" in
    --url=*) URL="${arg#*=}" ;;
    --type=*) TYPE="${arg#*=}" ;;
    --timeout=*) TIMEOUT="${arg#*=}" ;;
    --out=*) OUT="${arg#*=}" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
: "${URL:=http://127.0.0.1:$(env_value REPOPULSE_PORT)}"
URL="${URL%/}"
EMAIL="${SMOKE_EMAIL:-$(env_value ADMIN_EMAIL)}"
PASSWORD="${SMOKE_PASSWORD:-$(env_value ADMIN_PASSWORD)}"

die() { echo "SMOKE FAILED: $*" >&2; exit 1; }
[ -n "$EMAIL" ] && [ -n "$PASSWORD" ] ||
  die "no credentials. Set SMOKE_EMAIL and SMOKE_PASSWORD (or ADMIN_EMAIL/ADMIN_PASSWORD in deploy/.env)."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
JAR="$WORK/cookies"
PDF="$WORK/report.pdf"

# Every mutating call needs the CSRF header (apps/api/src/plugins/csrf-header.ts).
api() { # $1 method $2 path [$3 json body] -> body on stdout, HTTP code in $WORK/code
  local args=(-sS -m 30 -b "$JAR" -c "$JAR" -X "$1" -o "$WORK/body" -w '%{http_code}'
    -H 'x-requested-with: repopulse' -H 'content-type: application/json')
  [ $# -ge 3 ] && args+=(--data-binary @-)
  if [ $# -ge 3 ]; then printf '%s' "$3" | curl "${args[@]}" "$URL$2" >"$WORK/code"
  else curl "${args[@]}" "$URL$2" >"$WORK/code"; fi
  cat "$WORK/body"
}
code() { cat "$WORK/code"; }
field() { # $1 json $2 key -> first string/number/bool value of "key"
  printf '%s' "$1" | grep -oE "\"$2\":(\"[^\"]*\"|[0-9a-z]+)" | head -n1 | sed -E "s/^\"$2\"://; s/^\"//; s/\"$//"
}

echo "install:  $URL"
# JSON-escape the password the minimal way: backslash and double quote.
pw_json="$(printf '%s' "$PASSWORD" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
login="$(api POST /auth/local/login "{\"email\":\"$EMAIL\",\"password\":\"$pw_json\"}")"
[ "$(code)" = 200 ] || die "sign-in as $EMAIL returned HTTP $(code): $login"
[ "$(field "$login" must_change_password)" = false ] ||
  die "$EMAIL must change their password before this account can be used. Sign in once in the browser, then rerun."
echo "signed in: $EMAIL"

created="$(api POST /api/v1/reports "{\"type\":\"$TYPE\",\"window_days\":30,\"annotation\":\"smoke-report-pdf.sh\"}")"
[ "$(code)" = 201 ] || die "POST /api/v1/reports returned HTTP $(code): $created"
id="$(field "$created" id)"
echo "report:   #$id ($TYPE) queued"

deadline=$(( $(date +%s) + TIMEOUT ))
status=""
while :; do
  row="$(api GET "/api/v1/reports/$id")"
  status="$(field "$row" status)"
  case "$status" in ready | failed) break ;; esac
  [ "$(date +%s)" -lt "$deadline" ] || die "report #$id still '$status' after ${TIMEOUT}s. Is the worker running? Check: <runtime> logs <project>_worker_1"
  sleep 2
done
if [ "$status" = failed ]; then
  die "report #$id failed in the worker: $(field "$row" error)"
fi
[ "$(field "$row" has_pdf)" = true ] ||
  die "report #$id is ready but the api cannot see its PDF (has_pdf=false). api and worker are not sharing the report-data volume at the same DATA_DIR."
echo "status:   ready, api sees the PDF"

curl -sS -m 60 -b "$JAR" -o "$PDF" -w '%{http_code}' "$URL/api/v1/reports/$id/download" >"$WORK/code"
[ "$(code)" = 200 ] || die "download returned HTTP $(code): $(head -c 300 "$PDF")"
magic="$(head -c 5 "$PDF")"
[ "$magic" = "%PDF-" ] || die "download is not a PDF (first bytes: $(head -c 16 "$PDF" | od -An -c | tr -s ' '))"
bytes="$(wc -c <"$PDF" | tr -d ' ')"
# Chromium writes each page as an uncompressed `/Type /Page` object, so this
# count is exact for our PDFs. `/Pages` (the page tree) is excluded.
pages="$(LC_ALL=C grep -aoE '/Type ?/Page([^s]|$)' "$PDF" | wc -l | tr -d ' ')"
[ "$pages" -ge 1 ] || die "the PDF has no pages ($bytes bytes)"

api POST /auth/local/logout '{}' >/dev/null || true
[ -z "$OUT" ] || cp "$PDF" "$OUT"
echo "PASS: report #$id downloaded as a PDF, $bytes bytes, $pages page(s)"
