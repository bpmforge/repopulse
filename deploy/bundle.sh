#!/usr/bin/env bash
# Produce a portable install bundle (W17-28).
#
#   deploy/bundle.sh --version=0.2.0 [--out=dist] [--no-build] [--no-base-pull] [--arch=amd64|arm64]
#   deploy/bundle.sh strip-compose deploy/compose.yaml     # the compose rewrite, alone
#
# WHAT A BUNDLE IS. One tarball a customer copies to a host that has a container
# runtime and NOTHING else — no checkout, no Node, no pnpm, no registry access:
#
#   repopulse-<version>-<os>-<arch>/
#     install.sh                verify → load → configure → up, in that order
#     README.md                 how to install, upgrade, back up, troubleshoot
#     RUNBOOK.md                the full operating guide (restore onto a new server, outages)
#     ARCHITECTURES.md          what was built and smoke-tested, and what was NOT
#     VERSION                   the version tag, and the commit it was built from
#     manifest.json             images by name, id and digest; build host; runtime
#     SHA256SUMS                every file above and the image archive
#     images/repopulse-images.tar   ONE multi-image docker-archive: our six
#                               images plus the postgres and redis they run with
#     deploy/compose.yaml       deploy/compose.yaml with every `build:` removed
#     deploy/.env.example, configure.sh, configure.mjs, up.sh, backup.sh,
#     deploy/restore.sh, rotate-token-key.sh, scan-db-sync.sh, smoke-report-pdf.sh,
#     rulepacks/, scan-rules/
#     RUNBOOK.md                operating it: backup, restore onto a new server,
#                               upgrade, rotating secrets, when the app is down
#
# THE VERSION IS REQUIRED AND EXPLICIT. `dev` and `latest` are refused: a
# customer host running `repopulse/api:dev` is a host nobody can say the
# contents of, and a floating tag is what makes "roll back" impossible. The
# tag goes into every image name, the archive, the manifest and the tarball
# name, so a bundle and the images inside it cannot disagree about what they
# are. No registry is named anywhere: images are `localhost/repopulse/<name>`
# on the customer host, loaded from the archive. Publishing is a separate,
# separately authorised step and this script does not do it.
#
# ONE ARCHITECTURE PER BUNDLE: by default the one this host's runtime builds
# natively. --arch= builds for another one under emulation (every build and
# base-image pull gets --platform); the manifest then records "emulated": true,
# because an image that built under qemu/Rosetta is not proof it runs well on
# real hardware. The bundle name carries the arch and install.sh refuses a
# mismatched host.
# ARCHITECTURES.md is the declared matrix and is maintained from smoke results,
# not from this script's opinion.

set -euo pipefail

die() {
  echo >&2
  echo "$*" >&2
  exit 1
}

# ----------------------------------------------------------- strip-compose --
# The bundle has no source, so its compose file must have no `build:`. Every
# build block in deploy/compose.yaml is exactly `    build:` followed by lines
# indented six spaces (context / dockerfile / target). Dropping those, and only
# those, leaves every other line — comments included — byte-for-byte. Kept as
# a subcommand so a test can pin that behaviour without producing a bundle.
strip_compose() {
  awk '
    /^    build:[ \t]*$/ { skipping = 1; next }
    skipping && /^      / { next }
    { skipping = 0; print }
  ' "$1"
}

if [ "${1:-}" = strip-compose ]; then
  [ -n "${2:-}" ] && [ -f "$2" ] || die "usage: $0 strip-compose <compose.yaml>"
  strip_compose "$2"
  exit 0
fi

# ---------------------------------------------------------------- args ------
VERSION=""
OUT="dist"
BUILD=1
PULL_BASE=1
TARGET_ARCH=""
for arg in "$@"; do
  case "$arg" in
    --version=*) VERSION="${arg#--version=}" ;;
    --out=*) OUT="${arg#--out=}" ;;
    --no-build) BUILD=0 ;;
    --no-base-pull) PULL_BASE=0 ;;
    --arch=*) TARGET_ARCH="${arg#--arch=}" ;;
    -h | --help)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg (see --help)" ;;
  esac
done
: "${VERSION:=${REPOPULSE_VERSION:-}}"

# Refused, not defaulted. The whole point of the bundle is that its contents
# are nameable; a default here would be the floating tag the ticket forbids.
[ -n "$VERSION" ] || die "--version is required (or REPOPULSE_VERSION). Example: --version=0.2.0
Not 'dev' and not 'latest': the tag must name a release."
case "$VERSION" in
  dev | latest | demo | slim) die "--version=$VERSION is not a release tag. Use a version, e.g. 0.2.0." ;;
esac
# An image tag: OCI reference grammar, and it starts with a digit so it reads
# as a version rather than a branch name.
[[ "$VERSION" =~ ^[0-9][A-Za-z0-9_.-]{0,127}$ ]] ||
  die "--version=$VERSION is not a valid image tag (start with a digit; [A-Za-z0-9_.-] only)."

