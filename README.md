<div align="center">

# DataBounty Community

**An open-source, karma-based platform for creating, validating, and publishing datasets.**

[Docs](docs/README.md) · [Deployment](DEPLOYMENT.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Support](SUPPORT.md) · [Changelog](CHANGELOG.md) · [License](#license)

</div>

---

DataBounty Community is a self-hostable platform where sponsors request datasets, contributors create items,
automated checks validate each submission, and human validators review the results. Accepted contributions earn
karma — a permanent, public, portable record of dataset work, with contributor attribution that follows the
data to publication.

## Karma

Karma is the reward. It is a permanent, public record of dataset work you actually got accepted —
earned per item, verified before it counts, and attached to your name wherever the dataset goes.

**It is earned for work that passed review.** Karma lands when an item clears the validation pipeline
*and* a human validator accepts it — so every point in your balance stands for accepted work, and the
amount scales with how hard the item was. Defaults, all operator-editable:

| Action | Karma |
|---|---|
| Accepted item — beginner / intermediate / advanced | **10 / 25 / 60** |
| Recording an audit decision as a validator | **8** |
| A flag you raised, confirmed by review | **25** |
| A dataset request of yours approved into an open pool | **25** |
| Contributing to a pool that reaches publication | **150** |

**Once it lands, it stays.** An award is held while the sponsor's review window is open (48 hours by
default) and released cleanly on the other side, so your profile and the leaderboard only ever move
forward — a resolved dispute simply means the hold was never released, with no claw-back to explain.
Releases are idempotent and every reversal is recorded, so the trail behind your balance stays whole.

**What it gets you.** Standing is public and your credit is permanent:

| Tier | Karma from |
|---|---|
| **Dharma** | 0 |
| **Bodhi** | 5,000 |
| **Moksha** | 50,000 |
| **Nirvana** | 500,000 |

Every tier is shown as a badge on your public profile and on the karma leaderboard, and your tier plus
your distance to the next one is served over the API — so progress is visible, not implied.

The credit is the part that does real work. When a pool publishes, `buildContributorCredits` walks the
**accepted** submissions, takes one entry per contributor, and writes them into both a machine-readable
`manifest.json` provenance sidecar and rendered credit lines in the dataset's published README. Opting out
is honoured — an opt-out or a missing handle is counted as anonymized rather than named — so nobody is
credited who did not choose to be.

> **Next up — early access and higher claim limits.** The tier config already carries
> `earlyAccessHours` (24h / 48h / 72h) and a `concurrencyBonus` (+1 / +2 / +3); both are validated,
> stored, and served to clients, and the enforcement gate is the remaining step — so treat these as
> roadmap rather than live today. Validator capacity *is* live now, managed by the validator-rank
> system (`maxConcurrentAudits`).

**Your record travels with you.** Attribution follows the data: accepted contributions carry your name
onto the published dataset, and your public profile at `/<handle>` gathers your tier, badges, and the
pools you worked on into a citable history of real dataset work you can point anyone to.

Tiers, thresholds, per-action rates, and the difficulty matrix all live in the database
(`karma.tiers`, `karma.rules`, `karma.matrix`) and are editable by the operator without a redeploy —
the numbers above are this project's defaults, not hardcoded law.

## Maturity

Every row here was read out of the code, and the proof column names exactly what you can run to confirm
it. We list what you can rely on today, what unlocks when you add a key, and where we have drawn the
scope line — so you can plan with confidence from the first read.

### Works today

