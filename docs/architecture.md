# Architecture

Four independent Node processes, one Postgres database, and a background worker. They share no
in-process code and talk to each other only over HTTP, using URLs each is handed at build time.

```
                    ┌──────────────┐
   public visitor ──│ apps/landing │──┐
                    │    :3001     │  │
                    └──────────────┘  │
                    ┌──────────────┐  │   HTTP        ┌──────────────┐
   member ──────────│  apps/web    │──┼──────────────▶│  apps/api    │──▶ Postgres
                    │   :53000     │  │               │    :4000     │
                    └──────────────┘  │               └──────┬───────┘
                    ┌──────────────┐  │                      │ JobQueue table
   operator ────────│ apps/admin   │──┘                      ▼
                    │    :3002     │              ┌────────────────────┐
                    └──────────────┘              │ background work    │
                                                  │ (in the API process)│
   agent / MCP client ───────────────────────────▶│ 23 job types       │
                         :4000/mcp                └────────────────────┘
```

Ports shown are each app's `npm run dev` default.

## The four apps

| App | Stack | Responsibility |
|---|---|---|
| `apps/api` | Fastify · Prisma · Postgres | REST API, MCP server, validation pipeline, background worker. 37 route modules, ~73 services, and a Prisma schema of ~2,960 lines across 10 migrations. |
| `apps/web` | Next.js | The logged-in product. 28 pages: contributor workspace, sponsor requests, validator audit queue, karma, profile, developer/MCP setup. |
| `apps/admin` | Next.js | Operator console. 31 pages: request review, dataset-type and harness authoring, moderation, settings, health. |
| `apps/landing` | Next.js | Public site. 14 pages: pool catalog, public profiles at `/{handle}`, domains, changelog, legal. |

### Why there is no shared package

The apps genuinely share no code — verified: zero cross-app imports. There is no root `package.json`, no
npm workspace, and no monorepo build tool. Each app installs and builds from its own directory with its
own lockfile.

This is deliberate but unconventional (current practice favours a single root lockfile with `apps/` +
`packages/`), so it is called out in [CONTRIBUTING.md](../CONTRIBUTING.md) as the first thing a
newcomer needs to know: **`npm install` at the repository root does nothing.**

### How they find each other

Each frontend reads `NEXT_PUBLIC_API_URL` to reach the API, and `NEXT_PUBLIC_DASHBOARD_URL` /
`NEXT_PUBLIC_ADMIN_URL` / `NEXT_PUBLIC_LANDING_URL` to link to each other. The API reads `APP_URL` and
`ADMIN_URL` server-side to build links inside emails and notifications, and `CORS_ORIGINS` to decide
which frontend origins may call it.

`apps/web` is the public MCP gateway: it proxies `/mcp/*` and the OAuth discovery documents through to
the API. MCP clients use the web origin; `MCP_PUBLIC_URL` makes the API advertise that same origin.

## Identity: roles vs personas

This is the easiest thing to get wrong.

**Sponsor, contributor and validator are not roles.** They are personas derived from real work rows —
you are a sponsor because you own a dataset request, a validator because you hold an audit window.
Nothing grants them; they cannot be assigned or revoked. Those three values still exist in the `Role`
enum marked deprecated, granted to nobody and checked by nothing, so historical rows still parse.

The only real roles are three operator roles, none self-assignable:

| Role | Access |
|---|---|
| `admin` | Full admin console, including settings and security-sensitive routes. |
| `member` | Broad operational writes — review, moderate, decide. Not settings, not security. |
| `support` | Read-only, plus benign self-service actions. |

The admin console resolves its session **client-side** and redirects unauthenticated visitors to
`/login`. That redirect is UX only — the real boundary is `requireRole()` on every API call. Bypassing
the redirect yields a console shell that cannot fetch anything.

## The validation pipeline

Six stages, in a fixed order hardcoded in `services/validation.ts`. There is **no** per-dataset-type
pipeline array and no admin toggle for stage order — every stage runs on every submission. Each writes
an immutable `ValidationResult` row.

