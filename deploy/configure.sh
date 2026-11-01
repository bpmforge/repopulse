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
#                       (--userns=keep-id under rootless podman on Linux)
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

# A checkout carries the Dockerfile one level up and a compose file with build:
# stanzas; a bundle carries neither and ships the images instead. The checkout
# install runs this BEFORE deploy/up.sh --build, so in a checkout the migrate
# image does not exist yet and is built here (W22-15, G1: the documented steps
# were circular — this needed the image, only up.sh built it, and up.sh needs the
# .env this writes). In a bundle a missing image means `load` was skipped.
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
is_checkout() {
  [ -f "$REPO_ROOT/Dockerfile" ] && [ -f "$DEPLOY_DIR/compose.yaml" ] &&
    grep -q '^    build:' "$DEPLOY_DIR/compose.yaml"
}

if ! "$RT" image exists "$IMAGE" 2>/dev/null && ! "$RT" image inspect "$IMAGE" >/dev/null 2>&1; then
  if ! is_checkout; then
    die "The image '$IMAGE' is not present locally.

Load the images that came with this bundle first:
    $RT load -i images/repopulse-images.tar

Configuration runs inside that image so this host does not need Node."
  fi
  # The Dockerfile uses BuildKit features (FROM --platform=$BUILDPLATFORM). The
  # legacy builder Ubuntu's docker.io falls back to without buildx dies on it
  # with "failed to parse platform", which names nothing useful (W22-15, D2).
  if [ "$RT" = docker ] && ! docker buildx version >/dev/null 2>&1; then
    die "Docker's buildx plugin is missing, and the RepoPulse images need it to build.
Install it (Ubuntu/Debian: sudo apt-get install docker-buildx; Docker's own
packages: docker-buildx-plugin), then run this again."
  fi
  echo "Building $IMAGE from this checkout (once; configuration runs inside it)..."
  "$RT" build -f "$REPO_ROOT/Dockerfile" --target migrate -t "$IMAGE" "$REPO_ROOT" >&2 ||
    die "Building $IMAGE failed; the build output is above."
fi

# The generated .env must belong to the person who ran this, not to root or to
# a subordinate uid.
#   docker:          --user <uid>:<gid>, because the daemon runs as root.
#   rootless podman: --userns=keep-id. Under rootless podman the operator is
#                    root INSIDE the user namespace, so --user <uid>:<gid> named a
#                    subordinate uid that does not own deploy/ and the write
#                    failed with EACCES (W22-15, G2; seen on Ubuntu 24.04 and
#                    26.04). keep-id maps the operator to themself.
#   podman machine:  the macOS client talks to a VM over a virtiofs mount that
#                    ignores ownership, where --user has always worked; keep it.
uid="$(id -u)"
gid="$(id -g)"
user_args=(--user "${uid}:${gid}")
if [ "$RT" = podman ] && [ "$(uname -s)" = Linux ] && [ "$uid" != 0 ]; then
  user_args=(--userns=keep-id)
fi

exec "$RT" run --rm \
  --entrypoint node \
  --network none \
  "${user_args[@]}" \
  -v "$DEPLOY_DIR:/deploy:rw" \
  -e "REPOPULSE_DEPLOY_DIR=/deploy" \
  -e "ADMIN_PASSWORD=${ADMIN_PASSWORD:-}" \
  "$IMAGE" \
  /deploy/configure.mjs "$@"
