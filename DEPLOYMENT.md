# Deployment

<!-- doc-control -->
> **Version:** v1.2 · **Status:** Active · **Area:** Engineering + Operations · **Last verified:** 2026-09-09 · **Source of truth:** `docker-compose.yml`, `apps/api/src/config.ts`, `apps/api/prisma/seed-admin.ts` and `.github/workflows/ci.yml` in this repository — code wins over anything below.

This is a single document covering all four apps rather than one per app, since deployment is a cross-app
concern (they all need to agree on each other's URLs at build/run time).

## Production build commands

Verified by running each command directly in this checkout on 2026-08-31; all four exited `0` with no errors.

| App | Build command | Run command | Notes |
|---|---|---|---|
| `apps/api` | `npm run build` (`tsc -p tsconfig.json`) | `npm start` (`node dist/server.js`) | **One process.** The job queue, Telegram listener, notification dispatch and every time-based sweep run inside it. There is no separate worker to deploy (that split was removed 2026-09-02 — it was defined in compose but never in `infra/`, so real deployments had nothing draining the queue). Run a **single** instance: the sweeps are not partitioned across instances. |
| `apps/web` | `npm run build` (`next build`) | `npm start` (`next start`), or serve `.next/standalone` if built with `NEXT_OUTPUT=standalone` | |
| `apps/admin` | `npm run build` (`next build`) | `npm start` (`next start`), or serve `.next/standalone` if built with `NEXT_OUTPUT=standalone` | `NEXT_OUTPUT=export` still produces a static `out/` for a CDN, but the served app is the default. |
| `apps/landing` | `npm run build` (`next build`) | `npm start` (`next start`), or serve `.next/standalone` if built with `NEXT_OUTPUT=standalone` | |

Reproduce the verification yourself: `cd apps/<app> && npm run build` (or `npx tsc -p tsconfig.json` for `api`)
in each of the four directories.

## Docker

`docker-compose.yml` at this directory's root builds and runs all four apps plus Postgres with one command:
`docker compose up`. `api`'s build reaches `npx prisma migrate deploy` / `tsx prisma/seed-catalog.ts` via
the one-shot `api-migrate`/`api-seed` services before the long-running `api` service starts. **There is no
separate `worker` service** — the job queue, Telegram listener, notification dispatch and every
time-based sweep all run inside the single `api` process; see the note below. A third one-shot,
`api-seed-admin`, runs after `api-seed` and bootstraps the first admin account when — and only when —
`SUPER_ADMIN_PASSWORD` is set.

> **Verification status.** This section is reviewed against the current `apps/api/Dockerfile`,
> `.dockerignore` and `docker-compose.yml` by static reading, not a live `docker compose build && docker
> compose up` run — Docker was unavailable on the machine that reviewed it. Re-run that command yourself
> before relying on "builds clean."

### Compose defaults to a bootable configuration

`docker-compose.yml` defaults `NODE_ENV` to `development` and `ADMIN_URL` to `http://localhost:3002`,
matching `apps/api/.env.example` and every other localhost-shaped default in the file. `NODE_ENV=production`
together with a stale or unset `ADMIN_URL` is refused at boot by `apps/api/src/config.ts` on purpose — a
stale `ADMIN_URL` would silently misroute every admin-console request to the wrong session cookie — so
`docker compose up` with no overrides boots successfully by defaulting away from production rather than by
weakening that guard.

With the compose defaults and nothing else set, all four boot guards pass:

| Guard | Why it does not fire |
|---|---|
| `ADMIN_URL` unset in production (`config.ts:400`) | Gated on `isProdEnv`, which is false for `development` (`config.ts:90` — a denylist: anything other than `development`/`test` counts as production, not an allowlist of `production`/`prod`/`live`, but `development` is exempt either way). |
| `EXECUTION_SANDBOX_ALLOW_EGRESS=true` in production (`config.ts:357`) | Outer `if` is on the flag, not the environment. Compose sets the var nowhere, so it defaults to `false` (`config.ts:311`) and the block is never entered — no warning either. |
| `EXECUTION_SANDBOX_VERIFY_ISOLATION=false` in production (`config.ts:372`) | Same shape: default is `true` (`config.ts:318`), so the block is never entered. |
| Timeout ordering (`config.ts:337-346`, environment-independent) | `innerWorstCase = childTimeoutMs * 2 + probeTimeoutMs` must be less than the command timeout, which must be less than the sandbox lifetime. Holds by construction with compose's defaults. |

With `NODE_ENV=development` by default, the stack also never runs with the dev-only literal
`SESSION_SECRET`/`ADMIN_SESSION_SECRET` fallbacks, and `lib/session-cookie.ts` never marks cookies
`Secure` over plain `http://localhost`.

**Deploying for real means overriding both together.** Set `NODE_ENV=production` *and* a real `ADMIN_URL`
(plus real secrets, see the bottom of this document) in a top-level `.env`. Setting `NODE_ENV=production`
alone, with `ADMIN_URL` left at its localhost default, is refused at boot by design.

### Bootstrapping the first admin under Docker

There is now an `api-seed-admin` one-shot service, modelled on `api-migrate`/`api-seed` (`target: build`,
`restart: "no"`, ordered by `service_completed_successfully`). It runs after `api-seed` and executes
`npx tsx prisma/seed-admin.ts`, the only code path in this repository that grants the `admin` role.

It is **opt-in via `SUPER_ADMIN_PASSWORD`, not via the service's presence**, and no default password is
committed. Its behaviour is the script's own (read `apps/api/prisma/seed-admin.ts`):

- password unset, non-production `NODE_ENV` → logs a warning, creates nothing, exits `0`
- password unset, production `NODE_ENV` → throws, exits `1` (deliberate: a production deploy must not
  complete believing an admin exists when none does)
- password set → creates the account if absent, always ensures the `admin` role, and **never** rewrites an
  existing account's password. Safe to re-run on every redeploy.

```bash
SUPER_ADMIN_EMAIL=you@yourcompany.com SUPER_ADMIN_PASSWORD='...' docker compose up
```

**Nothing depends on `api-seed-admin`.** `api` and `worker` still depend only on `api-seed`. That is
deliberate: an edge from `api` would be satisfied by the skip path anyway (it exits `0`), so it would buy
nothing in the common case, while on the production-without-a-password path it would turn "you have no admin"
into "you have no API". The trade-off is that a skip is easy to miss — check
`docker compose logs api-seed-admin` rather than assuming an admin was created.

The service inherits `api`'s **full** environment rather than just `DATABASE_URL` (unlike
`api-migrate`/`api-seed`), because `seed-admin.ts` imports `src/config.ts` and therefore runs every boot guard
in the table above, including the production `ADMIN_URL` one. Same `NODE_ENV`/`ADMIN_URL` as the API means this
one-shot can never pass or fail those guards differently from the service it is bootstrapping an admin for.

