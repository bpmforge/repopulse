# RepoPulse — one multi-stage build, four runtime targets (W11-01).
#
# Targets: api, worker, migrate, web (+ scan-runner). api, migrate and
# scan-runner share one Alpine production install (prod-deps); the worker has a
# Debian install of the same lockfile (prod-deps-debian), because it runs the
# PDF printer's Chromium and Playwright has no Alpine build (W20-02). The web
# target's static assets come from a full install on the BUILD platform
# (web-build).
#
# Node is pinned to the same version as .nvmrc and pnpm to package.json's
# packageManager field. A container that silently runs a different Node major
# than the repo pins is the exact failure the test-on-stop hook documents:
# native addons abort with NODE_MODULE_VERSION errors that read like real
# breakage.

# ---------- base ----------
FROM node:22.23.1-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# ---------- manifests ----------
# Only the files a dependency install reads, so the Alpine and the Debian
# installs below (W20-02) are fed the same list and cannot drift apart.
FROM scratch AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json /app/
COPY apps/api/package.json /app/apps/api/
COPY apps/web/package.json /app/apps/web/
COPY packages/analysis/package.json /app/packages/analysis/
COPY packages/auth/package.json /app/packages/auth/
COPY packages/forge/package.json /app/packages/forge/
COPY packages/ingest/package.json /app/packages/ingest/
COPY packages/insights/package.json /app/packages/insights/
COPY packages/metrics/package.json /app/packages/metrics/
COPY packages/reports/package.json /app/packages/reports/
COPY packages/security/package.json /app/packages/security/
COPY packages/shared/package.json /app/packages/shared/

# ---------- prod-deps ----------
# The runtime stages must NOT carry the full dev install (only the web-build
# stage below has it): that is the dev toolchain (vitest, playwright, eslint,
# typescript, drizzle-kit), and inheriting it once made the api and worker
# images 1.68 GB, all of it pulled by every customer on install.
#
# A plain --prod install is not sufficient, because this workspace ships
# TypeScript: every package's `exports` points at ./src/*.ts and nothing is
# compiled, so `tsx` is a genuine RUNTIME dependency rather than a build tool.
# It is pinned to the same version the repo uses; drizzle-kit is added only in
# the migrate stage, which is the one place it actually runs.
FROM base AS prod-deps
COPY --from=manifests /app ./
RUN pnpm install --frozen-lockfile --prod \
 && pnpm store prune || true

# Runtime source: the TypeScript the workspace actually executes, without the
# test suites, fixtures, e2e harness or web app that the api and worker never
# load. .dockerignore already excludes node_modules and build output.
FROM base AS runtime-src
COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/api/src apps/api/src
COPY packages packages
# W18-18: served to CI tokens at /api/v1/cli/repopulse.mjs. One file, no deps.
COPY tools/repopulse-cli/repopulse.mjs tools/repopulse-cli/repopulse.mjs

# ---------- web build ----------
# ON THE BUILD PLATFORM, not the target one (W11-01, 2026-09-23). The SPA's
# output is static files, identical on every arch, and esbuild (inside vite) is
# a Go binary: cross-building the amd64 bundle on an arm64 host ran it under
# qemu-user, where the Go runtime aborts (`fatal error: lfstack.push`) every
# time. Only the nginx image below is the target arch. When build and target
# are the same platform this is simply a second native install of the same
# lockfile. BUILDPLATFORM is set automatically by buildah/podman and BuildKit.
FROM --platform=$BUILDPLATFORM node:22.23.1-alpine AS web-build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/analysis/package.json packages/analysis/
COPY packages/auth/package.json packages/auth/
COPY packages/forge/package.json packages/forge/
COPY packages/ingest/package.json packages/ingest/
COPY packages/insights/package.json packages/insights/
COPY packages/metrics/package.json packages/metrics/
COPY packages/reports/package.json packages/reports/
COPY packages/security/package.json packages/security/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
# The SPA talks only to /api/v1 on its own origin (Law 4), so there is no API
# URL to bake in at build time — nginx routes it. That is what keeps one image
# usable at any customer hostname.
RUN pnpm --filter @repopulse/web exec vite build

