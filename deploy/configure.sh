#!/usr/bin/env bash
# Write deploy/.env for a customer install, WITHOUT needing Node on the host
# (W17-05).
#
# The customer requirement is a container runtime and nothing else. So when the
# host has no `node`, this runs configure.mjs inside the migrate image — which is
# already part of the stack and already pinned to the same Node the product runs
# on — with:
#
#   --entrypoint node   the image's own entrypoint is the migration job
#   --network none      configuration talks to nothing; it only writes a file
#   -v <deploy>:/deploy the ONLY writable path, so a bug cannot touch the host
#   --user <uid>:<gid>  so the .env belongs to the operator, not to root
#
# A developer with Node installed skips all of that and runs the script directly,
# which is why the file is plain .mjs with no build step.

set -euo pipefail

cd "$(dirname "$0")"
DEPLOY_DIR="$(pwd)"

die() {
  echo >&2
  echo "$*" >&2
  exit 1
}

# Host Node is the simple path when it exists and is new enough. `node` on an
# ancient system Node would fail inside the script with a syntax error rather
# than a sentence, so the version is checked here.
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${node_major:-0}" -ge 22 ]; then
    exec node "$DEPLOY_DIR/configure.mjs" "$@"
  fi
fi

# ------------------------------------------------------- containerised -------
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
      die "This host has neither Node 22+ nor a container runtime.

RepoPulse needs one of them to write its configuration:
  - install podman or docker (recommended — you need it to run the product), or
  - install Node 22+ and run deploy/configure.mjs directly."
    fi
    ;;
  *)
    die "RUNTIME must be 'docker' or 'podman' (got: $RUNTIME)."
    ;;
esac

IMAGE="${REPOPULSE_IMAGE_PREFIX:-repopulse}/migrate:${REPOPULSE_VERSION:-dev}"

if ! "$RT" image exists "$IMAGE" 2>/dev/null && ! "$RT" image inspect "$IMAGE" >/dev/null 2>&1; then
  die "The image '$IMAGE' is not present locally.

Load the images that came with this bundle first:
    $RT load -i images/repopulse-images.tar

Configuration runs inside that image so this host does not need Node."
fi

# Match the invoking user so the generated .env is editable by the person who
# ran this, rather than owned by root. Podman rootless already maps the user, so
# this is the docker case mostly, and harmless on both.
uid="$(id -u)"
gid="$(id -g)"

exec "$RT" run --rm \
  --entrypoint node \
  --network none \
  --user "${uid}:${gid}" \
  -v "$DEPLOY_DIR:/deploy:rw" \
  -e "REPOPULSE_DEPLOY_DIR=/deploy" \
  -e "ADMIN_PASSWORD=${ADMIN_PASSWORD:-}" \
  "$IMAGE" \
  /deploy/configure.mjs "$@"
