#!/usr/bin/env bash
# Bring up the customer-hostable stack (W16-04, hardened in W17-04).
#
# WHY THIS EXISTS, rather than "just run compose up".
#
# `podman compose -f deploy/compose.yaml up -d` on a clean host starts five of
# six services and leaves the WORKER dead:
#
#   Error: statfs /var/lib/repopulse/scan-rules: no such file or directory
#
# SCAN_RULES_DIR defaults to an absolute host path that nothing creates — it is
# filled later by scan-db-sync.sh — and a bind mount whose source is missing
# fails at container-creation time, before any of our code runs. So the worker
# cannot degrade gracefully: there is nothing running to degrade.
#
# The damage is not the dead worker, it is that the stack LOOKS healthy. The web
# tier comes up and answers 200 on :8099, so the operator sees a working product
# that will never ingest anything, and the only evidence is one line in a compose
# log they have already scrolled past. podman-compose's own exit status does not
# save them either — the failing run printed `exit status 125` while the wrapper
# around it exited 0.
#
# This script fixes both halves: it makes the mount source exist before compose
# runs, and it verifies afterwards that every service is actually up, exiting
# non-zero with the names of the ones that are not.
#
# The repo already ships deploy/scan-rules/ for exactly this reason — see its
# README — but the compose default pointed somewhere else and defeated it. That
# default is deliberately unchanged: /var/lib/repopulse/scan-rules is the right
# answer for a production host where the rules are refreshed by a timer and must
# survive a checkout being deleted. This script picks the shipped directory only
# when the operator has not chosen one.
#
# W17-04 added, on top of that:
#   - RUNTIME=docker|podman honoured explicitly; detection ONLY when unset, so a
#     host with both installed stops being a coin flip.
#   - the compose PROVIDER is verified, not just the runtime binary. `podman`
#     existing does not mean `podman compose` can run.
#   - migrate is verified to have exited ZERO. "Exited" was previously treated as
#     success, so a failed migration produced a healthy-looking stack.
#   - services are waited for with a bounded timeout instead of inspected once,
#     immediately, before they could possibly be up.
#   - state comes from `inspect` on compose LABELS rather than from grepping
#     `compose ps` text, which differs between the two providers.
#   - the real compose error is shown instead of being swallowed by `|| true`.

set -euo pipefail

cd "$(dirname "$0")"

die() {
  echo >&2
  echo "$*" >&2
  exit 1
}

# A variable the way compose resolves it: the shell first, then deploy/.env
# (W17-28). Both up.sh and scan-db-sync.sh read SCAN_RULES_DIR through this so
# the directory the worker mounts is the directory the sync fills.
env_value() { # $1 name -> shell value, else the .env line, else empty
  if [ -n "${!1:-}" ]; then printf '%s' "${!1}"
  elif [ -f .env ]; then sed -n "s/^$1=//p" .env | tail -n1; fi
}

# How long to wait for the stack to become healthy. A cold first run has to pull
# or build images, so this is generous; CI and tests override it.
: "${REPOPULSE_UP_TIMEOUT:=300}"

# One compose project per install, overridable so a test can bring up a stack
# that cannot collide with — or tear down — the operator's own.
: "${REPOPULSE_PROJECT:=repopulse}"

if [ ! -f .env ]; then
  die "deploy/.env is missing. Copy .env.example and fill it in:
    cp deploy/.env.example deploy/.env"
fi

# ------------------------------------------------- overlays (W20-16, AI-74) ---
# Extra compose files that must be part of EVERY start, read the way compose
# reads its own variables (shell, then deploy/.env). The Claude Code CLI
# overlay is the reason: run once without it and the worker is recreated
# without its CLI volume, and every CLI connection silently starts failing.
# `--with-claude-cli` records it in deploy/.env so a later plain `up.sh`
# (restart, upgrade) keeps it.
WITH_CLAUDE_CLI=0
passthrough=()
for arg in "$@"; do
  if [ "$arg" = --with-claude-cli ]; then WITH_CLAUDE_CLI=1; else passthrough+=("$arg"); fi
done
set -- ${passthrough[@]+"${passthrough[@]}"}

