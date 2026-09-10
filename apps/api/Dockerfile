# Multi-stage build for the DataBounty Community API (Fastify + Prisma + Postgres).
#
# Build context is the `community/` root (see ../../docker-compose.yml), not this
# directory, so every COPY below is rooted at `apps/api/...` and a single top-level
# `community/.dockerignore` can keep every app's node_modules/.next/out/dist out of
# every build context.
#
# Stages:
#   deps    - install ALL dependencies (npm ci; includes devDependencies: the
#             `prisma` CLI, `typescript`, `tsx`, `vitest`).
#   build   - generate the Prisma client (npx prisma generate) and compile
#             TypeScript (npm run build == "tsc -p tsconfig.json" -> dist/,
#             verified against apps/api/package.json + tsconfig.json:
#             rootDir "src", outDir "dist").
#   runner  - slim production image: pruned node_modules (devDependencies
#             removed) + compiled dist/ only. This is the default final stage
#             and is what the `api` and `worker` compose services run — worker
#             (background work runs inside the server process; there is no
#             separate worker entrypoint any more).
#
# `build` is also used directly, via `target: build`, by the one-shot
# `api-migrate` and `api-seed` compose services: they need the full
# node_modules (prisma CLI, tsx) and the prisma/ directory (schema,
# migrations, prisma.config.ts, dataset-catalog/*.json) that `runner`
# deliberately does not ship, to run `prisma migrate deploy` and
# `tsx prisma/seed-catalog.ts` respectively.

FROM node:20-alpine AS deps
WORKDIR /app
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/api/. .

# Verified: apps/api/package.json "prisma:generate" == "prisma generate".
# Produces node_modules/@prisma/client + node_modules/.prisma/client from
# prisma/schema.prisma. Confirmed by actually running this build:
# prisma.config.ts calls env("DATABASE_URL") at CLI-config-load time for
# EVERY prisma command including `generate`, not only datasource-touching
# ones -- `prisma generate` fails immediately with
# "PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL"
# if the var is entirely unset, even though generate never opens a
# connection. A syntactically-valid placeholder is enough (never used to
# connect); the runtime containers get their real DATABASE_URL from
# docker-compose.yml.
ARG DATABASE_URL="postgresql://placeholder:placeholder@placeholder:5432/placeholder?schema=public"
ENV DATABASE_URL=$DATABASE_URL

# `prisma generate` downloads its engine binary over HTTPS from
# binaries.prisma.sh. On a network that terminates outbound TLS with its own
# CA (e.g. corporate SSL inspection), that download fails with "self-signed
# certificate in certificate chain" -- confirmed on this machine: the exact
# same command succeeds instantly once NODE_EXTRA_CA_CERTS points at that
# network's CA, per this repo's own CLAUDE.md. A normal deployment host or CI
# runner has no such interception, so this must be a no-op there by default.
#
# BuildKit secrets are the right tool: the mounted file exists ONLY for a
# build that explicitly opts in with `--secret id=ca_cert,src=<path>`
# (docker-compose.yml's `api`/`api-migrate`/`api-seed`/`worker` build
# sections read it from the optional CA_CERT_PATH host env var). Anyone
# building without that flag gets an empty/missing file, the `-s` check
# below is false, NODE_EXTRA_CA_CERTS is never set, and `prisma generate`
# runs exactly as it did before this change.
RUN --mount=type=secret,id=ca_cert \
    if [ -s /run/secrets/ca_cert ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/ca_cert npx prisma generate; \
    else \
      npx prisma generate; \
    fi

# Verified: apps/api/package.json "build" == "tsc -p tsconfig.json".
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 apiuser

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
# Drops devDependencies (prisma CLI, tsx, typescript, vitest, ...). The
# already-generated @prisma/client survives: it is a production dependency
# and `npm prune` removes/installs packages, it does not touch generated
# files already written inside a kept package.
RUN npm prune --omit=dev
# Fail the BUILD, not the first request, if that assumption ever stops holding.
# The runtime connects through the @prisma/adapter-pg driver adapter
# (src/lib/prisma.ts), so no query-engine binary is needed here -- but the
# generated client JS is, and it lives in a directory npm's tree walker does
# not own. Without this check a prune that swept it away would surface as a
# "Cannot find module '.prisma/client/default'" crash loop at container start.
RUN node -e "require('node:fs').accessSync('node_modules/.prisma/client/index.js')" \
  || (echo "prisma client was removed by 'npm prune' -- see comment above" && exit 1)
COPY --from=build /app/dist ./dist

# The per-category verification corpus. registry-loader.ts reads these files
# from DISK on every submission (harness.js / lib/helpers.js / run.js /
# categories.json), so they are runtime source, not build-time input -- the
# build stage's `COPY apps/api/. .` is not enough on its own.
#
# Leaving this out fails SILENTLY and expensively: the loader finds no
# categories.json, `loadCategories()` returns an empty map, every
# `buildRegistryHarness()` returns null, resolution falls through to the
# generic role-based harness, and any category whose payload carries its test
# content under its own field key (e.g. caching_strategy's `operations`)
# resolves nothing at all and is recorded as `no_executable_harness` -- a
# validator-review queue instead of an execution verdict, with a container
# that reports perfectly healthy. Observed on dev 2026-09-09 before this line
# existed: 21 such rows in 24h against 1 real execution.
COPY --from=build /app/registry ./registry
# Fail the BUILD, not the first submission, if the corpus ever stops shipping.
# Same reasoning as the prisma-client assertion above: a quiet absence here is
# indistinguishable from "no category needed a harness" at runtime.
RUN node -e "const f=require('node:fs');f.accessSync('registry/categories.json');f.accessSync('registry/run.js');f.accessSync('registry/lib/helpers.js');const n=f.readdirSync('registry/harnesses').length;if(n<50)throw new Error('only '+n+' harness folders');" \
  || (echo "registry corpus missing/incomplete in the runtime image -- see comment above" && exit 1)

# STORAGE_DRIVER defaults to "local" (src/config.ts), whose driver writes under
# ./data/artifacts relative to the working directory. Everything COPYed above is
# root-owned and the process runs as `apiuser`, so without this the driver's
# `mkdir(recursive)` fails EACCES on the first upload -- at request time, long
# after the image looked healthy. Created empty and owned here; mount a volume
# over it (docker-compose.yml does) to make uploads outlive the container.
RUN mkdir -p /app/data/artifacts && chown -R apiuser:nodejs /app/data

ENV PORT=4000 \
    HOST=0.0.0.0
EXPOSE 4000
USER apiuser

# Verified real endpoint: apps/api/src/routes/health.ts registers
# GET /health (and /healthz), both returning {status:"ok"} with HTTP 200, no
# auth required, no DB round-trip. wget is provided by alpine's busybox.
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider "http://127.0.0.1:${PORT}/health" || exit 1

# Verified real script: apps/api/package.json "start" == "node dist/server.js".
# Single entrypoint: the server also starts the job queue, the Telegram
# listener, notification dispatch and the time-based sweeps
# (src/worker.ts -> startBackgroundWorkers, called from src/server.ts).
CMD ["node", "dist/server.js"]