| Module | What you actually get | Proof |
|---|---|---|
| **Human audit** | Validators claim one item at a time, exclusively. Conflict-of-interest is checked, unclaimed work returns to the queue automatically, and pools close on their deadline so karma reaches contributors on schedule. **This is the acceptance gate that counts: every item clearing execution reaches a human, whatever the automated stages reported.** | `pendingHumanReview` is unconditionally true in `services/validation.ts`; 33 tests across `audit-claim`, `audit-routing`, `pool-lifecycle.{deadline-close,window-size,acceptance-race}`, `me-audits` |
| **Duplicate detection** | Exact-hash and near-duplicate (MinHash/LSH) checks on every submission, scoped per pool. No external service, no API key, always runs. | `services/dedup-lsh.ts` · 7 unit tests + `pipeline.integration.test.ts` |
| **Karma** | Awards per accepted item, hold and release states, tiers and badges read live from the database, public contributor profiles, and attribution that survives publication. | `services/{karma,karma-holds,badges,reputation}.ts` · 14 tests across `karma-badges-attribution`, `badges-live-sync`, `karma-tier-live-config` |
| **Sponsor requests → open pools** | A sponsor answers a deterministic, database-driven planner; an operator reviews the request before any pool exists. No LLM in this path — the questions and options are admin-authored. | `services/planner.ts` · `routes/v1/planner.integration.test.ts` (10 tests) · `admin-community-implement.integration.test.ts` |
| **Public discovery** | Dataset catalog, domains, delivered datasets, karma leaderboard, public profiles, and schema-driven contribution forms — 14 server-rendered routes. | `apps/landing/app/(site)/**` |
| **MCP server** | 45 tools over JSON-RPC, OAuth 2.1 + PKCE **and** API-key auth, per-credential rate limits. Point an agent at it. | `src/mcp/tools.ts` (45 tools) · tests across `transport.integration`, `tools.audit-claim`, `tools.upload-url`, `tools.v1-parity.integration` |
| **Notifications** | Transactional outbox with in-process dispatch, digests, and one-click unsubscribe. Six delivery channels: email, Telegram, Slack, Discord, Google Chat, Microsoft Teams. In production, mail delivery is confirmed rather than assumed, so a notification you sent is a notification that went out. | `services/notification-channels.ts` · 34 tests across `notifications-wiring`, `alerts`, `email-template`, `digest-unsubscribe-token`, `telegram.*` |
| **Operator configuration** | 30 runtime settings live in the database and take effect without a restart — validation policy, revision limits, thresholds, dataset types, and execution harnesses are all authored in the admin app, not in code. | `services/admin-settings.ts` (30 keys) · `admin-settings.unit.test.ts` · `admin-dataset-types.integration.test.ts` (10 tests) |
| **Uploads and storage** | Local-disk and S3 multipart drivers behind one contract. Six format handlers — image, video, audio, document, archive, and code/text — each naming exactly what it supports, so you always know which files a pool can take. | `lib/storage/**` · `services/format-registry/**` · 48 tests incl. `handlers.unit` (23) and `local.contract` (7) |
| **Self-hosting** | Four Dockerfiles and a Compose stack that goes from empty Postgres to serving traffic. One init migration, one idempotent catalog seed. | `docker-compose.yml` · CI proves clean-clone `npm ci`, typecheck, build, and Docker image for all four apps |

### Ready when you are — add a key, and these come online

These are built and tested. Each one waits on a credential or a boundary that is yours to set.

| Module | How it behaves |
|---|---|
| **Sandboxed execution** | Genuinely isolated — submitted tests never run in the API process. Add an `E2B_API_KEY` and every submission gets a real verdict from a real sandbox. Until you do, the pipeline stays truthful: the evidence row reads `no_provider_configured` and the item goes to a human validator, so you always know precisely what was verified. |
| **LLM quality review** | An advisory second opinion, on your terms. Add an `OPENROUTER_API_KEY` and switch it on to get a scored review alongside every submission. It stays advisory by design — the human validator always makes the call — and when it is off it records nothing at all, so no score ever appears that a model did not produce. |
| **Dataset publication** | Ships to Hugging Face (primary, with Git LFS) and mirrors to GitHub if you want it. A destination is marked published only once the provider confirms it, so the status you see is the status that is true. Today's export bundle carries JSONL payloads; file-role attachment bytes are on the way, and GitHub takes files below its 100 MiB API limit. |
| **Background work** | 13 loops run inside the API process, so there is one service to deploy and the queue is already draining when the first request arrives. Run a single API instance: the job claim is concurrency-safe, and keeping the scheduled sweeps on one node is what makes them exact. |

<a id="whats-not-included"></a>

### Where we draw the line

A focused platform is a dependable one. These are settled scope decisions, so you always know what a
green check on this platform does and does not stand for.

- **Verification is what our pipeline can prove itself.** External-corpus contamination and plagiarism screening sit outside that line, so there is no `contamination` stage — and deliberately no placeholder standing in for one. Every stage you see in the evidence timeline is a stage that genuinely ran.
- **Malware scanning is yours to plug in.** Point `artifacts.malware_scan.enabled` at your own scanner endpoint and it runs on every artifact. With none configured the record reads `not_required` and says so plainly, so a scan is only ever reported when a scanner actually did the work.

## Applications

| Application | Purpose |
|---|---|
| `apps/api` | Fastify REST and MCP API, Prisma/PostgreSQL persistence, validation, publication, notifications, and background jobs |
| `apps/web` | Signed-in sponsor, contributor, and validator workspace |
| `apps/admin` | Operator review, moderation, dataset-type authoring, configuration, health, and audit views |
| `apps/landing` | Public site, dataset catalog at `/pools`, Karma at `/open`, and public profiles |

