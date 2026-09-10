# syntax=docker/dockerfile:1
# Production Next.js image for the community admin operator console.
#
# Build context is the `community/` root (see ../../docker-compose.yml), not this
# directory, so every COPY below is rooted at `apps/admin/...`.
#
# apps/admin/next.config.ts only enables `output: "standalone"` when the
# NEXT_OUTPUT build-time env var is exactly "standalone" (it also supports
# "export", which this image deliberately does not use). Setting NEXT_OUTPUT
# below is what makes `next build` emit .next/standalone.
#
# NEXT_PUBLIC_* vars are baked into the client bundle at build time (they run
# in the end user's browser, not inside this container), so they must be the
# host-facing URLs docker-compose publishes each service on (localhost:<port>),
# not the internal Docker service names.
FROM node:20-alpine AS deps
WORKDIR /app
COPY apps/admin/package.json apps/admin/package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_OUTPUT=standalone

# Verified via grep of process.env.NEXT_PUBLIC_* under
# apps/admin/{app,components,lib} -- admin only reads these five.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_LANDING_URL=http://localhost:3001
ARG NEXT_PUBLIC_DASHBOARD_URL=http://localhost:53000
ARG NEXT_PUBLIC_ADMIN_URL=http://localhost:3002
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_LANDING_URL=$NEXT_PUBLIC_LANDING_URL \
    NEXT_PUBLIC_DASHBOARD_URL=$NEXT_PUBLIC_DASHBOARD_URL \
    NEXT_PUBLIC_ADMIN_URL=$NEXT_PUBLIC_ADMIN_URL \
    NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID

COPY --from=deps /app/node_modules ./node_modules
COPY apps/admin/. .
# Verified: apps/admin/package.json "build" == "next build".
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3002

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3002
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3002) + '/').then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"

# Verified: .next/standalone always emits server.js as the entrypoint.
CMD ["node", "server.js"]