case "$TARGET_ARCH" in
  '' | amd64 | arm64) ;;
  *) die "--arch=$TARGET_ARCH is not supported (amd64 or arm64)." ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ------------------------------------------------------------- runtime ------
case "${RUNTIME:-}" in
  podman | docker)
    command -v "$RUNTIME" >/dev/null 2>&1 || die "RUNTIME=$RUNTIME is not on PATH."
    RT="$RUNTIME"
    ;;
  '')
    if command -v podman >/dev/null 2>&1; then RT=podman
    elif command -v docker >/dev/null 2>&1; then RT=docker
    else die "Neither podman nor docker is on PATH."; fi
    ;;
  *) die "RUNTIME must be 'docker' or 'podman' (got: $RUNTIME)." ;;
esac

# The arch the RUNTIME builds for, not the arch of this shell: under podman
# machine the client is macOS and the images are Linux.
if [ "$RT" = podman ]; then
  RT_OS="$($RT info --format '{{.Host.OS}}')"
  RT_ARCH="$($RT info --format '{{.Host.Arch}}')"
  RT_VERSION="$($RT info --format '{{.Version.Version}}')"
else
  RT_OS="$($RT info --format '{{.OSType}}')"
  RT_ARCH="$($RT info --format '{{.Architecture}}')"
  RT_VERSION="$($RT version --format '{{.Server.Version}}')"
fi
case "$RT_ARCH" in
  x86_64) RT_ARCH=amd64 ;;
  aarch64) RT_ARCH=arm64 ;;
esac
EMULATED=false
PLATFORM_ARGS=()
if [ -n "$TARGET_ARCH" ]; then
  if [ "$TARGET_ARCH" != "$RT_ARCH" ]; then EMULATED=true; fi
  RT_ARCH="$TARGET_ARCH"
  PLATFORM_ARGS=(--platform "${RT_OS}/${RT_ARCH}")
fi
PLATFORM="${RT_OS}/${RT_ARCH}"

PREFIX="localhost/repopulse"
NAME="repopulse-${VERSION}-${RT_OS}-${RT_ARCH}"
STAGE="$OUT/$NAME"
TARBALL="$OUT/$NAME.tar.gz"

GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
GIT_DIRTY=false
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then GIT_DIRTY=true; fi
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "bundle:   $NAME"
echo "runtime:  $RT $RT_VERSION building for $PLATFORM (emulated=$EMULATED)"
echo "source:   $GIT_SHA (dirty=$GIT_DIRTY)"

# --------------------------------------------------------------- images -----
# The six images we build, in the order compose starts them. The scan sandbox
# image comes from Containerfile.scan and is REQUIRED: without it every scan
# reports "unavailable" and the Security tab is honest about it, but a bundle
# whose scanners cannot run is not the product.
OURS="migrate api worker scan-runner web scan"
BASE_IMAGES="docker.io/library/postgres:16 docker.io/library/redis:7-alpine"

if [ "$BUILD" = 1 ]; then
  for target in migrate api worker scan-runner web; do
    echo "== build $PREFIX/$target:$VERSION (Dockerfile target $target)"
    "$RT" build ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} -f Dockerfile --target "$target" -t "$PREFIX/$target:$VERSION" .
  done
  echo "== build $PREFIX/scan:$VERSION (Containerfile.scan)"
  "$RT" build ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} -f Containerfile.scan -t "$PREFIX/scan:$VERSION" .
fi
for target in $OURS; do
  "$RT" image exists "$PREFIX/$target:$VERSION" 2>/dev/null ||
    "$RT" image inspect "$PREFIX/$target:$VERSION" >/dev/null 2>&1 ||
    die "image $PREFIX/$target:$VERSION is not present (built with --no-build?)."
done

# postgres and redis travel in the archive too, so the customer host needs no
# registry access at all. The tags compose names are floating upstream; the
# manifest records the digest that was actually saved, which is the one the
# bundle will load.
if [ "$PULL_BASE" = 1 ]; then
  for img in $BASE_IMAGES; do
    echo "== pull $img"
    "$RT" pull ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} "$img" >/dev/null
  done
fi

# --------------------------------------------------------------- stage ------
rm -rf "$STAGE"
mkdir -p "$STAGE/images" "$STAGE/deploy/scan-rules"

ALL_IMAGES=""
for target in $OURS; do ALL_IMAGES="$ALL_IMAGES $PREFIX/$target:$VERSION"; done
ALL_IMAGES="$ALL_IMAGES $BASE_IMAGES"

echo "== save images -> $STAGE/images/repopulse-images.tar"
# docker-archive, because it is the one multi-image format BOTH `podman load`
# and `docker load` read. Shared layers are written once.
if [ "$RT" = podman ]; then
  # shellcheck disable=SC2086
  "$RT" save --multi-image-archive --format docker-archive -o "$STAGE/images/repopulse-images.tar" $ALL_IMAGES
else
  # shellcheck disable=SC2086
  "$RT" save -o "$STAGE/images/repopulse-images.tar" $ALL_IMAGES
fi

