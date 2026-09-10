# Self-hosting

From empty database to serving traffic, and keeping it there.

[DEPLOYMENT.md](../DEPLOYMENT.md) has the build commands and the Docker path. This picks up where that
stops: first run, seeding, upgrades, backups, and the failures that look like bugs but aren't.

---

## What you are running

Five processes and a database:

| Process | Required | Notes |
|---|---|---|
| `apps/api` | yes | REST + MCP, **and all background work** — the job queue, Telegram listener, notification dispatch and the time-based sweeps run inside this process. |
| `apps/web` | yes, for members | |
| `apps/admin` | yes, to operate it | |
| `apps/landing` | optional | Public catalog and profiles. |
| Postgres | yes | |

> **There is no separate worker process.** Deduplication, sandboxed execution, publication, file scanning
> and parsing all run as background jobs inside the API process, so running the API is enough.
>
> **Run one API instance.** The job claim is safe under concurrency, but the periodic sweeps are not
> partitioned across instances, so two API replicas would both run them. If you need to scale out,
> split the background work back into its own process first — `startBackgroundWorkers()` in
> `apps/api/src/worker.ts` is the only seam required.

---

## First run

### 1. Database

Create an empty database and a dedicated user — not a superuser shared with anything else.

```bash
cd apps/api
npx prisma migrate deploy        # applies every committed migration in prisma/migrations/
npx tsx prisma/seed-catalog.ts   # 50 dataset types; idempotent, safe to re-run
```

`migrate deploy` needs an empty or already-migrated database. Use `migrate dev` only during schema
development — it also *generates* migrations.

### 2. Seed the catalogs

Two catalogs must exist or parts of the product render empty:

| Catalog | How | Symptom if missing |
|---|---|---|
| Dataset types (50) | `npx tsx prisma/seed-catalog.ts` | No pools can be created; the planner has nothing to offer. |
| Badges (20) | Applied by migration `20260831120000_seed_badge_catalog` | Badge pages sit empty forever; the auto-award engine has nothing to award. |

Both are idempotent, by different mechanisms: the badge migration inserts `ON CONFLICT ("key") DO NOTHING`,
and `seed-catalog.ts` upserts by id (seeding `complexityScore`/`verificationUnits` on create only, so it never
clobbers admin edits). If a badge catalog is empty on a migrated database — test cleanup can wipe it — re-apply
that migration's insert directly.

Verify:

```sql
SELECT (SELECT count(*) FROM dataset_types) AS types,
       (SELECT count(*) FROM badges)        AS badges;
-- expect 50 | 20
```

### 3. Configure

Work through [configuration.md](configuration.md). The short version of what actually blocks a real
deployment:

- **`DATABASE_URL`** — the only variable with no fallback.
- **Four secrets with dev fallbacks that ARE enforced at boot** in anything other than `development`/`test`:
  `SESSION_SECRET`, `ADMIN_SESSION_SECRET`, `POOL_SAMPLING_HMAC_SECRET`, `PROFILE_SOURCE_SECRET`. The
  process refuses to start if any is left at its dev default — but set real values anyway rather than
  relying on the guard as your only line of defense. `openssl rand -hex 32` each, all distinct.
- **`CORS_ORIGINS`** — every frontend origin you run, exact port. Miss one and its API calls are blocked
  by the browser with no server-side error.
- **SMTP** — mutations are gated on a verified email, and the verification link arrives by email. Without
  it, members can sign up and then do nothing. Set `EMAIL_FROM` to a domain you control.
- **HTTPS everywhere.** Session cookies are not safe over plain HTTP.
- **`TRUST_PROXY`** if you are behind a load balancer, or every client IP in your rate limits and audit
  log will be the proxy's.

Several misconfigurations are refused at boot in production rather than run dishonestly — the four secrets
above, `ADMIN_URL`/`APP_URL`/`LANDING_URL`/`PUBLIC_API_BASE_URL`/`MCP_PUBLIC_URL`/`CORS_ORIGINS` left unset
or at a localhost default, `EXECUTION_SANDBOX_ALLOW_EGRESS=true`, and
`EXECUTION_SANDBOX_VERIFY_ISOLATION=false`. See [configuration.md](configuration.md)'s full "Refused at
boot in production" table rather than treating this as the complete list.

### 4. First operator

Operator roles (`admin`, `member`, `support`) are **never self-assignable** — there is no "make me admin"
route. Grant the first one directly in the database, then use the console's invite flow
(`POST /v1/auth/accept-invite`) for everyone after.

### 5. Check it

```bash
curl http://localhost:4000/health
```

Then sign in to the admin console and open **System health** and **Execution health**. Those pages report
what is actually configured — including which optional integrations are not.

---

## What works when something is unconfigured

Optional integrations **fail closed and say so**. They never report a check as passed when it did not run.

