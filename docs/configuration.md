# Configuration

Two separate systems configure DataBounty Community, and knowing which one you are looking at saves a
lot of confusion:

| | Where it lives | When it takes effect | Who changes it |
|---|---|---|---|
| **Environment variables** | `.env` per app, or the process environment | Process restart | Whoever deploys |
| **Runtime settings** | `admin_settings` table in Postgres | Next read — **no redeploy** | An `admin` in the console |

Anything about *how the platform behaves* — thresholds, window sizes, karma rates, feature switches — is
a runtime setting, not an environment variable. Environment variables are for wiring: where the database
is, which origins may call the API, which third-party keys exist.

---

## Part 1 — Environment variables (`apps/api`)

`apps/api/src/config.ts` reads **63** variables, and a further **32** are read elsewhere in
`apps/api/src` — in `worker.ts` (the sweep/dispatch intervals), `lib/prisma.ts`, `lib/session-cookie.ts`,
`lib/mcp-rate-limit.ts`, `lib/google-auth.ts` and `services/`. That is **95** in total, and the tables below
are the complete list: anything marked ✱ is **not** in `apps/api/.env.example`.

Two variables are deliberately outside `config.ts` rather than by accident, and both say so at the read
site: `MEMBER_ANALYTICS_ENABLED` is read at route-registration time so a test can flip it before
`buildApp()` without depending on module import order (`routes/v1/me.ts`), and the publication adapters
read their own credentials directly (`lib/publication/hugging-face.ts`, `github.ts`) to keep provider
config inside the provider.

`DATABASE_URL`, `DIRECT_URL` and `SHADOW_DATABASE_URL` are read by Prisma rather than `config.ts` — `DATABASE_URL` by the runtime
driver adapter in `lib/prisma.ts`, `DIRECT_URL` only by the Prisma CLI via `prisma.config.ts`.