echo "== stage deploy/"
strip_compose deploy/compose.yaml > "$STAGE/deploy/compose.yaml"
grep -q '^    build:' "$STAGE/deploy/compose.yaml" &&
  die "bug: build: stanza survived strip_compose — deploy/compose.yaml's layout changed."
for f in .env.example configure.sh configure.mjs up.sh backup.sh restore.sh rotate-token-key.sh scan-db-sync.sh smoke-report-pdf.sh; do
  cp "deploy/$f" "$STAGE/deploy/$f"
done
cp deploy/scan-rules/README.md "$STAGE/deploy/scan-rules/README.md"
# The in-house rulepacks, twice: as the SOURCE scan-db-sync.sh installs from
# (it has no checkout to read them from on the customer host), and already
# installed into scan-rules/ so code scanning works before the first sync.
cp -R packages/security/rulepacks "$STAGE/deploy/rulepacks"
cp -R packages/security/rulepacks "$STAGE/deploy/scan-rules/rulepacks"
find "$STAGE/deploy/scan-rules/rulepacks" -type f -exec chmod 0444 {} +
( cd "$STAGE/deploy/scan-rules/rulepacks" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 ) \
  > "$STAGE/deploy/scan-rules/rulepacks.sha256"

cp deploy/bundle/install.sh "$STAGE/install.sh"
cp deploy/bundle/README.md "$STAGE/README.md"
# ADM-76: the operating guide travels with the install; the bundle README is
# only its short form and the full restore-onto-a-new-server steps live here.
cp docs/RUNBOOK.md "$STAGE/RUNBOOK.md"
cp deploy/bundle/ARCHITECTURES.md "$STAGE/ARCHITECTURES.md"
# W20-10 (UX_TODO ADM-76): the operating guide ships WITH the install. The
# bundle README's restore line was the only restore guidance a customer had,
# and restoring onto a new server needs the old key in place BEFORE install.sh.
cp docs/RUNBOOK.md "$STAGE/RUNBOOK.md"
chmod +x "$STAGE/install.sh" "$STAGE"/deploy/*.sh

# ------------------------------------------------------------- manifest -----
image_json() { # $1 image -> {"name":..,"id":..,"digest":..,"size":..}
  "$RT" image inspect "$1" --format \
    '{"name":"'"$1"'","id":"{{.Id}}","digest":"{{.Digest}}","size":{{.Size}},"created":"{{.Created}}"}' 2>/dev/null ||
    "$RT" image inspect "$1" --format \
      '{"name":"'"$1"'","id":"{{.Id}}","digest":"{{index .RepoDigests 0}}","size":{{.Size}},"created":"{{.Created}}"}'
}
{
  echo '{'
  echo "  \"name\": \"$NAME\","
  echo "  \"version\": \"$VERSION\","
  echo "  \"image_prefix\": \"$PREFIX\","
  echo "  \"platform\": \"$PLATFORM\","
  echo "  \"os\": \"$RT_OS\","
  echo "  \"arch\": \"$RT_ARCH\","
  echo "  \"emulated\": $EMULATED,"
  echo "  \"built_at\": \"$BUILT_AT\","
  echo "  \"built_with\": {\"runtime\": \"$RT\", \"version\": \"$RT_VERSION\", \"host\": \"$(uname -s)/$(uname -m)\"},"
  echo "  \"source\": {\"git_sha\": \"$GIT_SHA\", \"dirty\": $GIT_DIRTY},"
  echo '  "images": ['
  first=1
  for img in $ALL_IMAGES; do
    [ "$first" = 1 ] || echo ','
    first=0
    printf '    %s' "$(image_json "$img")"
  done
  echo
  echo '  ]'
  echo '}'
} > "$STAGE/manifest.json"

{
  echo "REPOPULSE_VERSION=$VERSION"
  echo "REPOPULSE_IMAGE_PREFIX=$PREFIX"
  echo "PLATFORM=$PLATFORM"
  echo "GIT_SHA=$GIT_SHA"
  echo "GIT_DIRTY=$GIT_DIRTY"
  echo "BUILT_AT=$BUILT_AT"
} > "$STAGE/VERSION"

# ------------------------------------------------------------ checksums -----
# Relative paths, so `shasum -c` / `sha256sum -c` works from the extracted
# directory. SHA256SUMS lists itself nowhere, on purpose.
( cd "$STAGE" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 ) \
  > "$STAGE/SHA256SUMS"

# --------------------------------------------------------------- pack -------
echo "== pack $TARBALL"
( cd "$OUT" && tar -cf - "$NAME" | gzip -1 > "$NAME.tar.gz" )
( cd "$OUT" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
rm -rf "$STAGE"

echo
echo "bundle:   $TARBALL"
echo "checksum: $(cat "$OUT/$NAME.tar.gz.sha256")"
echo "size:     $(du -h "$TARBALL" | cut -f1)"
echo
echo "Copy the tarball and its .sha256 to the target host, then:"
echo "    shasum -a 256 -c $NAME.tar.gz.sha256"
echo "    tar -xzf $NAME.tar.gz && cd $NAME"
echo "    ./install.sh --url=https://repopulse.example.com --admin-email=you@example.com"
