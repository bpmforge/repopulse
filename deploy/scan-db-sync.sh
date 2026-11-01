#!/usr/bin/env bash
# Host-side scan data sync (W8-12, SECURITY_SUITE.md §2.2, NFR-14).
#
# THE WHOLE POINT: the container that runs third-party scan binaries over a
# customer's source has --network=none. It therefore cannot fetch a rulepack or
# a vulnerability database, and that is not an inconvenience to work around —
# it is the control. This script is the other side of it: it runs on the HOST,
# on a schedule, fetches what the scanners need into a directory, and that
# directory is mounted read-only into the scan container.
#
# Run it nightly from the crontab of the user who ran install.sh (NOT root's:
# rootless Podman keeps images per user, and this script refuses to run as root
# against a rootless install, INS-65):
#   0 3 * * *  /opt/repopulse/deploy/scan-db-sync.sh >> $HOME/repopulse-scan-sync.log 2>&1
#
# Exit codes: 0 = everything synced, 1 = a source failed. A partial sync is
# reported loudly rather than left to look like a successful one, because a
# scanner running against a stale rulepack still reports findings and still
# looks green.
#
# DISK: PROVISION 5 GB FOR THIS, NOT 2.
# The grype vulnerability database is ~1.9 GiB unpacked, and the swap at the end
# is deliberately non-destructive — the new copy is staged alongside the live
# one and only then renamed into place — so a refresh briefly holds two of them,
# ~3.9 GiB. A 4 GB volume does not fit that, which is why the number here is 5.
# An operator who sized the volume for "some rule files" will otherwise meet
# this as a full disk at 03:00. The check below refuses to start rather than
# filling the filesystem the rest of the install is sitting on.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# The SAME defaults up.sh uses (W17-28), so the directory this fills is the
# directory the worker mounted. Shell first; then deploy/.env, which is where a
# bundle's install.sh pins SCAN_IMAGE; then the shipped deploy/scan-rules,
# which is what up.sh mounts when the operator has not chosen a directory.
# Previously this defaulted to /var/lib/repopulse/scan-rules while up.sh
# mounted deploy/scan-rules — a sync that succeeded into a directory nothing
# read.
env_value() { # $1 name -> shell value, else the deploy/.env line, else empty
  if [ -n "${!1:-}" ]; then printf '%s' "${!1}"
  elif [ -f "$SCRIPT_DIR/.env" ]; then sed -n "s/^$1=//p" "$SCRIPT_DIR/.env" | tail -n1; fi
}
DEST="$(env_value SCAN_RULES_DIR)"
: "${DEST:=$SCRIPT_DIR/scan-rules}"
SCAN_IMAGE="$(env_value SCAN_IMAGE)"
: "${SCAN_IMAGE:=localhost/repopulse/scan:dev}"
FAILED=0

# INS-67: the two fetching containers get the outbound proxy the api and worker
# use (shell first, then deploy/.env). Without it, from cron (no proxy in the
# environment) or under Docker, grype and the feed builder never reach the
# proxy. Both spellings, because Go reads HTTPS_PROXY and Python reads either.
proxy_env=()
for proxy_var in HTTPS_PROXY NO_PROXY; do
  proxy_val="$(env_value "$proxy_var")"
  if [ -n "$proxy_val" ]; then
    lower="$(printf '%s' "$proxy_var" | tr 'A-Z' 'a-z')"
    proxy_env+=(-e "$proxy_var=$proxy_val" -e "$lower=$proxy_val")
  fi
done

log() { printf '[scan-db-sync] %s\n' "$*"; }

# INS-67 (W20-22): the internal CA the api and worker trust, for the two
# fetching containers too. Behind a TLS-inspecting proxy grype and the feed
# builder otherwise fail on the company certificate. Same directory up.sh
# mounts (EXTRA_CA_DIR, default deploy/ca) at the same container path, and the
# same PEM NODE_EXTRA_CA_CERTS names. Grype (Go) ADDS a directory through
# SSL_CERT_DIR, keeping the image's public roots; Python's ssl only REPLACES
# its bundle (SSL_CERT_FILE), so that step concatenates the two first.
CA_FILE="$(env_value NODE_EXTRA_CA_CERTS)"
ca_mounts=()
grype_ca_env=()
if [ -n "$CA_FILE" ]; then
  CA_DIR="$(env_value EXTRA_CA_DIR)"
  : "${CA_DIR:=$SCRIPT_DIR/ca}"
  if [ -d "$CA_DIR" ]; then
    ca_mounts=(-v "$CA_DIR:/etc/repopulse/ca:ro")
    grype_ca_env=(-e "SSL_CERT_DIR=/etc/ssl/certs:/etc/repopulse/ca")
  else
    log "WARNING: NODE_EXTRA_CA_CERTS is set but EXTRA_CA_DIR ($CA_DIR) is not a directory;"
    log "         fetching without the internal CA"
    CA_FILE=""
  fi