| Stage | What it does |
|---|---|
| `duplicate_check` | Exact-hash plus near-duplicate detection via MinHash + LSH banding (`SubmissionLshBand`), scoped per pool. Rejection is **per item** — one duplicate does not sink a batch. |
| `ai_attribution` | Deterministic, dependency-free scan for **explicit** model or co-author disclosures. Deliberately does *not* infer authorship from writing style, because general-purpose AI-text detectors are not reliable enough to base a penalty on. Neither sponsor nor admin can configure it in or out. |
| `execution` | Runs the item's own tests in a sandbox. With no sandbox key it records `no_provider_configured` and routes to human review — it never passes an item it could not run. |
| `llm` | Quality review against a rubric. Unconfigured it records `pending_llm_review` and routes to human audit. **Off by default**, so the honest path is the default path. |
| `pool_capacity` | Claims one of the pool's finite acceptance slots with a single atomic `UPDATE`, guarded against replay so a retried job cannot flip an already-accepted item to rejected. |
| `human_audit` | A person decides. |

> **In a default deployment no automated stage can grant final acceptance.** Contamination screening was
> removed and LLM review is off, so a clean automated pass lands on `accepted_pending_sample` — a
> non-terminal state — and a human resolves it.

External-corpus **contamination screening was deleted rather than left as a stub**. The old stage
reported "not attempted" for every input regardless, which is worse than no stage. Its
`contamination_check` status survives in the enum only because dropping an enum value is a migration
nobody has needed; no live row holds it.

## Pool lifecycle

There is **no claiming**. While a pool has room, any eligible member may submit. Higher karma tiers get
an early-access head start before a pool opens to everyone.

```
DatasetRequest ──admin approves──▶ Bounty (kind: community)  ← the pool
                                        │
              contributor submits ──────┤
                                        ▼
                            pipeline runs (as a job)
                                        │
                       ┌────────────────┴────────────────┐
                  clean pass                        failed / rejected
                       │                                 │
            accepted_pending_sample              slot released back
              (holds a slot, NOT terminal)
                       │
              pool target reached → close-out + sampling
                       │
        ┌──────────────┴──────────────┐
    sampled                      not sampled
        │                             │
   in_audit ──validator──▶ accepted   accepted
        │
   (or in_sponsor_review, when audit coverage is 0)
        │
        ▼
   karma awarded → held through dispute window → released
        │
        ▼
   DatasetPublication → export + push, with contributor attribution
```

`BountyKind` has exactly one value, `community`. There is no paid variant in the enum.

Validators claim a `HumanAuditWindow` of 50–100 items (admin-set, hard-bounded) **exclusively for 24
hours** (`CLAIM_SLA_MS`). Conflict-of-interest blocking guarantees none of their own submissions are in
the batch, and an abandoned claim auto-releases.

`SubmissionStatus` has **16 values**, two of which exist only for this model:
`accepted_pending_sample` (clean automated pass, pool still open) and `in_sponsor_review` (pools with
zero audit coverage, where the sponsor decides in place of a validator). One of the 16, `contamination_check`,
is a retired value no live row holds — so 15 are reachable. See the note on contamination screening above.

## The worker

Anything heavy runs as a job claimed from the `JobQueue` table. Jobs are idempotent, with a visibility
lease (a row whose worker dies mid-handler is reclaimed once the lease expires), exponential backoff,
bounded retries and a terminal dead-letter state.

**Concurrency limits.** A job is claimed with a `findFirst` followed by an optimistic guarded
`updateMany` — safe (two workers cannot claim the same row; the loser simply gets nothing) but not
`FOR UPDATE SKIP LOCKED`. Every worker races for the same oldest row, so a second process mostly idles
rather than adding throughput. The queue also has no fairness partitioning: `workspaceId` is written on
every job and nothing reads it, so one tenant's bulk upload occupies the claim slot until its backlog
drains. Run a single worker until these are addressed.

**23 job types:**

```
validation.run              pool.sampling            leaderboard.rank_check
artifact.scan               artifact.parse           artifact.preview
artifact.similarity_check   artifact.purge_expired_uploads
bulk_source.parse           sponsor_reference.review community.publish
profile_source.verify       benchmark.version_build  benchmark.run_evaluation
notifications.fanout_watchers                        waitlist.notify_domain_live
harness.proof_run           agent_issue.escalate     agent_issue.escalation_sweep
agent_issue.purge_expired   agent_issue.notify_filed
agent_issue.duplicate_candidates                     agent_issue.notify_canonical_outcome
```

