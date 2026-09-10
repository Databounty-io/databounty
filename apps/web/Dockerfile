# Production Next.js image for the community contributor/sponsor dashboard.
#
# Build context is the `community/` root (see ../../docker-compose.yml), not this
# directory, so every COPY below is rooted at `apps/web/...`.
#
# apps/web/next.config.ts only enables `output: "standalone"` when the
# NEXT_OUTPUT build-time env var is exactly "standalone" (it also supports
# "export", but that would drop the `/mcp/:path*` rewrite this app defines and
# is not what this image uses) -- verified against next.config.ts. Setting
# NEXT_OUTPUT below is what makes `next build` emit .next/standalone.
#
# NEXT_PUBLIC_* vars are baked into the client bundle at build time (they run
# in the end user's browser, not inside this container), so they must be the
# host-facing URLs docker-compose publishes each service on (localhost:<port>),
# not the internal Docker service names -- matches the same convention already
# used in the original app's Dockerfile and infra/deploy/web/Dockerfile.
FROM node:20-alpine AS deps
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_OUTPUT=standalone

# Required by every fetch call in apps/web/lib -- verified via next.config.ts
# and grep of process.env.NEXT_PUBLIC_* under apps/web/{app,components,lib}.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_LANDING_URL=http://localhost:3001
ARG NEXT_PUBLIC_DASHBOARD_URL=http://localhost:53000
ARG NEXT_PUBLIC_ADMIN_URL=http://localhost:3002
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=
# Optional upload-tuning knobs -- all have safe fallbacks in
# apps/web/lib/api-artifacts.ts when unset, so leaving these empty at build
# time is fine; exposed as ARGs only so an operator can override them.
ARG NEXT_PUBLIC_MAX_UPLOAD_BYTES=
ARG NEXT_PUBLIC_DIRECT_UPLOAD_TIMEOUT_MS=
ARG NEXT_PUBLIC_MULTIPART_PART_CONCURRENCY=
ARG NEXT_PUBLIC_MULTIPART_THRESHOLD_BYTES=
ARG NEXT_PUBLIC_MULTIPART_PART_SIZE_BYTES=
ARG NEXT_PUBLIC_MAX_MULTIPART_UPLOAD_BYTES=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_LANDING_URL=$NEXT_PUBLIC_LANDING_URL \
    NEXT_PUBLIC_DASHBOARD_URL=$NEXT_PUBLIC_DASHBOARD_URL \
    NEXT_PUBLIC_ADMIN_URL=$NEXT_PUBLIC_ADMIN_URL \
    NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID \
    NEXT_PUBLIC_MAX_UPLOAD_BYTES=$NEXT_PUBLIC_MAX_UPLOAD_BYTES \
    NEXT_PUBLIC_DIRECT_UPLOAD_TIMEOUT_MS=$NEXT_PUBLIC_DIRECT_UPLOAD_TIMEOUT_MS \
    NEXT_PUBLIC_MULTIPART_PART_CONCURRENCY=$NEXT_PUBLIC_MULTIPART_PART_CONCURRENCY \
    NEXT_PUBLIC_MULTIPART_THRESHOLD_BYTES=$NEXT_PUBLIC_MULTIPART_THRESHOLD_BYTES \
    NEXT_PUBLIC_MULTIPART_PART_SIZE_BYTES=$NEXT_PUBLIC_MULTIPART_PART_SIZE_BYTES \
    NEXT_PUBLIC_MAX_MULTIPART_UPLOAD_BYTES=$NEXT_PUBLIC_MAX_MULTIPART_UPLOAD_BYTES

COPY --from=deps /app/node_modules ./node_modules
COPY apps/web/. .
# Verified: apps/web/package.json "build" == "next build".
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=53000

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 53000
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 53000) + '/').then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"

# Verified: .next/standalone always emits server.js as the entrypoint.
CMD ["node", "server.js"]