fi

# The real reason a fetch failed (W20-22, INS-67): the container's own last
# lines, so a TLS or proxy error reads as one instead of as "needs outbound
# HTTPS", which sent the admin to the firewall team.
fetch_err="$(mktemp "${TMPDIR:-/tmp}/scan-db-sync.XXXXXX")"
trap 'rm -f "$fetch_err"' EXIT
show_fetch_error() {
  if [ -s "$fetch_err" ]; then
    log "       its last output:"
    tail -n 5 "$fetch_err" | while IFS= read -r line; do log "         $line"; done
  fi
  if grep -qiE 'x509|certificate|CERTIFICATE_VERIFY_FAILED|SSL' "$fetch_err" 2>/dev/null; then
    log "       That is a TLS trust error: put your proxy's or company CA (PEM) in"
    log "       EXTRA_CA_DIR and set NODE_EXTRA_CA_CERTS in deploy/.env (see INSTALL.md)."
  elif grep -qiE 'proxy|407|connection refused|no such host|timeout|timed out' "$fetch_err" 2>/dev/null; then
    log "       That looks like a proxy or network error: check HTTPS_PROXY / NO_PROXY in deploy/.env."
  fi
}

# INS-65: refuse to run as root against a rootless install. Root's podman has
# its own image store, so it cannot find the scan image the install's user
# loaded, and anything it did write would leave root-owned files in the scan
# data directory that the install's user can then no longer replace. The
# install belongs to whoever owns deploy/.env (or, before configure, this
# directory). REPOPULSE_ALLOW_ROOT=1 is for a deliberately rootful install.
if [ "$(id -u)" = 0 ] && [ "${REPOPULSE_ALLOW_ROOT:-0}" != 1 ] && command -v podman >/dev/null 2>&1; then
  owned="$SCRIPT_DIR/.env"
  [ -e "$owned" ] || owned="$SCRIPT_DIR"
  owner_uid="$(ls -ldn "$owned" | awk '{print $3}')"
  if [ -n "$owner_uid" ] && [ "$owner_uid" != 0 ]; then
    owner="$(ls -ld "$owned" | awk '{print $3}')"
    log "REFUSED: running as root, but this install belongs to $owner (the owner of $owned)."
    log "Rootless Podman gives each user their own images; root cannot see the scan image."
    log "Run it as $owner instead: put the cron line in $owner's crontab (crontab -e as $owner)"
    log "and enable lingering (sudo loginctl enable-linger $owner). See docs/INSTALL.md -> Scan data."
    log "For a deliberately rootful install, set REPOPULSE_ALLOW_ROOT=1."
    exit 1
  fi
fi

mkdir -p "$DEST"

# ---- 1. Our own rulepacks -------------------------------------------------
# Shipped in the repository rather than fetched from a registry: SECURITY_SUITE
# §3.3 bars Semgrep's registry packs (p/*, --config auto) for service use on
# licence grounds, so the packs we run are ours and travel with the code.
#
# Where they come from depends on how this was installed (W17-28): a checkout
# has them under packages/security; a bundle has no checkout and ships them
# beside this script as deploy/rulepacks. Explicit RULEPACKS_SRC wins.
RULEPACKS_SRC="${RULEPACKS_SRC:-}"
RULEPACKS_SRC_EXPLICIT="$RULEPACKS_SRC"
if [ -z "$RULEPACKS_SRC" ]; then
  if [ -d "$REPO_ROOT/packages/security/rulepacks" ]; then
    RULEPACKS_SRC="$REPO_ROOT/packages/security/rulepacks"
  elif [ -d "$SCRIPT_DIR/rulepacks" ]; then
    RULEPACKS_SRC="$SCRIPT_DIR/rulepacks"
  fi