# ---------- runtime: api ----------
FROM base AS api
ENV NODE_ENV=production
# The app binds loopback unless LISTEN_HOST says otherwise (W17-37). In a container
# the web proxy reaches it over the compose network, so bind every interface
# INSIDE the container; compose publishes no host port for api or worker.
ENV LISTEN_HOST=0.0.0.0
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
# pnpm isolates workspace package deps — copy each package's node_modules
# or ERR_MODULE_NOT_FOUND fires at runtime (postgres, drizzle-orm, etc.).
COPY --from=prod-deps /app/packages/analysis/node_modules ./packages/analysis/node_modules
COPY --from=prod-deps /app/packages/auth/node_modules ./packages/auth/node_modules
COPY --from=prod-deps /app/packages/forge/node_modules ./packages/forge/node_modules
COPY --from=prod-deps /app/packages/ingest/node_modules ./packages/ingest/node_modules
COPY --from=prod-deps /app/packages/insights/node_modules ./packages/insights/node_modules
COPY --from=prod-deps /app/packages/metrics/node_modules ./packages/metrics/node_modules
COPY --from=prod-deps /app/packages/reports/node_modules ./packages/reports/node_modules
COPY --from=prod-deps /app/packages/security/node_modules ./packages/security/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=runtime-src /app ./
# tsx globally, and the process is started with it DIRECTLY rather than through
# `pnpm --filter ... exec`. Two reasons, both found by running the image:
# pnpm's isolated layout does not put a root-installed tsx on a workspace
# package's bin path, and invoking pnpm at runtime makes corepack try to fetch
# itself from the network on every container start.
RUN npm install -g tsx@4.23.1 && npm cache clean --force
RUN addgroup -S app && adduser -S -G app app \
 && mkdir -p /app/.data && chown -R app:app /app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["tsx", "apps/api/src/index.ts"]

# ---------- prod-deps on Debian (W20-02) ----------
# The worker prints report PDFs with Playwright's Chromium, and Playwright ships
# no browser for Alpine/musl: on the Alpine worker every Generate ended
# "failed" with "Executable doesn't exist at .../chromium_headless_shell-1228"
# (reproduced on a packaged install). So the worker is the one runtime on
# Debian, with its own glibc install of the same lockfile from the same
# manifests. Node stays the same pinned version.
FROM node:22.23.1-bookworm-slim AS base-debian
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

FROM base-debian AS prod-deps-debian
COPY --from=manifests /app ./
RUN pnpm install --frozen-lockfile --prod \
 && pnpm store prune || true

# ---------- runtime: worker ----------
FROM base-debian AS worker
ENV NODE_ENV=production
# The app binds loopback unless LISTEN_HOST says otherwise (W17-37). In a container
# the web proxy reaches it over the compose network, so bind every interface
# INSIDE the container; compose publishes no host port for api or worker.
ENV LISTEN_HOST=0.0.0.0
# A fixed path, not the default ~/.cache: the browser is installed as root at
# build time and launched as `app` at run time, and those homes differ.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Same uid/gid as the Alpine stages' `adduser -S app` (100:101), so files the
# worker writes into the shared report-data volume are owned the way the api
# expects. Created first so the trees below are COPIED as app: a `chown -R`
# afterwards rewrites every file into a new layer and doubled this image.
RUN groupadd --system --gid 101 app \
 && useradd --system --uid 100 --gid app --home-dir /home/app --create-home app
# The whole tree, node_modules per package included: pnpm isolates workspace
# package deps, and the api stage's per-package copies exist for that reason.
COPY --chown=app:app --from=prod-deps-debian /app ./
# The browser comes from the playwright package IN THIS TREE, so its build
# always matches the lockfile's playwright (a separately pinned browser drifts
# and fails at launch with the same "Executable doesn't exist" as no browser).
# Headless shell only: the printer never opens a window, and the full browser
# would add ~300 MB. --with-deps installs the shared libraries and fonts the
# shell needs.
#
# SANDBOX. Playwright launches Chromium with --no-sandbox unless the caller
# asks for chromiumSandbox: true (checked in playwright-core 1.61.1), and the
# printer does not ask. Chromium's own sandbox needs either a setuid helper or
# user namespaces, and compose runs this container with cap_drop ALL and
# no-new-privileges, which rule out both. That is acceptable here because of
# what is printed: only this install's own /print/reports/:id page, served by
# the internal web service, rendering ReportData the worker injects. It never
# loads a URL a user supplied.
RUN cd packages/reports \
 && ./node_modules/.bin/playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm
RUN npm install -g tsx@4.23.1 && npm cache clean --force
COPY --chown=app:app --from=runtime-src /app ./
# /app/.data exists in the image so a fresh named volume mounted over it takes
# app's ownership instead of root's.
RUN mkdir -p /app/.data && chown app:app /app /app/.data
USER app
# W17-06. Uses `node`, which this image HAS (verified in-image; `curl` is NOT
# installed here, so a curl-based probe would report every worker unhealthy).
# start-period is generous because the worker registers consumers and warms a
# gateway before it serves anything.
#
# This proves the PROCESS is serving and can reach Postgres and Redis. It
# deliberately does not prove a queue consumer is alive — that is the Redis
# heartbeat (workers/heartbeat.ts), which the API can actually see. A container
# healthcheck cannot be the liveness signal for the product, because nothing
# outside this container can read it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||3301)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["tsx", "apps/api/src/workers/index.ts"]

# ---------- runtime: scan-runner ----------
# W17-27. The ONE service allowed to start a container, and nothing else.
#
# The worker above deliberately has no runtime binary, no socket, no
# privilege: it holds forge credentials and the database, so it must not be
# able to start containers. But a scan IS a container. This image is the same
# Alpine runtime tree as the api plus two CLIENTS — podman-remote and docker-cli —
# that speak to whichever daemon socket compose mounts at /run/container.sock.
# It contains no daemon, no conmon, no crun and no storage: it cannot run a
# container by itself, only ask the host's runtime to. What it asks for is
# decided by packages/security/sandbox/runner-server.ts, which refuses any
# request that names an image other than SCAN_IMAGE or a path outside the
# scratch volume and the rules directory.
#
# Alpine 3.24 (this node base) ships podman-remote 5.8 and docker-cli 29 —
# checked in-image, because Alpine 3.20's podman-remote 5.2 client rejected
# mount options the 5.8 server accepts and the failure read as a bad profile.
FROM api AS scan-runner
USER root
RUN apk add --no-cache podman-remote docker-cli && rm -rf /var/cache/apk/*
USER app
# A GET of the status document proves the process is up AND can answer the
# runtime queries that document is built from. The listener is either a TCP
# address (the packaged stack: SCAN_RUNNER_LISTEN=http://0.0.0.0:3310) or a
# unix socket, so the probe reads the same variable the server does.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "const a=process.env.SCAN_RUNNER_LISTEN||process.env.SCAN_RUNNER_SOCKET||'/run/repopulse/scan-runner.sock';const o=a.startsWith('http://')?{host:'127.0.0.1',port:new URL(a).port}:{socketPath:a};require('http').request({...o,path:'/v1/status'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1)).end()"
CMD ["tsx", "packages/security/sandbox/runner-server.ts"]

# ---------- one-shot: migrate ----------
# Runs to completion before api/worker start. Drizzle records applied
# migrations, so a second `up` on an existing install is a no-op, not a
# re-migrate.
FROM base AS migrate
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
# pnpm isolates workspace package deps — copy each package's node_modules
# or ERR_MODULE_NOT_FOUND fires at runtime (postgres, drizzle-orm, etc.).
COPY --from=prod-deps /app/packages/analysis/node_modules ./packages/analysis/node_modules
COPY --from=prod-deps /app/packages/auth/node_modules ./packages/auth/node_modules
COPY --from=prod-deps /app/packages/forge/node_modules ./packages/forge/node_modules
COPY --from=prod-deps /app/packages/ingest/node_modules ./packages/ingest/node_modules
COPY --from=prod-deps /app/packages/insights/node_modules ./packages/insights/node_modules
COPY --from=prod-deps /app/packages/metrics/node_modules ./packages/metrics/node_modules
COPY --from=prod-deps /app/packages/reports/node_modules ./packages/reports/node_modules
COPY --from=prod-deps /app/packages/security/node_modules ./packages/security/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=runtime-src /app ./
# The generated SQL and drizzle's bookkeeping table — the same ones drizzle-kit
# writes, so the two are interchangeable.
COPY packages/shared/drizzle packages/shared/drizzle
RUN npm install -g tsx@4.23.1 && npm cache clean --force
CMD ["tsx", "apps/api/src/migrate.ts"]

# ---------- runtime: web ----------
FROM nginx:1.27-alpine AS web
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
# W17-06. `wget`, NOT node: this image is nginx:alpine and has no node at all
# (verified in-image), so the api/worker probe copied here would mark every web
# container unhealthy forever. Checks that nginx is serving the built index,
# which is the whole job of this container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