extra_files="$(env_value COMPOSE_EXTRA_FILES)"
if [ "$WITH_CLAUDE_CLI" = 1 ]; then
  [ -f compose.claude-cli.yaml ] ||
    die "--with-claude-cli: deploy/compose.claude-cli.yaml is missing from this install."
  case " $extra_files " in
    *" compose.claude-cli.yaml "*) ;;
    *)
      extra_files="${extra_files:+$extra_files }compose.claude-cli.yaml"
      # Rewrite the one line (or add it), leaving every other line as it was.
      tmp_env="$(mktemp .env.XXXXXX)"
      grep -v '^COMPOSE_EXTRA_FILES=' .env > "$tmp_env" || true
      printf 'COMPOSE_EXTRA_FILES=%s\n' "$extra_files" >> "$tmp_env"
      chmod --reference=.env "$tmp_env" 2>/dev/null || chmod 600 "$tmp_env"
      mv "$tmp_env" .env
      echo "overlays:   recorded COMPOSE_EXTRA_FILES=$extra_files in deploy/.env"
      ;;
  esac
fi
COMPOSE_FILES=(-f compose.yaml)
for f in $extra_files; do
  case "$f" in
    */* | *..*) die "COMPOSE_EXTRA_FILES: '$f' must be a file name inside deploy/, not a path." ;;
  esac
  [ -f "$f" ] || die "COMPOSE_EXTRA_FILES names '$f', which is not in deploy/."
  COMPOSE_FILES+=(-f "$f")
done

# ---------------------------------------------------------------- runtime ----
# Explicit beats detection. On a host with both runtimes installed, detection
# alone silently picks one, and the operator discovers which only when their
# containers are somewhere they did not look.
case "${RUNTIME:-}" in
  podman | docker)
    command -v "$RUNTIME" >/dev/null 2>&1 ||
      die "RUNTIME=$RUNTIME was requested but '$RUNTIME' is not on PATH."
    RT="$RUNTIME"
    ;;
  '')
    if command -v podman >/dev/null 2>&1; then
      RT=podman
    elif command -v docker >/dev/null 2>&1; then
      RT=docker
    else
      die "Neither podman nor docker is on PATH.
Install one, or set RUNTIME=docker|podman to name the one you want."
    fi
    ;;
  *)
    die "RUNTIME must be 'docker' or 'podman' (got: $RUNTIME)."
    ;;
esac

COMPOSE=("$RT" compose)

# A runtime binary is not a compose provider. podman needs podman-compose (or
# docker-compose) installed separately, and failing here — with the provider's
# own words — beats failing later inside an `up` that half-worked.
if ! provider_err="$("${COMPOSE[@]}" version 2>&1)"; then
  die "'$RT compose' is not usable on this host:

$provider_err

Install a compose provider for $RT, or set RUNTIME to the other runtime."
fi

# Absolute, because podman-compose does not resolve a relative bind-mount source
# against the compose file's directory — it resolves it against the caller's cwd,
# or not at all. `pwd` here is deploy/, since we cd'd above.
SCAN_RULES_DIR="$(env_value SCAN_RULES_DIR)"
: "${SCAN_RULES_DIR:=$(pwd)/scan-rules}"
export SCAN_RULES_DIR

# Create it rather than fail on it. An empty rules directory is a WORKING stack
# with dependency scanning unavailable, which the Security tab already says
# plainly ("No dependency scan has run for this repository — the CVE scanner is
# not available yet, so this is not a clean bill of health"). A missing directory
# is a stack with no ingestion at all and no explanation. The first is a state a
# person can understand and fix; the second is not.
mkdir -p "$SCAN_RULES_DIR"

# Internal CA trust (optional). api and worker mount this directory read-only
# at /etc/repopulse/ca; it does nothing until .env sets NODE_EXTRA_CA_CERTS to
# a PEM inside it. Created empty for the same reason as the scan-rules
# directory: a missing bind source stops the containers from being created.
EXTRA_CA_DIR="$(env_value EXTRA_CA_DIR)"
: "${EXTRA_CA_DIR:=$(pwd)/ca}"
export EXTRA_CA_DIR
mkdir -p "$EXTRA_CA_DIR"

# ------------------------------------------------------- scan-runner (W17-27)
# The scan-runner service is the one container holding the runtime's socket,
# so the socket path has to be known here, on the host, and it differs by
# runtime and by rootless-ness. Explicit CONTAINER_SOCKET wins; otherwise:
#   rootless podman  $XDG_RUNTIME_DIR/podman/podman.sock   (systemctl --user enable --now podman.socket)
#   root podman      /run/podman/podman.sock               (systemctl enable --now podman.socket)
#   docker           /var/run/docker.sock
# A missing socket is refused HERE, with the command that creates it, rather
# than discovered as a scan-runner that restarts forever.
: "${SCAN_RUNTIME:=$RT}"
export SCAN_RUNTIME
if [ -z "${CONTAINER_SOCKET:-}" ]; then
  if [ "$RT" = docker ]; then
    CONTAINER_SOCKET=/var/run/docker.sock
  else
    # Ask podman first (W17-28): `podman info` reports the socket path AS THE
    # SERVER SEES IT, which is the path the daemon can bind into scan-runner.
    # Under podman machine that is the VM's path and differs from anything
    # derivable on the macOS client. It answers with a unix:// scheme; compose
    # wants the bare path. The derivation below is the fallback for a podman
    # that does not report one.
    CONTAINER_SOCKET="$(podman info --format '{{.Host.RemoteSocket.Path}}' 2>/dev/null | sed 's#^unix://##' || true)"
    if [ -z "$CONTAINER_SOCKET" ]; then
      if [ "$(id -u)" = 0 ]; then
        CONTAINER_SOCKET=/run/podman/podman.sock
      else
        CONTAINER_SOCKET="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock"
      fi
    fi
  fi
fi
export CONTAINER_SOCKET
# A WARNING, not a refusal: under podman machine (macOS) the path lives inside
# the VM and is not visible here, so absence proves nothing on that host. On a
# Linux host it almost always means the API socket was never enabled — and the
# verification below then names scan-runner as not running, because a bind
# mount whose source is missing fails at container creation. The instruction
# is printed here, ahead of that, so the failure arrives with its fix.
if [ ! -S "$CONTAINER_SOCKET" ]; then
  echo "WARNING: CONTAINER_SOCKET=$CONTAINER_SOCKET is not a socket on this machine." >&2
  if [ "$RT" = docker ]; then
    echo "         scan-runner needs the docker socket. Is the daemon running? Set" >&2
    echo "         CONTAINER_SOCKET if it listens elsewhere." >&2
  else
    echo "         scan-runner needs the podman API socket. Enable it with" >&2
    echo "           systemctl --user enable --now podman.socket   # rootless" >&2
    echo "           sudo systemctl enable --now podman.socket     # root" >&2
    echo "         (under podman machine on macOS the path is the VM's; ignore this)." >&2
  fi
fi

# W20-07 (UX_TODO INS-74). A first single-sign-on or GitHub sign-in is never
# made administrator (an unverified IdP email must not be able to claim the
# install), so an install with SSO and no ADMIN_EMAIL has nobody who can
# connect a forge. A warning, not a refusal: an install whose admin already
# exists has every right to remove the variables afterwards.
if [ -z "$(env_value ADMIN_EMAIL)" ] &&
  { [ -n "$(env_value OIDC_ISSUER)" ] || [ -n "$(env_value GITHUB_APP_CLIENT_ID)" ]; }; then
  echo "WARNING: single sign-on is configured but ADMIN_EMAIL is empty." >&2
  echo "         A first SSO/GitHub sign-in is never made administrator. On a new" >&2
  echo "         install, add ADMIN_EMAIL= and ADMIN_PASSWORD= to deploy/.env and rerun" >&2
  echo "         deploy/up.sh, sign in with them, then promote people in Settings → Members." >&2
fi

# W20-07 (UX_TODO INS-66). Rootless podman has no daemon: restart:
# unless-stopped brings nothing back after a reboot unless the user lingers
# and podman-restart.service is enabled. Say so while the operator is here,
# not after the first patch-night reboot.
if [ "$RT" = podman ] && [ "$(id -u)" != 0 ] && command -v loginctl >/dev/null 2>&1; then
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = no ]; then
    echo "WARNING: this stack will not come back after the host reboots." >&2
    echo "         Rootless podman needs lingering and its restart service:" >&2
    echo "           sudo loginctl enable-linger $(id -un)" >&2
    echo "           systemctl --user enable podman-restart.service" >&2
  fi
fi

echo "runtime:    $RT (compose project: $REPOPULSE_PROJECT)"
[ -n "$extra_files" ] && echo "overlays:   $extra_files"
echo "scan-runner: $SCAN_RUNTIME via $CONTAINER_SOCKET, listening on the internal scan network"
if ! grep -qE '^SCAN_RUNNER_TOKEN=.+' .env; then
  die "SCAN_RUNNER_TOKEN is missing from deploy/.env. It is the shared secret between
the worker and the scan-runner; without it the runner refuses to start. Add a
long random value, e.g.:
    echo \"SCAN_RUNNER_TOKEN=$(openssl rand -hex 32)\" >> deploy/.env
(deploy/configure.mjs generates it for new installs.)"
fi
echo "scan rules: $SCAN_RULES_DIR"
if [ -z "$(ls -A "$SCAN_RULES_DIR" 2>/dev/null | grep -v '^README.md$\|^\.gitignore$' || true)" ]; then
  echo "  (empty — dependency scanning will report itself unavailable until you"
  echo "   run deploy/scan-db-sync.sh, which needs ~2 GB for the grype database)"
fi

# ------------------------------------------------------- images (W17-28) -----
# A compose file with no `build:` is a bundle install: the images must ALREADY
# be loaded under the exact name and tag .env pins, because there is no source
# here to build them from. Checked before `up`, because what compose says when
# an image is missing and cannot be built is a pull attempt against a registry
# that does not exist ("localhost/repopulse/api: name unknown"), which sends
# the operator looking at their network instead of at `load`.
#
# The two variables are read the way compose reads them: the shell first, then
# deploy/.env. Left unset, compose would fall back to :dev — the floating tag
# a bundle exists to avoid — so an unset version is refused here as well.
if [ -f compose.yaml ] && ! grep -q '^    build:' compose.yaml; then
  version="$(env_value REPOPULSE_VERSION)"
  prefix="$(env_value REPOPULSE_IMAGE_PREFIX)"
  : "${prefix:=repopulse}"
  case "$version" in
    '' | dev | latest)
      die "REPOPULSE_VERSION is '${version:-unset}' in deploy/.env, but this compose file has no
build: stanzas — it runs pre-built images and must name which. Set
REPOPULSE_VERSION (and SCAN_IMAGE) in deploy/.env to the version that was
loaded; a bundle's install.sh writes both."
      ;;
  esac
  missing=""
  for name in migrate api worker scan-runner web; do
    img="$prefix/$name:$version"
    if ! "$RT" image exists "$img" 2>/dev/null && ! "$RT" image inspect "$img" >/dev/null 2>&1; then
      missing="$missing
    $img"
    fi
  done
  if [ -n "$missing" ]; then
    die "IMAGES NOT LOADED. deploy/.env pins version $version but these are not present:$missing

Nothing was started. Load the bundle's images first:
    $RT load -i images/repopulse-images.tar
(or run ./install.sh from the bundle directory, which does this and checks it)."
  fi
  echo "images:     $prefix/*:$version (all present)"
fi

# ------------------------------------------------------------------- up ------
# `|| true` used to hide the reason a stack failed to start. The exit status of
# the compose wrapper still cannot be trusted on its own — the run that left the
# worker dead exited 0 — so the verification below remains the real gate, but a
# non-zero compose now prints what compose actually said.
set +e
compose_out="$("${COMPOSE[@]}" -p "$REPOPULSE_PROJECT" "${COMPOSE_FILES[@]}" up -d "$@" 2>&1)"
compose_rc=$?
set -e
printf '%s\n' "$compose_out"

# ---------------------------------------------------------------- verify -----
# Container state comes from the runtime, addressed by the compose labels BOTH
# providers set (verified: podman-compose 1.6.0 writes com.docker.compose.project
# and com.docker.compose.service, the same keys docker compose uses). Grepping
# `compose ps` text was fragile in the way that matters — its columns and its
# name mangling differ per provider, so the check could pass on one and silently
# never match on the other.
container_for() { # $1 = compose service name -> container id, or empty
  "$RT" ps -a \
    --filter "label=com.docker.compose.project=$REPOPULSE_PROJECT" \
    --filter "label=com.docker.compose.service=$1" \
    --format '{{.ID}}' 2>/dev/null | head -n1
}

inspect_field() { # $1 = container id, $2 = go template -> value, or empty
  "$RT" inspect "$1" --format "$2" 2>/dev/null || true
}

EXPECTED="postgres redis api worker scan-runner web"

# migrate is a one-shot job, so "running" is the wrong question for it — but
# "exited" was the wrong answer. A migration that fails also exits, and the old
# check treated that as success, producing a stack that looks healthy against a
# schema that was never applied.
migrate_id="$(container_for migrate)"
if [ -n "$migrate_id" ]; then
  deadline=$(( $(date +%s) + REPOPULSE_UP_TIMEOUT ))
  while :; do
    m_status="$(inspect_field "$migrate_id" '{{.State.Status}}')"
    [ "$m_status" != "running" ] && [ "$m_status" != "created" ] && break
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep 2
  done
  m_code="$(inspect_field "$migrate_id" '{{.State.ExitCode}}')"
  if [ "$m_status" = "running" ]; then
    die "Database migration did not finish within ${REPOPULSE_UP_TIMEOUT}s.
Logs:
    $RT logs $migrate_id"
  fi
  if [ "${m_code:-1}" != "0" ]; then
    # W17-28: the one cause worth naming. Postgres sets its password ONLY when
    # it initialises an empty volume, so a data volume left behind by an
    # earlier install (or a deploy/.env regenerated after the old one was
    # lost) fails every connection with 28P01 — and the migration is the
    # first thing to notice. Seen on the bundle smoke against a volume from a
    # month-old install. Without this hint the operator is sent to read a
    # Node stack trace ending in `auth_failed`.
    hint=""
    if "$RT" logs "$migrate_id" 2>&1 | grep -q "28P01\|password authentication failed"; then
      hint="
The migration could not AUTHENTICATE to Postgres (28P01). The data volume
'${REPOPULSE_PROJECT}_pgdata' already existed with a different password than
deploy/.env now holds — Postgres only sets the password when it initialises
an empty volume. Either restore the deploy/.env that matches that volume, or,
if the old data is not wanted, remove it and start again:
    $RT compose -p $REPOPULSE_PROJECT -f compose.yaml down
    $RT volume rm ${REPOPULSE_PROJECT}_pgdata ${REPOPULSE_PROJECT}_redisdata   # DESTROYS that data
"
    fi
    # STOP THE APP TIER OURSELVES (W17-29). docker compose holds api and worker
    # back when a `service_completed_successfully` dependency fails;
    # podman-compose 1.6 does not — measured in the W17-29 drill, api and
    # worker were running against the un-migrated schema while this message
    # said nothing had been started. The promise below is now kept by hand,
    # on both providers.
    "${COMPOSE[@]}" -p "$REPOPULSE_PROJECT" "${COMPOSE_FILES[@]}" stop web api worker scan-runner >/dev/null 2>&1 || true
    die "DATABASE MIGRATION FAILED (exit ${m_code:-unknown}).

The stack is not usable: the schema was not applied. api, worker and web have
been stopped on purpose, because an API serving a half-migrated database is
worse than an API that is down. Postgres and Redis are still running; your
data is as it was (migrations apply in one transaction).
$hint
Logs:
    $RT logs $migrate_id"
  fi
fi

# Wait, bounded, rather than inspect once. The old check ran the instant compose
# returned, so a service that was still starting counted as failed.
deadline=$(( $(date +%s) + REPOPULSE_UP_TIMEOUT ))
while :; do
  failed=""
  for svc in $EXPECTED; do
    cid="$(container_for "$svc")"
    if [ -z "$cid" ]; then
      failed="$failed $svc"
      continue
    fi
    status="$(inspect_field "$cid" '{{.State.Status}}')"
    if [ "$status" != "running" ]; then
      failed="$failed $svc"
      continue
    fi
    # Only services that DECLARE a healthcheck are held to it. `{{.State.Health}}`
    # is empty for the rest, and demanding health from a service that never
    # reports any would hang until the deadline on a working stack.
    health="$(inspect_field "$cid" '{{if .State.Health}}{{.State.Health.Status}}{{end}}')"
    if [ -n "$health" ] && [ "$health" != "healthy" ]; then
      failed="$failed $svc"
    fi
  done
  [ -z "$failed" ] && break
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep 3
done

if [ -n "$failed" ]; then
  echo >&2
  if [ "$compose_rc" -ne 0 ]; then
    echo "compose exited $compose_rc — its output is above." >&2
  fi
  echo "STACK IS NOT HEALTHY after ${REPOPULSE_UP_TIMEOUT}s — these services are not running:$failed" >&2
  echo >&2
  echo "The web tier may still answer on the published port, so do not take a" >&2
  echo "loading page as proof the stack came up. Logs for one of them:" >&2
  echo "    $RT compose -p $REPOPULSE_PROJECT -f deploy/compose.yaml logs${failed}" >&2
  exit 1
fi

echo
# The port the way compose resolved it — shell, then .env — so an install
# configured with --port=8199 is not told to open 8099 (W17-28).
port="$(env_value REPOPULSE_PORT)"
echo "All services running. Open http://localhost:${port:-8099}"
# W20-17 (UX_TODO INS-23): say where the install is reachable from outside,
# who signs in first, and what comes next, instead of only a localhost URL.
public_url="$(env_value PUBLIC_BASE_URL)"
admin_email="$(env_value ADMIN_EMAIL)"
if [ -n "$public_url" ]; then
  echo "Public address (PUBLIC_BASE_URL): $public_url"
fi
echo
echo "Next steps:"
if [ -n "$admin_email" ]; then
  echo "  1. Sign in as $admin_email with ADMIN_PASSWORD; you will be asked to change it."
else
  echo "  1. Sign in with your configured single sign-on."
fi
echo "  2. Open Settings → Setup and work down the checklist."
echo "  3. Connect a forge (Settings → Connections) and choose repositories."
echo "  4. Watch the first sync in Settings → Sync."