fi
# An INSTALLED, VERIFIED rulepack bundle (W19-06) replaces the shipped packs.
# `rulepack-bundle/current` is a symlink that only the bundle tool moves, and it
# only ever points at a bundle whose SHA-256s and Ed25519 signature checked out
# against a key the operator trusts (packages/security/src/updates). An explicit
# RULEPACKS_SRC still wins, so a deliberate override is never second-guessed.
# To go back to the packs that shipped with this install, run the tool's
# `rollback --to-shipped`, which removes the symlink.
RULEPACK_BUNDLE_DIR="$(env_value RULEPACK_BUNDLE_DIR)"
: "${RULEPACK_BUNDLE_DIR:=$DEST/rulepack-bundle}"
BUNDLE_VERSION=""
if [ -z "${RULEPACKS_SRC_EXPLICIT:-}" ] && [ -L "$RULEPACK_BUNDLE_DIR/current" ] && [ -d "$RULEPACK_BUNDLE_DIR/current" ]; then
  RULEPACKS_SRC="$RULEPACK_BUNDLE_DIR/current"
  BUNDLE_VERSION="$(basename "$(readlink "$RULEPACK_BUNDLE_DIR/current")")"
  log "using installed rulepack bundle $BUNDLE_VERSION (replaces the shipped packs)"
elif [ -e "$RULEPACK_BUNDLE_DIR/current" ] || [ -L "$RULEPACK_BUNDLE_DIR/current" ]; then
  log "ERROR: $RULEPACK_BUNDLE_DIR/current exists but is not a symlink to a directory - ignoring it, using the shipped packs"
  FAILED=1
fi
if [ -n "$RULEPACKS_SRC" ] && [ -d "$RULEPACKS_SRC" ]; then
  log "syncing in-house rulepacks from $RULEPACKS_SRC"
  # REPLACED, not merged. Two reasons, both found by running this twice:
  # the files are chmod 0444 below, so a second copy over them fails with
  # "Permission denied"; and a rule DELETED upstream would otherwise live on
  # in the mount forever, which is the failure mode where a scanner keeps
  # firing a rule that was withdrawn.
  rm -rf "$DEST/rulepacks"
  install -d "$DEST/rulepacks"
  cp -R "$RULEPACKS_SRC/." "$DEST/rulepacks/"
  find "$DEST/rulepacks" -type f -exec chmod 0444 {} +
  ( cd "$DEST/rulepacks" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 ) \
    > "$DEST/rulepacks.sha256"
  log "rulepacks synced: $(wc -l < "$DEST/rulepacks.sha256" | tr -d ' ') files"
  printf '%s\n' "${BUNDLE_VERSION:-shipped}" > "$DEST/rulepacks.version"
else
  log "ERROR: no rulepack directory at $REPO_ROOT/packages/security/rulepacks or $SCRIPT_DIR/rulepacks (set RULEPACKS_SRC)"
  FAILED=1
fi

# ---- 2. Vulnerability database (grype, W8-06) ------------------------------
# WHY THIS IS FETCHED RATHER THAN SHIPPED: grype's database is not one feed, it
# is an aggregate of 26 of them (nvd, github, kev, epss, debian, rhel, alpine,
# ...), each carrying its own terms. We are not entitled to redistribute that
# inside our own image, so the customer's install fetches it from Anchore
# directly and we never become a distributor of it. The happy side effect is
# that the database is as fresh as this cron job, instead of as fresh as the
# last image tag someone happened to pull.
#
# ON BY DEFAULT, and that is the deliberate choice: with no database the
# dependency scanner does not error, it reports nothing, and a repository with
# no findings is indistinguishable from a repository nobody checked. Set
# SCAN_SYNC_VULN_DB=0 to opt out with your eyes open.
#
# THE FETCH RUNS IN THE SCAN IMAGE, not on the host. Three things fall out of
# that and all three are the reason for it: the host needs no grype installed
# (podman is already a hard requirement, one more is not free); the grype doing
# the downloading is byte-for-byte the pinned binary that will later read the
# database, so it cannot fetch a schema its reader does not support; and the
# network access lives in this short-lived sync container, which never sees
# customer source, rather than anywhere near the scan container.
VULN_DB_DIR="$DEST/vuln-db"
# Free space needed to RUN a sync, in the KiB blocks POSIX df -P reports. This
# is 2.2 GiB, not the 5 GB the volume should be provisioned at, and the two
# numbers are different on purpose: the swap below is a rename within $DEST,
# not a copy, so a refresh only ever needs room for ONE more database beside
# the one already there. Requiring the full provisioned size here would refuse
# to run on exactly the volume the docs told the operator to build.
REQUIRED_KB=2306867