### Postgres 17 — and the upgrade footgun

`docker-compose.yml` now runs `postgres:17-alpine`, matching the `postgres:17` that
`.github/workflows/ci.yml` tests against. Before the change CI tested 17 while the shipped stack ran
`16-alpine`, so CI was not exercising the version self-hosters got.

Checked before changing it: nothing in `apps/api/prisma/` depends on a version-specific feature. There are no
`CREATE EXTENSION` statements anywhere in the ten migrations, `schema.prisma`'s datasource is plain
`provider = "postgresql"` with no `extensions`/`previewFeatures`, and no migration uses `NULLS NOT DISTINCT`,
`MERGE`, `JSON_TABLE`, generated columns or `CREATE INDEX CONCURRENTLY`. The schema is portable across 16 and 17.

> **Upgrading an existing stack from Postgres 16 is NOT automatic and NOT safe by default.** A `postgres_data`
> volume initialised by 16 will not start under 17: Postgres refuses a data directory written by a different
> major (`database files are incompatible with server`), the container exits, and every service that depends on
> it fails with it. Pulling this change onto a stack that already has data therefore needs a deliberate step.
>
> **Keep your data (dump/restore).** Do this *before* pulling the change, while the volume is still served by 16:
>
> ```bash
> docker compose exec postgres pg_dumpall -U postgres > community-pg16.sql   # still on 16
> docker compose down
> docker volume rm community_postgres_data                                   # confirm the name: docker volume ls
> docker compose up -d postgres                                              # now initialises fresh under 17
> docker compose exec -T postgres psql -U postgres < community-pg16.sql
> docker compose up
> ```
>
> **Or start clean (destructive — deletes every row).** `docker compose down -v` removes the named volumes,
> including `api_artifacts`, then `docker compose up` re-initialises under 17 and re-runs `api-migrate`/`api-seed`.
>
> **Or pin back.** Set `image: postgres:16-alpine` in your own override file and accept that CI is testing a
> different major than you run.
>
> A brand-new stack (no existing `postgres_data` volume) needs none of this and is unaffected.

