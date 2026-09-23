#!/usr/bin/env bash
# Install RepoPulse from this bundle (W17-28). Run from the extracted directory:
#
#   ./install.sh --url=https://repopulse.example.com [--port=8099] [--admin-email=you@example.com]
#
# Needs a container runtime (podman or docker, with `compose`) and nothing else:
# no Node, no pnpm, no source, no registry access. Everything the product runs
# is in images/repopulse-images.tar, already versioned.
#
# Steps, each of which stops with a sentence when it fails:
#   1. verify every file against SHA256SUMS   — a truncated copy is refused
#   2. check the CPU architecture              — the images run on one arch only
#   3. load the images                         — and confirm each is present
#   4. write deploy/.env                       — once; a rerun never rewrites it
#   5. start the stack with deploy/up.sh       — which verifies every service
#
# Rerunning is safe: images reload idempotently, .env is preserved byte for
# byte, migrations are a no-op on an applied schema, and data lives in named
# volumes that `up` never touches.

set -euo pipefail

cd "$(dirname "$0")"
BUNDLE_DIR="$(pwd)"

die() {
  echo >&2
  echo "$*" >&2
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    -h | --help)
      sed -n '2,19p' "$0"
      exit 0
      ;;
  esac
done

[ -f VERSION ] && [ -f manifest.json ] && [ -f SHA256SUMS ] ||
  die "This does not look like an extracted RepoPulse bundle: VERSION, manifest.json or SHA256SUMS is missing in $BUNDLE_DIR."

# shellcheck disable=SC1091
. ./VERSION
export REPOPULSE_VERSION REPOPULSE_IMAGE_PREFIX
echo "RepoPulse $REPOPULSE_VERSION ($PLATFORM), built from $GIT_SHA"

# ---------------------------------------------------------- 1. checksums ----
if command -v sha256sum >/dev/null 2>&1; then
  SUM=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SUM=(shasum -a 256)
else
  die "Neither sha256sum nor shasum is on PATH; cannot verify the bundle."
fi
echo "== verifying checksums"
if ! "${SUM[@]}" --check --quiet SHA256SUMS; then
  die "CHECKSUM MISMATCH. A file in this bundle is not the one that was packed.
Do not install from it: copy the tarball again and compare it against its
.sha256 before extracting."
fi

# --------------------------------------------------------- 2. architecture --
host_arch="$(uname -m)"
case "$host_arch" in
  x86_64 | amd64) host_arch=amd64 ;;
  aarch64 | arm64) host_arch=arm64 ;;
esac
want_arch="${PLATFORM#*/}"
# REPOPULSE_ALLOW_EMULATED_ARCH=1 is a TEST hatch: it lets a build host smoke a
# cross-built bundle under qemu/Rosetta emulation. Emulated is slow and proves
# the images start, not that they perform; never set it on a real install.
arch_mismatch() {
  if [ "${REPOPULSE_ALLOW_EMULATED_ARCH:-}" = 1 ]; then
    echo "WARNING: $1 — continuing under emulation because REPOPULSE_ALLOW_EMULATED_ARCH=1 (testing only)." >&2
  else
    die "$2"
  fi
}
if [ "$host_arch" != "$want_arch" ]; then
  arch_mismatch "host is $(uname -m), bundle is $PLATFORM" "ARCHITECTURE MISMATCH: this bundle holds $PLATFORM images and this host is $(uname -m).
The images will not run here. Use the bundle built for $host_arch, or build
one on a $host_arch host (deploy/bundle.sh in the source repository).
See ARCHITECTURES.md for what has actually been tested."
fi

# --------------------------------------------------------- 3. runtime -------
case "${RUNTIME:-}" in
  podman | docker)
    command -v "$RUNTIME" >/dev/null 2>&1 || die "RUNTIME=$RUNTIME was requested but '$RUNTIME' is not on PATH."
    RT="$RUNTIME"
    ;;
  '')
    if command -v podman >/dev/null 2>&1; then RT=podman
    elif command -v docker >/dev/null 2>&1; then RT=docker
    else die "Neither podman nor docker is on PATH. Install one (see README.md), or set RUNTIME=docker|podman."; fi
    ;;
  *) die "RUNTIME must be 'docker' or 'podman' (got: $RUNTIME)." ;;