if [ "${SCAN_SYNC_VULN_DB:-1}" = "1" ]; then
  runtime=""
  for candidate in podman docker; do
    if command -v "$candidate" >/dev/null 2>&1; then runtime="$candidate"; break; fi
  done

  if [ -z "$runtime" ]; then
    log "ERROR: no podman or docker on PATH — the grype database is fetched by"
    log "       running $SCAN_IMAGE, so a container runtime is required here."
    FAILED=1
  else
    available_kb="$(df -Pk "$DEST" | awk 'NR==2 {print $4}')"
    if [ "${available_kb:-0}" -lt "$REQUIRED_KB" ]; then
      log "ERROR: $DEST has ${available_kb}KB free, and one sync needs ${REQUIRED_KB}KB"
      log "       (~1.9GiB, staged beside the copy already in use). Provision 5GB for"
      log "       this directory. Refusing to start rather than filling the disk."
      FAILED=1
    else
      log "syncing grype vulnerability database (~1.9GB — this is not quick)"
      stage="$DEST/vuln-db.stage"
      # A previous run killed mid-download leaves a stage directory behind, and
      # grype would then resume into a half-populated cache. Start clean; u+w
      # first because a stage that got as far as the chmod below is read-only,
      # and rm cannot unlink out of a directory it cannot write.
      [ -e "$stage" ] && chmod -R u+w "$stage" && rm -rf "$stage"
      mkdir -p "$stage"

      # --user 0:0: under rootless podman the container's root maps to the
      # invoking user, so the files land owned by whoever runs this cron entry
      # and are readable afterwards. The image's own user (65534) maps to a
      # subuid that does not own $stage and could not write into it.
      #
      # GRYPE_DB_AUTO_UPDATE is false in the image — that is the setting the
      # SCAN container must have — and `grype db update` is an explicit command
      # that overrides it (verified by running: it downloads regardless).
      # OFFLINE PATH (W19-06). With SCAN_VULN_DB_ARCHIVE set, nothing is fetched:
      # the database comes from an archive the operator carried in (grype's own
      # `db import`), and it must match SCAN_VULN_DB_ARCHIVE_SHA256 or the sync
      # refuses - the checksum is the operator's statement of what they meant to
      # install. It then goes through the same prove-before-publish check below.
      db_fetch=(grype db update)
      db_mounts=()
      ARCHIVE="$(env_value SCAN_VULN_DB_ARCHIVE)"
      if [ -n "$ARCHIVE" ]; then
        ARCHIVE_SHA="$(env_value SCAN_VULN_DB_ARCHIVE_SHA256)"
        if [ ! -f "$ARCHIVE" ]; then
          log "ERROR: SCAN_VULN_DB_ARCHIVE=$ARCHIVE is not a file"
          FAILED=1; rm -rf "$stage"; ARCHIVE_BAD=1
        elif [ -z "$ARCHIVE_SHA" ]; then
          log "ERROR: SCAN_VULN_DB_ARCHIVE is set without SCAN_VULN_DB_ARCHIVE_SHA256 - refusing to import an unverified database"
          FAILED=1; rm -rf "$stage"; ARCHIVE_BAD=1
        elif [ "$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')" != "$ARCHIVE_SHA" ]; then
          log "ERROR: $ARCHIVE does not match SCAN_VULN_DB_ARCHIVE_SHA256 - refusing to import it"
          FAILED=1; rm -rf "$stage"; ARCHIVE_BAD=1
        else
          log "importing the grype database from $ARCHIVE (offline; checksum verified)"
          db_fetch=(grype db import /import/db-archive)
          db_mounts=(-v "$ARCHIVE:/import/db-archive:ro")
        fi
      fi
      if [ -z "${ARCHIVE_BAD:-}" ] && "$runtime" run --rm --user 0:0 \
           -e GRYPE_DB_CACHE_DIR=/db \
           ${proxy_env[@]+"${proxy_env[@]}"} \
           ${grype_ca_env[@]+"${grype_ca_env[@]}"} \
           -v "$stage:/db:rw" \
           ${ca_mounts[@]+"${ca_mounts[@]}"} \
           ${db_mounts[@]+"${db_mounts[@]}"} \
           "$SCAN_IMAGE" "${db_fetch[@]}" 2>"$fetch_err"; then
        # Read-only for everyone, matching the rulepacks: the scan container
        # mounts this ro anyway, and defence in depth costs one chmod.
        find "$stage" -type d -exec chmod 0555 {} +
        find "$stage" -type f -exec chmod 0444 {} +

        # PROVE IT BEFORE PUBLISHING IT. This is the exact thing the scanner
        # will do — read the database, offline, unprivileged — and doing it
        # here means a database that cannot be opened fails the sync loudly
        # instead of turning into an empty findings list tomorrow.
        if "$runtime" run --rm --network=none --read-only --user=65534:65534 \
             -v "$stage:/vuln-db:ro" \
             "$SCAN_IMAGE" grype db status >/dev/null; then
          # Swap last, and by rename: until this line the live database is
          # untouched, so a sync that fails at any point above leaves the
          # scanners working with yesterday's copy rather than with nothing.
          if [ -e "$VULN_DB_DIR" ]; then
            chmod -R u+w "$VULN_DB_DIR"
            rm -rf "$VULN_DB_DIR.old"
            mv "$VULN_DB_DIR" "$VULN_DB_DIR.old"
          fi
          mv "$stage" "$VULN_DB_DIR"
          # SCAN_KEEP_PREVIOUS_DB=1 keeps ONE earlier database as vuln-db.prev so
          # deploy/scan-db-rollback.sh can go back. Off by default: it holds a
          # third ~1.9 GiB copy while the next sync stages, so provision 8 GB,
          # not 5, if you turn it on.
          if [ "$(env_value SCAN_KEEP_PREVIOUS_DB)" = "1" ] && [ -e "$VULN_DB_DIR.old" ]; then
            rm -rf "$VULN_DB_DIR.prev"
            mv "$VULN_DB_DIR.old" "$VULN_DB_DIR.prev"
          fi
          rm -rf "$VULN_DB_DIR.old"
          log "grype database synced: $(du -sh "$VULN_DB_DIR" | awk '{print $1}') at $VULN_DB_DIR"
          # W23-04: the DATA STAMP. One line, `<schema>@<build timestamp>` — grype's
          # own record of what it just imported — written AFTER the swap and by
          # rename, so a reader sees the old stamp or the new one, never half.
          # The worker compares it with the stamp each scan recorded: unchanged
          # manifests + a changed stamp = re-match the stored SBOM instead of
          # re-fetching the source (docs/RUNBOOK.md, "What 'rematched' means").
          # If the build time cannot be read the stamp is the import.json's own
          # sha256, which still changes whenever the database does.
          stamp_json="$(ls "$VULN_DB_DIR"/*/import.json 2>/dev/null | head -n1 || true)"
          if [ -n "$stamp_json" ]; then
            stamp_schema="$(basename "$(dirname "$stamp_json")")"
            stamp_built="$(grep -Eo '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z' "$stamp_json" | head -n1 || true)"
            : "${stamp_built:=sha256-$(sha256sum "$stamp_json" | cut -c1-16)}"
            printf '%s@%s\n' "$stamp_schema" "$stamp_built" > "$DEST/vuln-db.version.tmp"
            mv "$DEST/vuln-db.version.tmp" "$DEST/vuln-db.version"
            log "advisory data stamp: $(cat "$DEST/vuln-db.version")"
          fi
        else
          log "ERROR: the freshly downloaded database failed 'grype db status'"
          log "       under the read-only, no-network profile. Keeping the previous"
          log "       copy; the staged one is at $stage for inspection."
          FAILED=1
        fi
      elif [ -z "${ARCHIVE_BAD:-}" ]; then
        log "ERROR: 'grype ${db_fetch[*]}' failed inside $SCAN_IMAGE."
        show_fetch_error
        log "       It needs outbound HTTPS to grype.anchore.io (through HTTPS_PROXY if set),"
        log "       and $SCAN_IMAGE must exist (podman compose ... build scan). With no"
        log "       way out, set SCAN_VULN_DB_ARCHIVE (+ _SHA256) to import a database offline."
        chmod -R u+w "$stage" 2>/dev/null || true
        rm -rf "$stage"
        FAILED=1
      fi
    fi
  fi
