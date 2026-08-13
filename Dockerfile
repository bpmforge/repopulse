# RepoPulse — one multi-stage build, four runtime targets (W11-01).
#
# Targets: api, worker, migrate, web. They share the dependency and build stages
# so a full `compose build` resolves the pnpm workspace ONCE rather than four
# times.
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

# ---------- deps ----------
# Manifests only, so a source-only edit reuses the cached install layer.
FROM base AS deps
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
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

# ---------- source ----------
FROM deps AS source
COPY . .

# ---------- web build ----------
FROM source AS web-build
# The SPA talks only to /api/v1 on its own origin (Law 4), so there is no API
# URL to bake in at build time — nginx routes it. That is what keeps one image
# usable at any customer hostname.
RUN pnpm --filter @repopulse/web exec vite build

# ---------- runtime: api ----------
FROM source AS api
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S -G app app && chown -R app:app /app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@repopulse/api", "exec", "tsx", "src/index.ts"]

# ---------- runtime: worker ----------
FROM source AS worker
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S -G app app && chown -R app:app /app
USER app
CMD ["pnpm", "--filter", "@repopulse/api", "exec", "tsx", "src/workers/index.ts"]

# ---------- one-shot: migrate ----------
# Runs to completion before api/worker start. Drizzle records applied
# migrations, so a second `up` on an existing install is a no-op, not a
# re-migrate.
FROM source AS migrate
ENV NODE_ENV=production
CMD ["pnpm", "exec", "drizzle-kit", "migrate"]

# ---------- runtime: web ----------
FROM nginx:1.27-alpine AS web
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