`SMTP_SECURE` is read at `config.ts:227-229`: blank derives implicit TLS from the port (true only for
465), and an explicit `true`/`1` overrides it. It is listed under [Email](#email) below.

### Required

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string. Read by Prisma (`src/lib/prisma.ts`). Nothing starts without it. |
| `DIRECT_URL` ✱ | **Conditionally required.** Migration/CLI connection, read only by the Prisma CLI (`prisma.config.ts`, which prefers it and falls back to `DATABASE_URL`); the runtime never uses it. Unset is correct for local Postgres and the bundled compose database. **Required when `DATABASE_URL` is a transaction pooler** (Supabase port `6543`, `pgbouncer=true`): that pooler cannot hold the session-scoped advisory lock Prisma Migrate takes, and the failure mode is not an error — `prisma migrate` **hangs** with nothing useful in the log (observed: no output after 10 minutes). Point it at the session pooler (`5432`). |
| `SHADOW_DATABASE_URL` ✱ | unset | Optional, and only for AUTHORING a migration. `prisma migrate dev` creates and drops a temporary shadow database to detect drift; set this when the CLI role cannot `CREATE DATABASE` (a pooled managed-Postgres role). Read only by the Prisma CLI (`prisma.config.ts`). `prisma migrate deploy`, which is what deploys run, needs no shadow database. |

That is genuinely the only variable with no fallback. **Everything below has a default — including
several that must not keep their default in production.** Read the next section before deploying.

### Secrets that fall back to a development value

These have hardcoded dev defaults published in this repository. **In production the server now refuses
to start on every one of them** — see "Refused at boot in production" below. In development they keep
their fallback so a fresh clone runs with no configuration.

| Variable | Dev fallback | What an attacker does with the default |
|---|---|---|
| `SESSION_SECRET` | `dev_session_secret_databounty_community_32bytes_long` | Forges any member's session cookie. |
| `ADMIN_SESSION_SECRET` | `dev_admin_session_secret_databounty_community_32bytes` | Forges an **admin-console** session. |
| `POOL_SAMPLING_HMAC_SECRET` ✱ | `dev_pool_sampling_hmac_secret_databounty_community` | Predicts which items the human-audit sampler will select, so submissions can be timed to avoid review. |
| `PROFILE_SOURCE_SECRET` ✱ | `dev_profile_source_secret_databounty_community_32b` | Forges credential-verification state. |

Set all four secrets above to distinct high-entropy values — `openssl rand -hex 32`. A production
deployment missing any of them fails fast with a message naming the variable, instead of running with a
publicly known key and no symptom.

### Refused at boot in production

`NODE_ENV` is treated as production for anything **other than** `development` or `test` — not an allowlist
of specific production-sounding names. A misspelled or unlisted value (e.g. `staging`) still triggers every
guard below; only `development` and `test` are exempt. These throw on startup rather than running in a
state where a trust claim would be false, a secret would be publicly known, or a link mailed to a real user
would be unusable:

| Condition | Why it refuses |
|---|---|
| `SESSION_SECRET` at its dev default | Every member session cookie would be signed with a key published in this repository. |
| `ADMIN_SESSION_SECRET` at its dev default | Same, for admin-console sessions. |
| `POOL_SAMPLING_HMAC_SECRET` at its dev default | Human-audit sampling would be computable by anyone reading this repository, so a contributor could predict which submissions are never reviewed. |
| `PROFILE_SOURCE_SECRET` at its dev default | Credential-connect tokens forgeable and stored provider tokens decryptable. |
| `ADMIN_URL` unset | Would default to `localhost:3002` and misroute every admin-console request to the wrong session cookie. |
| `APP_URL` unset | Every verification, password-reset and admin-invite email would link to `http://localhost:3010`. The account is unrecoverable and there is no server-side symptom, because sending succeeds. |
| `LANDING_URL` unset | Waitlist and public-profile links in outbound email would point at `http://localhost:3001`. |
| `EXECUTION_SANDBOX_ALLOW_EGRESS=true` | Contributor code would run with unrestricted network egress. |
| `EXECUTION_SANDBOX_VERIFY_ISOLATION=false` | The sandbox's applied isolation would never be read back, so every "execution verified" verdict would be unfounded. |
| `E2B_API_KEY` is set but the E2B SDK or one of its dependencies cannot load | The process would otherwise look healthy at startup, but every queued execution would fail later. Startup instead refuses to boot. |

One further guard is environment-independent: the execution timeouts must be ordered
`inner worst case < command timeout < sandbox lifetime`, or startup fails.

**Mail is also fail-closed in production.** With `SMTP_HOST`/`SMTP_USER` unset, a development build falls
back to a stream transport that discards the message; in production that fallback throws instead. Silently
discarding a verification code or a password reset while returning success to the caller is not an
acceptable default.

### Server and networking

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4000` | |
| `HOST` ✱ | `0.0.0.0` | |
| `NODE_ENV` | — | Anything other than `development`/`test` enables the boot guards above — not just `production`/`prod`/`live`. |
| `LOG_LEVEL` ✱ | `info` | |
| `TRUST_PROXY` ✱ | unset | Set when behind a load balancer, or client IPs in rate limits and audit logs will all be the proxy's. |
| `BODY_LIMIT_BYTES` ✱ | `10485760` (10 MB) | Request body cap. Large files use the upload flow, not request bodies. |
| `CORS_ORIGINS` | `http://localhost:3000,http://localhost:3001,http://localhost:3002` | Comma-separated. **Must list every frontend origin you actually run, on the exact port.** Miss one and the browser blocks its API calls with no server-side error — the page just sits there empty. This is the single most common "it's broken" report. |
| `PUBLIC_API_BASE_URL` | `http://localhost:<PORT>` | Public origin of this API (no `/v1`). Builds the digest-unsubscribe link mailed to users and MCP artifact-upload URLs. Refused at boot in production while still the localhost default. |
| `MCP_PUBLIC_URL` | falls back to `APP_URL`, then `http://localhost:3010` | Public dashboard/MCP gateway origin (no path — `/mcp` is appended; a value ending in `/mcp` is normalised). Bound into every MCP OAuth credential as its audience and used for all advertised discovery/OAuth URLs. Refused at boot in production while still a localhost default. |
| `APP_URL` | `http://localhost:3010` | Dashboard origin. Used to build links in emails and notifications. |
| `LANDING_URL` | `http://localhost:3001` | The public landing app. Owns `/domains/:id`, `/pools` and public profiles — the waitlist "your domain is live" email links here, not to `APP_URL`, which has no `/domains` route. Refused at boot in production if unset. |
| `ADMIN_URL` | `http://localhost:3002` | Admin console origin. Required in production (above). |
| `COOKIE_DOMAIN` ✱ | unset | Cookie `Domain` attribute. Unset ⇒ host-only cookies, correct when every app is on one host. Set it to the shared parent domain (e.g. `.databounty.io`) when the dashboard, admin console and API are on different subdomains, or sessions will not be sent cross-subdomain. Read in `lib/session-cookie.ts`. |
| `COOKIE_SAMESITE` ✱ | `lax` | Cookie `SameSite` attribute. Leave at `lax` unless a cross-site flow genuinely needs `none` — and `none` requires HTTPS. Read in `lib/session-cookie.ts`. |
| `MCP_ALLOWED_ORIGINS` ✱ | `https://chatgpt.com,https://chat.openai.com,https://claude.ai` | Extra origins accepted on the MCP endpoint, beyond those derived from `MCP_PUBLIC_URL`/`APP_URL`. Comma-separated; setting the variable replaces this default list rather than adding to it. |
| `DB_POOL_MAX` ✱ | driver default | Max Postgres connections in the runtime pool (`lib/prisma.ts`). Lower it behind a session pooler, which multiplies connections per instance. |
| `DB_STATEMENT_TIMEOUT_MS` ✱ | unset | Server-side statement timeout applied to runtime queries (`lib/prisma.ts`). |

### Authentication

| Variable | Default | Notes |
|---|---|---|
| `SESSION_SECRET` | dev fallback | See the warning above. |
| `ADMIN_SESSION_SECRET` | dev fallback | Separate from the member secret on purpose — an admin session must not be derivable from a member one. |
| `GOOGLE_CLIENT_ID` ✱ | unset | Enables "Continue with Google". Email/password signup works without it. |
| `GOOGLE_TOKENINFO_URL` ✱ | `https://oauth2.googleapis.com/tokeninfo` | Google token-introspection endpoint. Override only to point at a test double. |
| `GOOGLE_AUTH_TIMEOUT_MS` ✱ | `5000` | Timeout for that introspection call. |

### Email

Email is **required for a usable deployment**: mutations are gated on a verified email address, and the
verification link is delivered by email. With SMTP unset, a new member can sign up but cannot verify,
and therefore cannot claim a handle or submit anything.

| Variable | Default | Notes |
|---|---|---|
| `SMTP_HOST` | unset | Unset ⇒ nothing sends. |
| `SMTP_PORT` | unset | |
| `SMTP_SECURE` | unset (derived) | Implicit TLS on connect (SMTPS). Blank derives it from the port — true only for `465`. Set `true`/`1` or `false` to state it explicitly. Read at `config.ts:227-229`. |
| `SMTP_USER` | unset | |
| `SMTP_PASS` | unset | |
| `EMAIL_FROM` | `noreply@databounty.io` | **Change this.** With most providers a sender you do not control will be rejected or spam-filed. |

### Object storage — uploaded files

| Variable | Default | Notes |
|---|---|---|
| `STORAGE_DRIVER` ✱ | unset (⇒ `local`) | `s3` for S3-compatible storage; anything else, including unset, selects the local-directory driver. Only `local` and `s3` exist — any other value throws at first use. |
| `STORAGE_LOCAL_DIR` ✱ | unset | Local driver only. **Not suitable for more than one API instance** — the second instance cannot see the first's files. |
| `STORAGE_BUCKET` ✱ | unset | |
| `STORAGE_REGION` ✱ | unset | |
| `STORAGE_ENDPOINT` ✱ | unset | Set for S3-compatible services that are not AWS (MinIO, R2, Spaces). |
| `AWS_ACCESS_KEY_ID` ✱ | unset | |
| `AWS_SECRET_ACCESS_KEY` ✱ | unset | |
| `AWS_SESSION_TOKEN` ✱ | unset | Temporary credentials only. |
| `STORAGE_MAX_UPLOAD_BYTES` ✱ | `104857600` (100 MB) | Single-request upload cap. |
| `STORAGE_MULTIPART_THRESHOLD_BYTES` ✱ | `104857600` (100 MB) | Above this, uploads go multipart. |
| `STORAGE_MULTIPART_PART_SIZE_BYTES` ✱ | `16777216` (16 MB) | |
| `STORAGE_MAX_MULTIPART_UPLOAD_BYTES` ✱ | `5368709120` (5 GB) | |
| `STORAGE_REQUEST_TIMEOUT_MS` ✱ | `15000` | |
| `STORAGE_DIRECT_UPLOAD_EXPIRES_SECONDS` ✱ | `900` (15 min) | Lifetime of a browser-upload target issued by `/v1/artifacts/upload-slot`. Shorter is safer; too short and a slow connection cannot finish a large part. |
| `STORAGE_MAX_PENDING_UPLOADS_PER_USER` ✱ | `20` | Cap on simultaneously pending (created but not completed) artifacts per member. Stops one account from reserving unbounded upload slots. |

### Malware scanning

| Variable | Default | Notes |
|---|---|---|
| `ARTIFACT_SCAN_URL` ✱ | unset | Scanner endpoint. |
| `ARTIFACT_SCAN_TOKEN` ✱ | unset | |
| `ARTIFACT_SCAN_TIMEOUT_MS` ✱ | `15000` | |

Unset means uploads are **not** scanned. The scan status is recorded as not-performed rather than
presented as clean — but you are accepting unscanned files from the internet, so configure it.

Scanning is additionally gated by the database setting `artifacts.malware_scan.enabled` (off by default), read
directly by `src/services/artifact-scanner.ts`. That key is **not** in the validated settings catalog below and
has no admin route or console UI, so it can currently only be enabled by writing the `admin_settings` row
directly. Documented gap.

### Execution sandbox

The sandbox runs contributed code. Without a key, the execution stage records
`no_provider_configured` and routes the submission to human review — it never passes an item it could
not actually run.

| Variable | Default | Notes |
|---|---|---|
| `E2B_API_KEY` | `""` | Unset ⇒ execution stage fails closed as above. |
| `E2B_TEMPLATE` | `""` | Sandbox template id. |
| `EXECUTION_RUNNER_TIMEOUT_MS` ✱ | `120000` | |
| `EXECUTION_SANDBOX_ALLOW_EGRESS` ✱ | `false` | `true` is refused in production. |
| `EXECUTION_SANDBOX_EGRESS_ALLOWLIST` ✱ | unset | Only meaningful with egress enabled. |
| `EXECUTION_SANDBOX_VERIFY_ISOLATION` ✱ | `true` | `false` is refused in production. |
| `EXECUTION_SANDBOX_MAX_CPUS` ✱ | `2` | |
| `EXECUTION_SANDBOX_MAX_MEMORY_MB` ✱ | `4096` | |
| `EXECUTION_SANDBOX_MAX_FILE_SIZE_MB` ✱ | `256` | |
| `EXECUTION_SANDBOX_MAX_PROCESSES` ✱ | `256` | |
| `EXECUTION_SANDBOX_MAX_OPEN_FILES` ✱ | `1024` | |
| `EXECUTION_SANDBOX_ORDER` ✱ | `e2b` | Comma-separated provider order tried per run (`services/execution-providers/provider-order.ts`). An unknown or duplicated name is rejected at boot rather than silently skipped. Only `e2b` is registered in this rebuild. |

### LLM review

| Variable | Default | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | unset | Unset ⇒ the LLM stage records outcome `no_provider_configured` with `status: "pending_llm_review"` in its evidence detail, and routes to human audit. It never auto-accepts. The stage is also **off by default** as a runtime setting, so the honest path is the default path. |
| `ANTHROPIC_API_KEY` ✱ | unset | Enables the `anthropic` provider in the multi-provider LLM layer (`services/llm/config.ts`, `providerKey()`). Unset ⇒ that provider is simply not selectable; it never degrades into a fabricated review. |
| `OPENAI_API_KEY` ✱ | unset | Enables the `openai` provider in the same layer, same terms. |

### Credential verification (OAuth)

| Variable | Default | Notes |
|---|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | unset | |
| `GITHUB_OAUTH_CLIENT_SECRET` | unset | |
| `ORCID_OAUTH_CLIENT_ID` | unset | |
| `ORCID_OAUTH_CLIENT_SECRET` | unset | |
| `ORCID_API_BASE_URL` ✱ | `https://orcid.org` | Point at the sandbox host for testing. |

Unset providers render as unavailable in the UI rather than failing when clicked. LinkedIn, Google
Scholar, Kaggle, X and Website are shown as unavailable by design — no verification is implemented.

### Notification channels

| Variable | Default | Notes |
|---|---|---|
| `SLACK_CLIENT_ID` | unset | Slack needs an OAuth app. |
| `SLACK_CLIENT_SECRET` | unset | |
| `TELEGRAM_BOT_TOKEN` | unset | |
| `TELEGRAM_BOT_USERNAME` | unset | |

Discord, Google Chat and Microsoft Teams are webhook-based — the member pastes a webhook URL, so they
need no server configuration. An unconfigured channel **dead-letters with the real reason** and is never
recorded as sent.

### Dataset publication

A published community dataset is pushed to **every configured target**. Both targets receive the same
`data/items.jsonl` and `manifest.json` **bytes** — so the two publications are verifiably the same
dataset — and differ only in the repository furniture each host reads. The public training split contains
contributor submissions only: sponsor reference examples remain review evidence and are never exported as
rows. If a legacy or concurrent close-out leaves more accepted submissions than the approved
`Bounty.targetItems`, publication deterministically exports only the oldest `targetItems` rows and records
an audit event for the cap.

| Variable | Default | Notes |
|---|---|---|
| `HUGGINGFACE_API_TOKEN` | unset | Write token. Without it the Hugging Face target records `not_configured`. |
| `HUGGINGFACE_NAMESPACE` | unset | User or org datasets are created under. |
| `HUGGINGFACE_API_URL` | `https://huggingface.co/api` | Override for a self-hosted Hub. |
| `GITHUB_PUBLICATION_TOKEN` | unset | **A dedicated credential, never the account token used by `gh`** — `contents:write` scoped to just the one shared datasets repo below is enough. |
| `GITHUB_PUBLICATION_OWNER` | unset | Org or user that owns the shared datasets repo. |
| `GITHUB_PUBLICATION_REPO` | `databounty-datasets` | The **one shared repo** every dataset publishes into, as its own folder (`datasets/<slug>/`) — not one repo per dataset. |
| `GITHUB_PUBLICATION_API_URL` | `https://api.github.com` | Set for GitHub Enterprise. |
| `GITHUB_PUBLICATION_BRANCH_PROTECTED` | unset (`false`) | When `true`, publish and unpublish push through a branch + pull request + merge instead of committing straight to `main`: create a branch from the built commit, open a PR (head: that branch, base: `main`), merge it via the API, then best-effort delete the branch. Default/unset keeps today's direct-push-to-`main` behavior unchanged. Turn this on only after the shared `databounty-datasets` repo actually has branch protection requiring PRs on `main` — setting this var does not itself enable that protection, request any GitHub permissions, or change the repo's settings; that is a separate owner action. |
| `PUBLICATION_REQUEST_TIMEOUT_MS` | `10000` | Shared by both targets. |
| `PUBLICATION_UPLOAD_TIMEOUT_MS` | `300000` | Per-file upload timeout. |

**What lands in each repo**

| File | Hugging Face | GitHub |
|---|---|---|
| `data/items.jsonl` | ✅ | ✅ identical bytes |
| `manifest.json` | ✅ | ✅ identical bytes |
| `data/contributor-items/…` | ✅ | ✅ identical bytes |
| `README.md` | dataset card with the Hub's YAML front matter (`license:`, `configs:`, `size_categories:`) | plain README — front matter would be meaningless noise on GitHub |
| `LICENSE` | — (the Hub reads the front-matter `license:` tag) | ✅ full verbatim licence text |
| `.gitattributes` | — | ✅ marks the JSONL generated, so it is collapsed in diffs and excluded from the language bar |

`LICENSE` carries the **full text**, not a pointer, because GitHub identifies a repository's licence by
matching that file against known texts — a repo naming its licence only in prose reads as *all rights
reserved*, the opposite of what an open dataset intends. Texts are bundled for `CC-BY-4.0`,
`CC-BY-SA-4.0`, `CC0-1.0` and `ODC-By-1.0` (the four a bounty can select). Any other licence value
means `LICENSE` is **omitted rather than guessed**, and the README says the full text is not bundled.

**Contributor uploads are published.** A `role: "file"` field holds an artifact id; the bytes behind it
are pushed to `data/contributor-items/<submissionId>/<fieldKey>-<artifactId>-<filename>`, and the item's
field value in `items.jsonl` is **rewritten to that path**, so an item and the file it names always
agree. Only `ready` artifacts of kind `submission_attachment` are eligible.

One publish run buffers each file in memory before pushing, so a **cumulative 200 MB cap** bounds the
job. The cap is applied to the artifact's *verified stored size* before a single byte is read. Going
over it is deliberately **not fatal** — a partial dataset with an accurate manifest beats blocking the
whole publish — but it is never silent: `manifest.json` carries
`attachments: { resolved, published }`, both READMEs print a *Partial upload set* notice, and an
audit-log row (`community_publication.attachments_truncated`) records the counts and the cap. An item
whose file was skipped **keeps its raw artifact id** rather than a path to a file that is not there.

**A GitHub-specific limit.** Git LFS is out of scope, so a single file at or over GitHub's 100 MB API
limit fails that publish **permanently**, naming the file, rather than being dropped from the commit.
The 200 MB cumulative cap does not prevent this — one 120 MB upload is under the cap but over GitHub's
per-file ceiling, and would publish to Hugging Face and fail on GitHub. Hugging Face stays the primary
target for datasets with large files.

**Withdrawal (retract) never deletes.** The admin `retract` action enqueues a `community.unpublish` job
that calls each provider's own withdrawal: Hugging Face and GitHub are both flipped to **private**, so
the commits and the contributor provenance in them survive, only public reachability is removed, and the
retraction stays reversible. A 404 counts as success — the dataset is already unreachable, which is the
state the call exists to guarantee.

A target is recorded `retracted` **only after its provider confirms**. If the withdrawal cannot be
performed — no credential, no recorded repo id, a provider error — the row stays `published`, because
the dataset really is still public, and the reason is written to `lastError` and to the audit log
(`community_publication.retract_failed`). The bounty-level status becomes `retracted` only when *every*
previously-published target actually withdrew; a partial withdrawal never displays as a complete one.
Retract is **not** gated on the `community.publish.enabled` kill switch — turning publishing off must
never prevent taking something down.

### Rate limits

Per-instance, in-memory counters unless noted. Behind more than one API instance the effective limit is
the value below multiplied by the instance count — size them accordingly, and set `TRUST_PROXY` or every
request will share one bucket keyed on the load balancer's address.

| Variable | Default | Notes |
|---|---|---|
| `RATELIMIT_GLOBAL_MAX` ✱ | plugin default | Global per-IP request ceiling, read in `app.ts`. |
| `MCP_RATE_LIMIT_PER_MIN` ✱ | `300` | Per-credential MCP calls per minute. Backed by the `api_key_rate_buckets` table, so this one **is** shared across instances (`lib/mcp-rate-limit.ts`). |
| `API_KEY_RATE_LIMIT_PER_MIN` ✱ | `300` | Fallback for the above when `MCP_RATE_LIMIT_PER_MIN` is unset. |

### Background workers and sweeps

Read in `worker.ts` (and `services/worker-heartbeat.ts`, `services/notifications.ts`) rather than
`config.ts`. All are milliseconds, all have working defaults, and none needs setting for a normal
deployment — they exist to slow a sweep down on a small instance or speed one up while debugging.
Every value is a *tick interval*, not a deadline: shortening one does not make the underlying window
shorter, it only checks more often.

| Variable | Default | Sweeps |
|---|---|---|
| `WORKER_POLL_INTERVAL_MS` ✱ | `2000` | Job-queue claim loop. |
| `WORKER_TICK_TIMEOUT_MS` ✱ | — | Per-tick watchdog budget; a tick exceeding it is reported unhealthy (`services/worker-heartbeat.ts`). |
| `WATCHDOG_INTERVAL_MS` ✱ | `60000` | Stuck-submission detection. |
| `NOTIFICATIONS_DISPATCH_INTERVAL_MS` ✱ | `15000` | Outbox dispatch. |
| `NOTIFICATIONS_DISPATCH_LIMIT` ✱ | `250` | Rows claimed per dispatch pass (`services/notifications.ts`). |
| `NOTIFICATIONS_DISPATCH_CONCURRENCY` ✱ | `16` | Parallel sends per pass (`services/notifications.ts`). |
| `NOTIFICATIONS_DIGEST_INTERVAL_MS` ✱ | `300000` | Digest flush. |
| `AUDIT_REAPER_INTERVAL_MS` ✱ | `300000` | Returns expired audit claims to the queue. |
| `KARMA_HOLD_RELEASE_INTERVAL_MS` ✱ | `300000` | Releases karma past its hold window. |
| `POOL_RECONCILE_INTERVAL_MS` | `600000` | Recounts open-pool capacity and settles pools closed after reaching their verified-item target. Community pools are open-ended; time does not close them. |
| `ARTIFACT_SWEEP_INTERVAL_MS` ✱ | `300000` | Expires abandoned pending uploads. |
| `AGENT_ISSUE_SWEEP_INTERVAL_MS` ✱ | `300000` | Agent-reported issue housekeeping. |
| `LEADERBOARD_SWEEP_INTERVAL_MS` ✱ | `600000` | Leaderboard rank/movement snapshot. |
| `WAITLIST_SWEEP_INTERVAL_MS` ✱ | `600000` | Domain-waitlist notification sweep. |
| `PROFILE_SOURCE_SWEEP_INTERVAL_MS` ✱ | `600000` | Expires stale credential-connect state tokens. |
| `MCP_OAUTH_CLEANUP_INTERVAL_MS` ✱ | `300000` | Deletes expired MCP OAuth grants/codes. |
| `ADMIN_METRICS_SNAPSHOT_INTERVAL_MS` ✱ | `300000` | Admin overview metric snapshot. |

### Tooling only

| Variable | Default | Notes |
|---|---|---|
| `DATABOUNTY_API_KEY` ✱ | unset | Read by the stdio MCP entrypoint (`src/mcp/stdio.ts`) to authenticate as a member. This is a **client-side** variable for whoever runs the stdio server — it is not part of the API server's own configuration, and setting it on the API process does nothing. |

---

## Part 2 — Frontend environment variables

The three Next.js apps read only public values. Anything named `NEXT_PUBLIC_*` is **compiled into the
browser bundle** — never put a secret in one.

| Variable | Needed by | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | web, admin, landing | Where `apps/api` is. |
| `NEXT_PUBLIC_DASHBOARD_URL` | web, admin, landing | Cross-links, e.g. landing's "sign in". |
| `NEXT_PUBLIC_ADMIN_URL` | web, admin | |
| `NEXT_PUBLIC_LANDING_URL` | web, admin, landing | Also the host in public-profile URLs. |
| `NEXT_OUTPUT` | any | `standalone` for a self-contained server bundle; `export` (web and admin only) for a static `out/`. |

Every origin you set here must also appear in the API's `CORS_ORIGINS`.

---

## Part 3 — Runtime settings (`admin_settings`)

**29 settings**, each with a schema that rejects invalid values instead of accepting them silently, and a
full change history. Edited in the admin console at `/settings`, read live — no redeploy.

Values are read on demand, so a change takes effect on the next check. Anything already in flight
finishes under the value it started with.

### Community pools and audit

| Key | What it controls |
|---|---|
| `community.dispute_window_hours` | How long a contributor has to dispute a rejection before it is final. |
| `community.karma_holds.enabled` | Whether accepted-item karma is held through the dispute window instead of released immediately. |
| `community.human_audit_window_size` | Items per human-audit window — the batch a validator claims. Bounded **50–100**. |
| `community.human_audit_failure_threshold_pct` | Percent of a window's selected items that must be rejected for the whole window to fail. |
| `community.min_karma_to_request` | Minimum karma before a member may file a dataset request. Your anti-spam dial. |
| `community.leaderboard.page_size` | Default leaderboard page size. |
| `community.leaderboard.max_page_size` | Hard ceiling on one leaderboard request. |

### Validation

| Key | What it controls |
|---|---|
| `validation.dedupe.reject_threshold` | Duplicate score at or above which `duplicate_check` rejects. |
| `validation.llm.enabled` | The LLM review stage platform-wide. **Off by default** — deterministic checks first. |
| `submissions.max_revisions` | Revision attempts before final rejection. |

### Karma and reputation

| Key | What it controls |
|---|---|
| `karma.tiers` | The tier ladder — id, label, karma threshold, accent colour, perks, early-access hours. |
| `karma.rules` | Flat award rates: per accepted item by difficulty, per audited item, and so on. |
| `karma.matrix` | Per-dataset-type karma rate inputs, keyed on registry id. |
| `reputation.score.base` | Starting reputation score. |
| `reputation.score.per_verified_credential` | Points per verified credential, up to a 100-point cap. |

> The karma tiers shipped in code are `0 / 5 / 50 / 500`. A deployment that has written `karma.tiers`
> uses **its stored value**, which may differ by orders of magnitude. The code values are defaults, not
> the tiers — check the console before quoting a threshold to anyone.

### Notifications

| Key | What it controls |
|---|---|
| `notifications.digest.enabled` | Whether the periodic digest is sent at all. |
| `notifications.digest.time` | Local `HH:mm` the daily digest is flushed. |
| `notifications.digest.timezone` | IANA zone the time above is read in. |
| `notifications.delivery.max_attempts` | Retries before a delivery is parked in the dead-letter state. |
| `notifications.delivery.lease_seconds` | How long a dispatch worker holds an exclusive lease. |
| `notifications.delivery.backoff_seconds` | Retry backoff ladder; the last entry repeats. |

### Feature switches

| Key | What it controls |
|---|---|
| `launch.community.enabled` | Master switch for community karma activity. |
| `launch.community_requests.enabled` | Authenticated dataset-request submission. |
| `launch.dashboard_submissions.enabled` | Submitting items from the dashboard UI. |
| `launch.api_submissions.enabled` | Submitting items via a direct API-key call. |
| `launch.public_profiles.enabled` | Anonymous public-profile reads. Disabled returns the same not-found response as a missing profile. |

### Auth and limits

| Key | What it controls |
|---|---|
| `auth.email_verification.ttl_hours` | How long a verification link stays valid. |
| `ratelimit.global.max` | Requests per window before `429`. |
| `ratelimit.global.window_seconds` | Window length. |

Some routes carry their own tighter limits on top of the global one — see [api.md](api.md).