else
  log "grype database sync: skipped (SCAN_SYNC_VULN_DB=0)"
  log "  the dependency scanner reports NOTHING without it — that is silence, not a clean bill"
fi

# ---- 3. OpenSSF malicious-packages (W18-37) ---------------------------------
# A package that IS the attack has no CVE, so the grype database cannot know it.
# OSV republishes the OpenSSF feed as MAL-* advisories; the build script (run in
# the scan image, which is the one step here with network) keeps only those and
# writes a compact index the dependency scanner matches the SBOM against (tens of MB
# for npm alone, built in seconds). SCAN_SYNC_MALICIOUS=0 turns it off.
if [ "${SCAN_SYNC_MALICIOUS:-1}" != "0" ]; then
  runtime=""
  for candidate in podman docker; do
    if command -v "$candidate" >/dev/null 2>&1; then runtime="$candidate"; break; fi
  done
  mal_dir="$DEST/malicious"
  if [ -z "$runtime" ]; then
    log "ERROR: no podman or docker on PATH — the malicious-package index is built in $SCAN_IMAGE"
    FAILED=1
  else
    mal_stage="$DEST/malicious.stage"
    rm -rf "$mal_stage"
    mkdir -p "$mal_stage"
    # With an internal CA, Python gets ONE bundle: the image's public roots
    # plus that PEM (SSL_CERT_FILE replaces, it does not add).
    mal_cmd=(python3 /build.py /out)
    if [ -n "$CA_FILE" ]; then
      mal_cmd=(sh -c 'cat "$(python3 -c "import ssl; print(ssl.get_default_verify_paths().openssl_cafile)")" "$REPOPULSE_CA_FILE" > /tmp/ca-bundle.pem && SSL_CERT_FILE=/tmp/ca-bundle.pem REQUESTS_CA_BUNDLE=/tmp/ca-bundle.pem exec python3 /build.py /out')
    fi
    if "$runtime" run --rm --user 0:0 \
         ${proxy_env[@]+"${proxy_env[@]}"} \
         -e "REPOPULSE_CA_FILE=$CA_FILE" \
         ${ca_mounts[@]+"${ca_mounts[@]}"} \
         -v "$mal_stage:/out:rw" \
         -v "$SCRIPT_DIR/build-malicious-index.py:/build.py:ro" \
         "$SCAN_IMAGE" "${mal_cmd[@]}" 2>"$fetch_err"; then
      rm -rf "$mal_dir.old"
      [ -e "$mal_dir" ] && mv "$mal_dir" "$mal_dir.old"
      mv "$mal_stage" "$mal_dir"
      rm -rf "$mal_dir.old"
      log "malicious-package index synced: $(du -sh "$mal_dir" | awk '{print $1}') at $mal_dir"
    else
      log "ERROR: building the malicious-package index failed. Keeping any previous index."
      show_fetch_error
      log "       It needs outbound HTTPS to osv-vulnerabilities.storage.googleapis.com"
      log "       (through HTTPS_PROXY if set)."
      rm -rf "$mal_stage"
      FAILED=1
    fi
  fi