| Unset | Behaviour |
|---|---|
| `E2B_API_KEY` | `execution` records `no_provider_configured` and routes to human review. |
| `OPENROUTER_API_KEY` | `llm` records outcome `no_provider_configured` (evidence detail `status: "pending_llm_review"`) and routes to human audit. (Also off by default as a runtime setting.) |
| `ARTIFACT_SCAN_URL` | Files are **not scanned**; recorded as not-performed, not as clean. |
| SMTP | Nothing sends. Members cannot verify, so they cannot claim a handle or submit. |
| Notification channel | Delivery dead-letters with the real reason. Never recorded as sent. |
| OAuth providers | Those credentials render as unavailable rather than failing on click. |

In a default deployment — no sandbox key, LLM off — **no automated stage can grant final acceptance**.
Every clean automated pass is resolved by a human. That is the intended posture, not a degraded one.

---

## Operating it

### Settings live in the database

29 runtime settings are edited in the console at `/settings` and read live — **no redeploy**. Each has a
schema that rejects invalid values, and a change history. Do not look for these in environment
variables; see [configuration.md](configuration.md#part-3--runtime-settings-admin_settings).

Worth setting deliberately before opening signups:

- `community.min_karma_to_request` — your anti-spam dial on dataset requests.
- `community.human_audit_window_size` (50–100) — validator batch size.
- `community.dispute_window_hours` — how long karma is held before it lands.
- `submissions.max_revisions` — attempts before final rejection.
- The `launch.*` switches — what is open at all.

### Scaling

- **API**: stateless, run several. Sessions live in Postgres.
- **Worker**: run several. Jobs are claimed with `FOR UPDATE SKIP LOCKED`, so workers do not collide.
- **Storage**: the local-directory driver is single-instance only — a second API cannot see the first's
  files. Use S3-compatible storage for more than one instance.
- **Postgres** is the shared state. Size it first.

### Backups

Postgres holds everything except uploaded files: submissions, validation evidence, karma ledger, audit
log, sessions, tokens. Back it up on a schedule and **test a restore** — an untested backup is a
hypothesis.

Object storage holds uploaded artifacts. Losing it loses submitted files while the rows that reference
them survive, so back it up too, or accept that gap knowingly.

The admin audit log is append-only with chain-integrity verification. A restore that silently drops rows
will show up there.

### Upgrading

1. Read the [changelog](../CHANGELOG.md).
2. Back up the database.
3. Deploy the new code.
4. `npx prisma migrate deploy`.
5. Re-run `seed-catalog.ts` — idempotent, and picks up new dataset types.
6. Restart API **and worker**.

Migrations are forward-only. There is no down-migration path, so the backup in step 2 is your rollback.

---

## When something looks broken

**Nothing progresses after submitting.** The worker is not running. Far and away the most common cause.

**A page loads but is empty, with no error.** `CORS_ORIGINS` does not list that frontend's exact origin
and port. The browser blocks the call before it leaves; there is nothing in the API log because the
request never arrived.

**Members sign up and then cannot do anything.** SMTP is unset, so verification never arrives, and
mutations are gated on a verified email.

**Badge pages are empty.** Badge catalog not seeded — see step 2.

**Admin console redirects to `/login` while signed in.** `ADMIN_URL` does not match the origin you are
actually serving the console from, so the session cookie is scoped wrong. Production refuses to start
with it unset, but a *wrong* value still starts.

**Everything is slow under load.** Check worker count, then Postgres. Job throughput is worker-bound;
read latency is database-bound.

**An execution verdict says `no_provider_configured`.** Working as intended — no sandbox key, so the
stage refused to guess and sent the item to a human.

---

## Security posture

What the software does for you:

- Passwords bcrypt-hashed; sessions are `HttpOnly` cookies with a separate secret for admin sessions.
- API keys stored as hashes, shown once, scoped, and revocable.
- Operator roles are never self-assignable.
- Conflict-of-interest blocking is server-side — a contributor cannot audit their own submission.
- File access is authorized per request; a validator can read evidence only while holding an active
  audit assignment.
- Append-only admin audit log with chain-integrity verification.
- Sandboxed execution defaults to no network egress, and production refuses to start with egress on.
- Handle reserved-list prevents claiming a name that would shadow a real route or impersonate the
  platform.

What is yours:

- Setting the six fallback secrets. **The process starts happily without them.**
- HTTPS, and a `TRUST_PROXY` that matches your topology.
- Database credentials and network isolation.
- Configuring malware scanning — unset means unscanned uploads from the internet.
- Keeping `apps/api/.env` out of version control (it is gitignored here; keep it that way in your fork).
- Meeting the licence terms if you redistribute your fork or ship images built from it. This software is
  under the [Apache License 2.0](../LICENSE): §4(d) requires you to carry the [`NOTICE`](../NOTICE) file
  through to your recipients, and §4(b) requires each file you modify to carry a notice that you changed
  it. Running it privately for your own users triggers neither.

To report a vulnerability, see [SECURITY.md](../SECURITY.md). Please do not open a public issue.