The frontends communicate with the API over HTTP. There is one Prisma schema in `apps/api`; the frontends do not
connect directly to the database.

## Getting started

### Prerequisites

- Node.js 20.19 or newer
- PostgreSQL
- npm
- Docker and Docker Compose (optional)

Each application has its own `package.json` and lockfile. Start the API first, then whichever frontend applications
you need.

### API

```bash
cd apps/api
npm install
cp .env.example .env
npx prisma generate
npx prisma migrate deploy
npx tsx prisma/seed-catalog.ts
npm run dev
```

Set `DATABASE_URL` before applying migrations. `npx prisma generate` is a required step, not an optional one:
`npm install` does not generate the Prisma client for you, and `prisma migrate deploy` does not either, so
skipping it makes the typecheck, build, and dev server fail on a missing client. CI runs the same three commands
in the same order (`prisma generate`, `prisma migrate deploy`, `tsx prisma/seed-catalog.ts`) before it typechecks,
builds, or tests. The catalog seed is idempotent and safe to rerun. Background jobs run inside the API process;
there is no separate worker command.

### Web, admin, and landing

Run the same setup from each required application directory:

```bash
cd apps/web # or apps/admin, apps/landing
npm install
cp .env.example .env
npm run dev
```

Configure the frontend API URL and the API's allowed origins for the addresses you use. The complete, maintained
configuration reference is [docs/configuration.md](docs/configuration.md).

For a container-based local environment, deployment checks, and production prerequisites, see
[DEPLOYMENT.md](DEPLOYMENT.md). For first-run operations, backups, upgrades, and troubleshooting, see
[docs/self-hosting.md](docs/self-hosting.md).

## Dataset publication

Approved datasets can publish asynchronously to enabled and configured destinations:

- **Hugging Face** is the primary target and uses Git LFS for larger files.
- **GitHub** is an optional mirror that creates one repository per dataset under the configured publication owner.

A destination is recorded as published only after the provider confirms it. Failed, pending, withdrawn, or
unconfigured destinations keep their precise state; they are never presented as successful.

The current export bundle contains JSONL payloads. File-role attachment bytes are not yet included, and GitHub
publication does not support files at or above its 100 MiB API limit. Both destinations
are configured by environment variable (`HUGGINGFACE_API_TOKEN` / `HUGGINGFACE_NAMESPACE`,
`GITHUB_PUBLICATION_TOKEN` / `GITHUB_PUBLICATION_OWNER`). Full write-ups are landing in
[docs/configuration.md](docs/configuration.md) shortly; `apps/api/src/config.ts` declares each one with its
default in the meantime. Use a credential dedicated to publication so the token's reach matches its job.

## Testing

The four applications do not define the same scripts, so the commands differ by application. All four have
`typecheck` and `build`; only `apps/api` has `test`; only the three frontends have `lint`.

In `apps/api`:

```bash
cd apps/api
npm run typecheck
npm run build
npm test          # vitest, serialized — needs a real PostgreSQL database
```

In each frontend (`apps/web`, `apps/admin`, `apps/landing`):

```bash
cd apps/web       # or apps/admin, apps/landing
npm run typecheck
npm run lint
npm run build
```

There is deliberately no `npm test` in the frontends — running it there fails with a missing-script error rather
than testing anything. Browser verification covers them instead.

API tests need the Prisma client generated and migrations applied first (see [API](#api) above). API integration
tests also require the disposable database name documented in [CONTRIBUTING.md](CONTRIBUTING.md); never point them
at a database you care about. Browser tests and additional verification commands are documented there too.

## Contributing and support

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Contributor credit is recorded through Git
history, merged pull requests, release notes, and [CONTRIBUTORS.md](CONTRIBUTORS.md).

- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- Use [SUPPORT.md](SUPPORT.md) for setup and usage help.
- Use the repository issue templates for reproducible bugs and focused feature proposals.

Contributions use the [Developer Certificate of Origin](https://developercertificate.org/) sign-off process.

## License

This project is licensed under the [Apache License 2.0](LICENSE).

[X]CUBE LABS PTE. LTD. owns the original DataBounty codebase. Contributions remain the copyright of their
respective authors and are licensed under the same Apache-2.0 terms. Attribution required by the licence is
recorded in [NOTICE](NOTICE).

---

<p align="center">
  <sub>DataBounty Community · Apache-2.0</sub>
</p>