else
  log "malicious-package sync: skipped (SCAN_SYNC_MALICIOUS=0)"
fi

# ---- 4. Package-name index (W21-05) ------------------------------------------
# "Does this dependency exist?" — the slopsquat check (hallucinated and
# typosquatted packages) asks it offline, against name lists fetched here, so
# the scan path never calls a registry. One download per ecosystem, built in
# the scan image (deploy/build-package-index.py), swapped in by rename like the
# malicious index. Default ecosystems: npm, PyPI, RubyGems (~110 MB on disk,
# staged beside the live copy, so allow ~250 MB). Add `cargo` (crates.io's
# database dump, several hundred MB to download, the one source with age and
# download counts) and `go` (index.golang.org, incremental; existence is only
# checked once its backfill completes) with SCAN_PACKAGE_INDEX_ECOSYSTEMS.
# Maven has no compact public list: give one as SCAN_PACKAGE_INDEX_MAVEN_FILE.
# SCAN_SYNC_PACKAGE_INDEX=0 turns the step off; the scanner then reports
# existence as "not checked" and runs only its near-miss half.
if [ "$(env_value SCAN_SYNC_PACKAGE_INDEX)" != "0" ] && [ "${SCAN_SYNC_PACKAGE_INDEX:-1}" != "0" ]; then
  runtime=""
  for candidate in podman docker; do
    if command -v "$candidate" >/dev/null 2>&1; then runtime="$candidate"; break; fi
  done
  idx_dir="$DEST/package-index"
  if [ -z "$runtime" ]; then
    log "ERROR: no podman or docker on PATH — the package-name index is built in $SCAN_IMAGE"
    FAILED=1
  else
    idx_stage="$DEST/package-index.stage"
    rm -rf "$idx_stage"
    mkdir -p "$idx_stage" "$idx_dir"
    idx_ecos="$(env_value SCAN_PACKAGE_INDEX_ECOSYSTEMS)"
    : "${idx_ecos:=npm pypi rubygems}"
    idx_args=(/out --previous /previous)
    idx_mounts=()
    maven_file="$(env_value SCAN_PACKAGE_INDEX_MAVEN_FILE)"
    if [ -n "$maven_file" ]; then
      if [ -f "$maven_file" ]; then
        idx_mounts=(-v "$maven_file:/import/maven.txt:ro")
        idx_args+=(maven=/import/maven.txt)
      else
        log "ERROR: SCAN_PACKAGE_INDEX_MAVEN_FILE=$maven_file is not a file - Maven existence stays unchecked"
        FAILED=1
      fi
    fi
    # With an internal CA, Python gets ONE bundle (as for the malicious index).
    idx_cmd=(python3 /build.py "${idx_args[@]}")
    if [ -n "$CA_FILE" ]; then
      idx_cmd=(sh -c 'cat "$(python3 -c "import ssl; print(ssl.get_default_verify_paths().openssl_cafile)")" "$REPOPULSE_CA_FILE" > /tmp/ca-bundle.pem && SSL_CERT_FILE=/tmp/ca-bundle.pem exec python3 /build.py "$@"' sh "${idx_args[@]}")
    fi
    if "$runtime" run --rm --user 0:0 \
         ${proxy_env[@]+"${proxy_env[@]}"} \
         -e "REPOPULSE_CA_FILE=$CA_FILE" \
         -e "SCAN_PACKAGE_INDEX_ECOSYSTEMS=$idx_ecos" \
         -e "SCAN_PACKAGE_INDEX_GO_MAX_PAGES=$(env_value SCAN_PACKAGE_INDEX_GO_MAX_PAGES)" \
         ${ca_mounts[@]+"${ca_mounts[@]}"} \
         ${idx_mounts[@]+"${idx_mounts[@]}"} \
         -v "$idx_stage:/out:rw" \
         -v "$idx_dir:/previous:ro" \
         -v "$SCRIPT_DIR/build-package-index.py:/build.py:ro" \
         "$SCAN_IMAGE" "${idx_cmd[@]}" 2>"$fetch_err"; then
      rm -rf "$idx_dir.old"
      mv "$idx_dir" "$idx_dir.old"
      mv "$idx_stage" "$idx_dir"
      rm -rf "$idx_dir.old"
      log "package-name index synced: $(du -sh "$idx_dir" | awk '{print $1}') at $idx_dir ($idx_ecos)"
    else
      # The builder keeps the previous list of any ecosystem it could not
      # fetch, so a partial stage is still the best copy there is: publish it,
      # but report the failure.
      if [ -s "$idx_stage/manifest.json" ]; then
        rm -rf "$idx_dir.old"
        mv "$idx_dir" "$idx_dir.old"
        mv "$idx_stage" "$idx_dir"
        rm -rf "$idx_dir.old"
        log "ERROR: the package-name index synced only in part (previous lists kept where a source failed)."
      else
        rm -rf "$idx_stage"
        log "ERROR: building the package-name index failed. Keeping any previous index."
      fi
      show_fetch_error
      log "       It needs outbound HTTPS to registry.npmjs.org, pypi.org and rubygems.org"
      log "       (plus static.crates.io / index.golang.org if enabled), through HTTPS_PROXY if set."
      FAILED=1
    fi
  fi
else
  log "package-name index sync: skipped (SCAN_SYNC_PACKAGE_INDEX=0) — slopsquat existence checks report 'not checked'"
fi

# OSV and CISA KEV need no sync of their own, which is worth stating so nobody
# adds one: grype's database already carries both. The copy synced above was
# measured at 1,671 KEV entries and 362,257 EPSS scores, and the D12 risk model
# reads them straight off each match.

if [ "$FAILED" -ne 0 ]; then
  log "FAILED — the scan mount may be stale or incomplete"
  exit 1
fi

log "done: $DEST"