esac
export RUNTIME="$RT"
if ! provider_err="$("$RT" compose version 2>&1)"; then
  die "'$RT compose' is not usable on this host:

$provider_err

Install a compose provider for $RT (podman-compose, or the docker compose plugin)."
fi
echo "runtime: $RT ($("$RT" --version 2>/dev/null | head -n1))"

# Under podman machine (macOS) the VM, not this shell, is the host the images
# run on. Its arch is what matters, and it can differ from uname on the client.
if [ "$RT" = podman ]; then
  rt_arch="$("$RT" info --format '{{.Host.Arch}}' 2>/dev/null || true)"
  case "$rt_arch" in x86_64) rt_arch=amd64 ;; aarch64) rt_arch=arm64 ;; esac
  if [ -n "$rt_arch" ] && [ "$rt_arch" != "$want_arch" ]; then
    arch_mismatch "podman runs $rt_arch, bundle is $PLATFORM" "ARCHITECTURE MISMATCH: this bundle holds $PLATFORM images but podman here runs $rt_arch containers."
  fi
fi

# ------------------------------------------------------------ 4. load -------
echo "== loading images (this reads $(du -h images/repopulse-images.tar | cut -f1); a minute or two)"
"$RT" load -i images/repopulse-images.tar

missing=""
for name in migrate api worker scan-runner web scan; do
  img="$REPOPULSE_IMAGE_PREFIX/$name:$REPOPULSE_VERSION"
  if ! "$RT" image exists "$img" 2>/dev/null && ! "$RT" image inspect "$img" >/dev/null 2>&1; then
    missing="$missing $img"
  fi
done
[ -z "$missing" ] || die "IMAGES MISSING after load:$missing
The archive did not contain what manifest.json says it does. The bundle is
damaged; re-copy it (the checksum step passed, so this is a bug — report it)."
echo "images:  6 loaded as $REPOPULSE_IMAGE_PREFIX/<name>:$REPOPULSE_VERSION"

# ----------------------------------------------------------- 5. configure ---
# configure.sh runs inside the migrate image when the host has no Node — it
# finds that image through the two variables exported above. It never
# rewrites an existing deploy/.env (rotating TOKEN_ENC_KEY would orphan every
# stored forge credential), which is what makes rerunning install.sh safe.
if [ ! -f deploy/.env ]; then
  echo "== writing deploy/.env"
  deploy/configure.sh "$@"
  # Pin this install to the images that came with it. compose reads deploy/.env
  # for its ${...} substitutions, so these three lines are what stop a later
  # `up` from looking for :dev. Appended after configure.sh so its exclusive
  # creation and validation are untouched.
  {
    echo
    echo "# --- pinned by install.sh to the images in this bundle (W17-28) ---"
    echo "REPOPULSE_VERSION=$REPOPULSE_VERSION"
    echo "REPOPULSE_IMAGE_PREFIX=$REPOPULSE_IMAGE_PREFIX"
    echo "SCAN_IMAGE=$REPOPULSE_IMAGE_PREFIX/scan:$REPOPULSE_VERSION"
  } >> deploy/.env
else
  echo "== deploy/.env exists — keeping it (secrets are never regenerated)"
  if ! grep -q "^REPOPULSE_VERSION=$REPOPULSE_VERSION\$" deploy/.env; then
    have="$(grep '^REPOPULSE_VERSION=' deploy/.env || echo 'REPOPULSE_VERSION=<unset>')"
    die "deploy/.env pins $have but this bundle is $REPOPULSE_VERSION.
To upgrade, change REPOPULSE_VERSION and SCAN_IMAGE in deploy/.env to
$REPOPULSE_VERSION (see README.md, Upgrading) and run ./install.sh again.
Nothing was started."
  fi
fi

# --------------------------------------------------------------- 6. up ------
echo "== starting"
exec deploy/up.sh