**Time-based sweeps.** Not everything can be triggered by an event, so the worker also runs a small set
of periodic loops. Each writes a heartbeat, and `services/watchdog.ts` raises an alert when one stops
ticking:

| Sweep | Default cadence | What it does |
|---|---|---|
| `job-dispatch` | continuous poll | Drains the job queue itself. |
| `dispatch` / `digest` | 15 s / 60 s | Notification delivery and digest flushing. |
| `pool-reconcile-and-settle` | 10 min | Recounts open-pool capacity and settles pools that close after reaching their verified-item target. Community pools are open-ended and never close because time elapsed. |
| `artifact-sweeps` | 5 min | Expired upload purge, and re-arms format stages whose handler version moved on. |
| `agent-issue-sweeps` | 5 min | Aging escalation and retention. |
| `leaderboard-rank-sweep` | 10 min | Coalesced rank-movement checks. |
| `waitlist-notify-sweep` | 10 min | "Your domain is live" mail. |
| `profile-source-revalidation` | 10 min | Re-verifies connected credentials so a revoked grant stops crediting reputation. |
| `audit-reaper` / `karma-hold-release` | — | Expired audit claims and matured karma holds. |
| `watchdog` / `admin-metrics-snapshot` | — | Alerting and rolling metric snapshots. |

> **Background work runs inside the API process** — there is no separate worker to start or deploy.
> One process cannot be half-deployed, which rules out the failure mode of a queue that nothing drains.
>
> **The rule that comes with it:** run a single API instance. The job claim is safe under concurrency
> (a guarded compare-and-swap — two workers cannot take one row), but the sweeps above are not
> partitioned, so two instances would both run them. Split the worker back out before scaling
> horizontally; `startBackgroundWorkers()` in `apps/api/src/worker.ts` is the only seam needed.

## Notifications

Six channels: email, Telegram, Discord, Slack, Google Chat, Microsoft Teams.

A **transactional outbox** — the notification row is written inside the same transaction as the thing
that caused it, so an event cannot be lost to a crash between the two. A polling dispatch worker
delivers; a digest flusher batches. Idempotency is keyed on `(userId, eventKey)`, so a retried fan-out
does not double-notify.

An unconfigured channel **dead-letters with the actual reason**. It is never recorded as sent.

## Dataset types

50 checked-in type definitions under `apps/api/prisma/dataset-catalog/`, seeded idempotently. A type
declares its own field contract — keys, roles, which are files, what each accepts — and the submission
form is generated from it. That is how one form serves all 50 types.

Nothing is hardcoded to today's catalog or to JSON/CSV. Submission, preview, validation, similarity and
export go through a versioned format registry with per-type allowlists and pluggable parsers; unknown
types fail closed to quarantine or human review.

Admins author new types and harnesses in the console, so adding a type is data, not a deploy.

## Data model

~2,960 lines of Prisma across 10 migrations (counts as of this writing — the schema is under active
development, so treat them as a scale indicator, not a fixed fact; `npx prisma migrate status` is the
authority). The spine:

```
User → DatasetRequest → Bounty (pool) → Submission → ValidationResult
                                            │
                                            ├──▶ HumanAuditWindow → AuditItem
                                            ├──▶ KarmaEvent / PendingKarmaAward
                                            └──▶ Artifact
Bounty ──▶ DatasetPublication
```

Around it: OAuth and MCP token tables, sessions, API keys with rate buckets, artifacts with modality and
scan status, an LSH band table for near-duplicate lookup, LLM audit/cache/quota, notification channels
and deliveries, badges, benchmarks, agent issues, the job queue, and operational telemetry including
worker heartbeats and an append-only admin audit log with chain-integrity verification.

## Where to read next

- Wiring it up: [configuration.md](configuration.md)
- Running it: [self-hosting.md](self-hosting.md)
- Calling it: [api.md](api.md) · [mcp.md](mcp.md)