**If you're on a network that intercepts outbound TLS** (corporate SSL inspection, a transparent proxy with its
own CA) — `apps/api`'s Docker build downloads Prisma's engine binary over HTTPS during `npx prisma generate`, and
that download fails with `self-signed certificate in certificate chain` on such a network. This is a network
property, not a bug in the app or the Dockerfile — confirmed by running the exact same command outside Docker
with that network's CA cert supplied via `NODE_EXTRA_CA_CERTS`, which succeeds immediately.

The Dockerfile handles this as an **opt-in BuildKit secret**, off by default:

```bash
# Only needed if your network intercepts TLS. Export your network's CA cert first, then:
CA_CERT_PATH=/path/to/your-network-ca.pem docker compose build
```

Leaving `CA_CERT_PATH` unset builds exactly as before — the secret resolves to `/dev/null` (always present,
always empty), the Dockerfile's `if [ -s ... ]` check correctly reads that as "no cert provided," and
`prisma generate` runs with no modification. A deployment host or CI runner with normal, uninspected outbound
TLS never needs to set this.

## What has to be true for a real deployment

- **Postgres is reachable** from `apps/api` (and only from `apps/api` — the three frontend apps never talk to
  the database directly). One database is enough; there is a single Prisma schema (`apps/api/prisma/schema.prisma`).
- **All four apps' env vars are set** for the environment you're deploying to — see each app's own
  `README.md` / `.env.example` for the full list. At minimum: `apps/api` needs `DATABASE_URL`, `SESSION_SECRET`,
  `ADMIN_SESSION_SECRET`, `APP_URL`, `ADMIN_URL`, and `CORS_ORIGINS` listing every frontend origin; each frontend
  app needs `NEXT_PUBLIC_API_URL` and the sibling-app URL variables.
- **Migrations are applied**: `npx prisma migrate deploy` from `apps/api` against the target database before the
  API process starts. There are **seven** committed migrations in `apps/api/prisma/migrations/` as of
  2026-09-09 (`init`, `add_dataset_type_sponsor_harness_note`, `add_oauth_token_authorization_code_link`,
  `agent_issue_context_collection_honest_default`, `add_bounties_title_trgm_index`,
  `add_upload_draft_submit_progress`, `backfill_community_pool_dispute_windows`).
  This count and name list have gone stale more than once already — always confirm with
  `npx prisma migrate status` against the target database rather than trusting a count in prose.
- **The dataset-type catalog is seeded**: `npx tsx prisma/seed-catalog.ts` from `apps/api`, against the target
  database. It's idempotent (upserts by id) — safe to run again on redeploy. Verified: running it a second time
  against an already-seeded database reported `0 created, 50 updated`, no errors.
