# DataBounty Community API

Fastify + Prisma + PostgreSQL backend for DataBounty Community: REST + MCP endpoints for sponsors, contributors,
validators and admins, plus a background worker that runs the validation pipeline (dedup, AI-attribution
disclosure scan, sandboxed execution, optional LLM review, pool-capacity claim, human audit) and dataset
publication. External-corpus contamination screening is **not** a stage — it was deliberately removed rather
than left as a stub that always reported "not attempted".

See the [top-level README](../../README.md) for the overall four-app architecture, and
[../../DEPLOYMENT.md](../../DEPLOYMENT.md) for production build/deploy notes.

## Running standalone

```bash
npm install
cp .env.example .env      # then fill in DATABASE_URL and the session secrets at minimum
npx prisma migrate deploy # or `prisma migrate dev` during schema development
npx tsx prisma/seed-catalog.ts   # idempotent — loads the 50-type dataset catalog
npm run dev                # API on http://localhost:4000
```

Run the background worker as a **separate** process — it is required for validation/publish jobs to ever
complete, not optional:

```bash
```

Other useful scripts (see `package.json`): `npm run typecheck`, `npm test` (vitest), `npm run prisma:migrate:status`,
`npm run build` (`tsc -p tsconfig.json` → `dist/`), `npm start` (runs the built `dist/` output — one
process, which also starts the background job queue and sweeps).

Requires Node `>=20.19.0` (declared in `package.json` `engines`) and a reachable PostgreSQL database.

## Port

`4000` by default (`PORT` env var, default set in `src/config.ts`).

## Environment variables

The authoritative list is [`.env.example`](.env.example) in this directory — copy it to `.env` and fill it in.
Summary, grouped as in that file:

| Variable | Required? | Purpose |
|---|---|---|
| `NODE_ENV`, `PORT` | No (sensible dev defaults) | Runtime mode and listen port. |
| `DATABASE_URL` | **Yes** | Postgres connection string. |
| `DIRECT_URL` | Only with a transaction pooler | Migration/CLI connection, read **only** by the Prisma CLI (`prisma.config.ts`), never by the runtime. Unset → the CLI uses `DATABASE_URL`, which is correct for local Postgres and the bundled compose database. Required when `DATABASE_URL` is a transaction pooler (Supabase `6543`, `pgbouncer=true`): that pooler cannot hold Prisma Migrate's session advisory lock and `prisma migrate` **hangs** rather than erroring. Point it at the session pooler (`5432`). |
| `APP_URL`, `ADMIN_URL`, `CORS_ORIGINS` | Effectively yes | Used to build links in emails/notifications and to gate cross-origin requests from the frontend apps. `CORS_ORIGINS` is a comma-separated list — every frontend origin you run must be in it or the browser blocks the request. |
| `SESSION_SECRET`, `ADMIN_SESSION_SECRET` | **Yes in production** | Session signing keys. `src/config.ts` falls back to a hardcoded dev literal if unset and **does not refuse to start** on that fallback, in production or anywhere else — a known gap, see [Configuration](../../docs/configuration.md#secrets-that-silently-fall-back-to-a-development-value). Treat leaving either unset as a deployment failure even though the process starts. The only boot refusals are `ADMIN_URL` unset, `EXECUTION_SANDBOX_ALLOW_EGRESS=true` and `EXECUTION_SANDBOX_VERIFY_ISOLATION=false` in production, plus the execution-timeout ordering check. |
| `ENTERPRISE_ASSERTION_SECRET`, `ENTERPRISE_SERVICE_SECRET` | Only if pairing with the separate Enterprise API | Shared HMAC secrets for the cross-service identity bridge; irrelevant if you're running Community on its own. |
| `OPENROUTER_API_KEY` | No | Enables LLM review. Unset → the LLM stage never auto-accepts; it records an unconfigured outcome and the item routes to human review. |
| `E2B_API_KEY`, `E2B_TEMPLATE` | No | Enables real sandboxed code execution. Unset → the execution stage records `no_provider_configured` and routes every item to human review; no contributor code executes anywhere. When a key is set, startup also requires that the E2B SDK and all of its dependencies can load; an incomplete install refuses boot rather than failing each queued execution later. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | No | Enables outbound email notifications. Unset → deliveries dead-letter with an explicit, listable reason instead of silently vanishing or reporting `sent`. |
| `GITHUB_OAUTH_CLIENT_ID`/`SECRET`, `ORCID_OAUTH_CLIENT_ID`/`SECRET` | No | Credential-verification OAuth for contributor profiles. Register your own app — do not reuse another deployment's client secret. |
| `SLACK_CLIENT_ID`/`SECRET`, `TELEGRAM_BOT_TOKEN`/`USERNAME` | No | Optional notification channels. |

A few additional variables are read in source but not currently listed in `.env.example` — check before relying
on `.env.example` alone as a complete inventory:

- `HUGGINGFACE_API_TOKEN`, `HUGGINGFACE_API_URL`, `HUGGINGFACE_NAMESPACE` — Hugging Face dataset publication
  (`src/lib/publication/hugging-face.ts`). Unset → publication records a `not_configured` status per target,
  surfaced to an admin, never a fake "published".
- `GITHUB_PUBLICATION_TOKEN`, `GITHUB_PUBLICATION_OWNER`, `GITHUB_PUBLICATION_API_URL` — GitHub dataset
  publication (`src/lib/publication/github.ts`), same fail-closed behavior as Hugging Face above.
- `ARTIFACT_SCAN_URL`, `ARTIFACT_SCAN_TOKEN`, `ARTIFACT_SCAN_TIMEOUT_MS` — malware scanning endpoint. Scanning
  itself is gated by a database-stored admin setting (`artifacts.malware_scan.enabled`, off by default), not by
  these env vars alone. That setting is read directly by `src/services/artifact-scanner.ts` and is **not** in the
  validated settings catalog, so it has no admin route or console UI — today it can only be turned on by writing
  the `admin_settings` row directly. Documented gap.
- `STORAGE_DRIVER` (`local`, the default, or `s3`), `STORAGE_LOCAL_DIR` and the `STORAGE_*`/`AWS_*` family —
  artifact storage backend. The local-directory driver is single-instance only; see
  [Configuration](../../docs/configuration.md#object-storage--uploaded-files) for the full set.
- `EXECUTION_RUNNER_TIMEOUT_MS` and the `EXECUTION_SANDBOX_*` family (`ALLOW_EGRESS`, `EGRESS_ALLOWLIST`,
  `VERIFY_ISOLATION`, `MAX_CPUS`, `MAX_MEMORY_MB`, `MAX_PROCESSES`, `MAX_FILE_SIZE_MB`, `MAX_OPEN_FILES`) —
  sandbox isolation posture; see `src/config.ts` for exact defaults and bounds. Two of these
  (`EXECUTION_SANDBOX_ALLOW_EGRESS=true`, `EXECUTION_SANDBOX_VERIFY_ISOLATION=false`) make the process refuse to
  boot in production rather than silently degrading — see [../../DEPLOYMENT.md](../../DEPLOYMENT.md).

---

Reference documentation: [REST API](../../docs/api.md) · [MCP server](../../docs/mcp.md) · [Configuration](../../docs/configuration.md) · [Architecture](../../docs/architecture.md)