- **The first admin exists**: `apps/admin` has no admin signup by design ("admin accounts are provisioned
  separately, not created here") and no other code in this repo can grant the `admin` role, so a fresh deployment
  has zero admins and no way to create one without this step. Run
  `SUPER_ADMIN_EMAIL=you@yourcompany.com SUPER_ADMIN_PASSWORD='...' npx tsx prisma/seed-admin.ts` from `apps/api`
  against the target database. Idempotent (never rewrites an existing account's password — safe to re-run on
  redeploy, it only ensures the role exists). **In production this is not optional**: leaving
  `SUPER_ADMIN_PASSWORD` unset makes the script throw rather than silently no-op, so a deploy can't complete
  believing an admin exists when none does. Outside production, an unset password logs a warning and skips
  cleanly (local/CI accounts come from `scripts/seed-e2e-accounts.ts` instead — never use that script's hardcoded
  test credentials in a real deployment). Under Docker this is the `api-seed-admin` one-shot service — see
  "Bootstrapping the first admin under Docker" above; it runs the same script with the same semantics.
- **The API process is running** — it now owns background work too, so there is nothing separate to check. Without the API, jobs enqueued by the
  API (validation runs, artifact scans, pool sampling, publication) are written to the queue but never picked up.

## Optional integrations — what happens when each is unset

Every one of these fails **closed** to an explicit "not configured" outcome rather than a fake success. Spot-checked
directly against source on 2026-08-31 (file:line references below); not exhaustively re-verified for every
integration in this list, but the pattern is consistent everywhere it was checked.

| Integration | Env var(s) | Behavior when unset |
|---|---|---|
| **Execution sandbox (E2B)** | `E2B_API_KEY`, `E2B_TEMPLATE` | The execution stage records `no_provider_configured` and routes every item to human review. No contributor code executes anywhere, on the API host or otherwise. (`apps/api/src/services/execution-providers/e2b.ts:305-310`) |
| **LLM review** | `OPENROUTER_API_KEY` | The LLM review stage never auto-accepts; when unconfigured it records a `not_configured`-style outcome and the item still routes to human review. (`apps/api/src/config.ts` comment + `apps/api/.env.example`) |
| **Malware scanning** | `ARTIFACT_SCAN_URL`, `ARTIFACT_SCAN_TOKEN` (plus the DB-backed admin setting `artifacts.malware_scan.enabled`, off by default) | Returns `not_required` with an explicit detail string — "malware scanning disabled" or "…enabled but `ARTIFACT_SCAN_URL` is not configured — nothing was scanned" — never a fake "clean" verdict. (`apps/api/src/services/artifact-scanner.ts:16-41`) |
| **Email (SMTP)** | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | Notification deliveries that would go out by email dead-letter with a recorded, listable reason (`apps/api/src/services/notifications.ts` dead-letter query/requeue path) rather than silently disappearing or reporting `sent`. |
| **Hugging Face publish** | `HUGGINGFACE_API_TOKEN`, `HUGGINGFACE_API_URL`, `HUGGINGFACE_NAMESPACE` | Publication records a `not_configured` status per target, is terminal (won't silently retry forever), and is surfaced to an admin rather than reported as published. (`apps/api/src/services/community-publish.ts:120,356-357`) |
| **GitHub publish** | `GITHUB_PUBLICATION_TOKEN`, `GITHUB_PUBLICATION_OWNER`, `GITHUB_PUBLICATION_API_URL` | Same `not_configured` path as Hugging Face above (shared `recordDatasetPublication`/publication-provider code). |
| **Credential OAuth (GitHub, ORCID)** | `GITHUB_OAUTH_CLIENT_ID`/`SECRET`, `ORCID_OAUTH_CLIENT_ID`/`SECRET` | The corresponding "connect your GitHub/ORCID" credential-verification flow is unavailable; it does not fall back to a fake verified credential. |
| **Notification channels (Slack, Telegram)** | `SLACK_CLIENT_ID`/`SECRET`, `TELEGRAM_BOT_TOKEN`/`USERNAME` | The channel is simply not offered/connectable; in-app and (if configured) email notifications are unaffected. |
| **Google sign-in (web/admin/landing)** | `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | The sign-in UI shows "Google sign-in is not configured (missing client ID)" instead of a broken or silently-hanging button. (`apps/web/components/auth.tsx:105-108`) |

Three production-only hard failures worth knowing about explicitly (not "misconfigured → degraded", but
"misconfigured → refuses to boot"), all in `apps/api/src/config.ts`:

- `EXECUTION_SANDBOX_ALLOW_EGRESS=true` in production (`NODE_ENV=production`/`prod`/`live`) throws at boot —
  contributor code is never allowed unrestricted network egress in a real deployment.
- `EXECUTION_SANDBOX_VERIFY_ISOLATION=false` in production also throws at boot — an execution verdict that was
  never confirmed to run in an isolated sandbox is not allowed to be recorded as a trustworthy verdict.
- `ADMIN_URL` left unset in production throws at boot — it would otherwise default to `localhost:3002` and
  misroute every admin-console request to the wrong session cookie.

A fourth guard is environment-independent: the execution timeouts must be ordered
`inner worst case < command timeout < sandbox lifetime`, or startup fails.

None of these has a "just don't set it" escape hatch in production; they're deliberate refusals, not defaults
you can quietly override. **The session secrets are among them, not exempt from this.** `SESSION_SECRET`,
`ADMIN_SESSION_SECRET`, `POOL_SAMPLING_HMAC_SECRET`, and `PROFILE_SOURCE_SECRET` all fall back to dev
literals published in this repository, but the process now refuses to start if any of them is left at that
default in production — see
[docs/configuration.md](docs/configuration.md#secrets-that-silently-fall-back-to-a-development-value). Set
all four anyway rather than relying on the guard as your only line of defense.
