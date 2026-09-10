# Contributing to DataBounty Community

Thanks for looking. Before anything else, one thing about this repository will trip you up if nobody
warns you:

> ### ⚠️ There is no root install
>
> This repository holds **four independent applications** under `apps/`. There is no root
> `package.json`, no npm workspace, and no monorepo build tool. Each app has its own
> `package.json` and its own `package-lock.json`.
>
> **`npm install` at the repository root does nothing.** Install, build, lint, and test from
> *inside* each app directory.

That is deliberate — the four apps share no code and talk to each other only over HTTP — but it is
the opposite of what most `apps/`-shaped repositories do, so it is stated first.

---

## Table of contents

- [What you need](#what-you-need)
- [Getting it running](#getting-it-running)
- [The four apps](#the-four-apps)
- [Before you open a pull request](#before-you-open-a-pull-request)
- [Running the tests](#running-the-tests)
- [What we will and won't merge](#what-we-will-and-wont-merge)
- [House rules that are not negotiable](#house-rules-that-are-not-negotiable)
- [Commit messages](#commit-messages)
- [Certifying your contribution (DCO)](#certifying-your-contribution-dco)
- [Credit and attribution](#credit-and-attribution)
- [Reporting bugs](#reporting-bugs)
- [Security](#security)
- [License](#license)

---

## What you need

- **Node.js 20.19.0 or newer.** `apps/api` declares `"engines": { "node": ">=20.19.0" }`. The three
  Next.js apps do not declare an `engines` field, but run on the same toolchain — use the same Node
  across all four.
- **PostgreSQL**, one reachable instance.
- **npm.** Per-app, as described above.
- **Docker** (optional) — for the one-command stack instead of running four processes by hand.

## Getting it running

The fastest path to a working stack is Docker Compose, which starts Postgres, applies migrations,
seeds the dataset-type catalog, and runs all four apps plus the background worker:

```bash
docker compose up
```

To run apps directly, start with the API — the other three need it to be useful:

```bash
cd apps/api
npm install
cp .env.example .env          # fill in DATABASE_URL at minimum
npx prisma migrate deploy     # applies prisma/migrations/
npx tsx prisma/seed-catalog.ts   # idempotent; loads the dataset-type catalog
npm run dev                   # API on http://localhost:4000
```

Then any frontend:

```bash
cd apps/web                   # or apps/admin, apps/landing
npm install
cp .env.example .env          # fill in NEXT_PUBLIC_API_URL and the other apps' URLs
npm run dev
```

Background jobs run inside `npm run dev` — there is no separate worker process to start (that split was removed 2026-09-02). Deduplication,
sandboxed execution, and publication all run as background jobs — without the worker they queue and
nothing happens, which looks exactly like a bug in the code you just wrote.

## The four apps

| App | What it is | `npm run dev` port |
|---|---|---|
| `apps/api` | Fastify + Prisma + Postgres. REST API, MCP server, background worker, validation pipeline. | `4000` |
| `apps/web` | Next.js. The logged-in dashboard: sponsor requests, contributor submission, validator audits, karma/profile. | `53000` |
| `apps/admin` | Next.js. Operator console: review requests, moderate, configure settings. | `3002` |
| `apps/landing` | Next.js. Public site: dataset catalog, public profiles, marketing pages. | `3001` |

If you change a port, `NEXT_PUBLIC_API_URL` and the API's `CORS_ORIGINS` / `APP_URL` have to agree with
it. **`CORS_ORIGINS` must list every frontend origin you actually run**, or the browser silently blocks
API calls from the ones you left out — with no server-side error to tell you why.

## Before you open a pull request

Run these in **each app you touched**. All four apps have `typecheck`; the three frontends have `lint`;
`apps/api` has `test`.

```bash
npm run typecheck     # all four apps
npm run lint          # apps/web, apps/admin, apps/landing (apps/api has no eslint config)
npm run build         # confirms it actually compiles for production
npm test              # apps/api only — see below, it needs a database
```

Then, in the pull request description, say **what you verified and how**. "Should work" is not a
verification. If you changed something a user can see, say which page you loaded and what you observed.

### What CI runs on your pull request

CI is path-aware. It compares your branch against its merge base with `main` and checks only the apps
your commits actually touch: a pull request confined to `apps/web` runs the web typecheck, lint, build
and image build, and nothing for `apps/api`. A change to anything shared — `docker-compose.yml`, the
workflow itself, the root `.dockerignore`, any file outside `apps/**` that is not documentation — runs
all four apps, because a shared file can break any of them.

The job names never change and no job is ever skipped: a job with nothing to do runs, prints why, and
exits. That is deliberate. A required status check that sometimes does not exist is a required check
that has silently stopped being required, and the "Decide what to run" job's step summary lists exactly
which apps were checked, so a green run always says what it actually proved.

Pushes to `main` and manual runs always check all four apps regardless of paths. The deploy hand-off
fires from a `main` run, so a deployment is never built on a partial one.

> **Do not edit `.github/workflows/ci.yml` as part of an application, documentation, or bug-fix pull request.**
> CI changes affect every contributor and deployment hand-off, so they require a separately scoped,
> explicitly approved change with its own verification evidence.

## Running the tests

`apps/api` has unit and integration tests on Vitest. The integration tests are the substance of the
suite, and they need a real Postgres database. `npm test` deliberately runs files serially because
they share the disposable database and their cleanup would otherwise race across workers. Do not
remove that serialization unless every worker first receives an isolated database.

**They will refuse to run against the wrong one.** Every integration test file checks that
`DATABASE_URL` contains `databounty_community_parity_verify` and throws immediately if it does not:

```
Refusing to run integration tests: DATABASE_URL does not point at the disposable
databounty_community_parity_verify database. Check .env before running tests.
```

That guard exists because these tests write and delete rows. Do not weaken it, do not special-case it,
and do not point it at a database you care about. Create the disposable one:

```bash
createdb databounty_community_parity_verify
DATABASE_URL="postgresql://…/databounty_community_parity_verify" npx prisma migrate deploy
DATABASE_URL="postgresql://…/databounty_community_parity_verify" npm test
```

If you add a test that touches the database, carry the same guard.

The three frontends have no test suite. Adding one is welcome; adding a mostly-empty one so the badge
turns green is not.

## What we will and won't merge

**Welcome:**

- Bug fixes, with a note on how you reproduced the bug and confirmed the fix.
- Tests for existing behavior, particularly on the frontends where there are none.
- Documentation that corrects something wrong. If a doc and the code disagree, **the code wins** — fix
  the doc to match reality, not the other way around.
- Accessibility, responsive, and error-state fixes.
- New dataset types and validation harnesses.

**Please open an issue first:**

- New API endpoints, or changes to existing request/response shapes.
- Prisma schema changes. Every schema change ships with a matching migration in the same pull request —
  a schema edit without a migration silently drifts every deployment.
- Anything that changes what a trust claim means, or when a pipeline stage is considered passed.
- Large refactors. A 3,000-line diff that moves code around is very hard to review against a product
  whose correctness rests on specific guarantees.

**We will not merge:**

- **Wallet, payment, escrow, payout, validator-bond, or on-chain functionality.** This is not a missing
  feature, a disabled flag, or a paid tier held back — karma is the only reward this product has,
  and there is nothing to upgrade to. A pull request adding any of it will be declined on scope alone.
- A pipeline stage that reports a result it did not compute. See below.
- Generated or vendored dependency directories, build output (`dist/`, `.next/`, `out/`), or `.env`
  files. All are gitignored; if one shows up in your diff, remove it.

## House rules that are not negotiable

These come from the product's own guarantees, not from style preference. A pull request that breaks one
will be asked to change regardless of how good the rest of it is.

1. **Never fake a check result.** If a validation stage was skipped, is unsupported, is unconfigured, or
   went stale, the stored evidence and the UI must both say exactly that. A placeholder that always
   reports "not attempted" — or worse, "passed" — is worse than not having the stage. Fail closed and be
   honest about why. This is the single rule the product cannot survive breaking.

2. **Do not hardcode to today's formats.** Dataset types are a versioned registry with per-type
   allowlists and pluggable parsers. Submission, preview, validation, similarity, and export logic must
   not assume JSON/CSV or today's catalog. Unknown types fail closed to quarantine or human review.

3. **Heavy work is asynchronous.** Parsing, media processing, similarity, sandboxed execution, and LLM
   review run as background jobs — idempotent, with bounded retries and recoverable failures. Do not do
   them inline in a request handler, and do not hold a database transaction open across a network call
   to a sandbox or a model provider.

4. **Filter and paginate server-side.** List endpoints take query parameters. Do not fetch everything
   and filter in the browser.

5. **A contributor cannot validate their own submission.** Conflict-of-interest checks are enforced
   server-side. Do not add a client-side-only version and call it done.

6. **Reuse what exists.** All three frontends have a shared component layer — `components/ui.tsx` in
   `apps/web` and `apps/landing`, `components/admin-shell.tsx` (`AdminButton`, `AdminTable`,
   `AdminErrorBanner`, `AdminPill`, …) in `apps/admin`. Use the existing button, banner, dialog, and table
   before hand-rolling markup, and route API calls through the existing client modules — `lib/api-*` in
   `apps/web`, `lib/use-admin-resource.ts` in `apps/admin`, `lib/public-data.ts` in `apps/landing` — rather
   than calling `fetch` directly from a page.

7. **Every user-visible async action needs a loading and an error state.** A button that silently does
   nothing on a 403 is a bug, not an edge case.

## Commit messages

Write plain, human commit messages in the imperative — "fix duplicate karma award on re-settlement",
not "fixed some stuff" and not a wall of bullet points. Explain *why* in the body when the reason is not
obvious from the diff.

**Do not add AI attribution to commit messages** — no `Co-Authored-By` trailer naming an AI assistant,
no "generated with" line, no robot emoji. Use the tools you like; the commit log stays a human record.

## Certifying your contribution (DCO)

This project uses the **Developer Certificate of Origin** — the same mechanism the Linux kernel and
Git itself use. There is no contributor licence agreement to sign, no form, and no account to create.

You certify a contribution by adding one line to the end of each commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds it for you from your `git config` name and email. Set them once:

```bash
git config user.name  "Your Name"
git config user.email "your.email@example.com"
git commit -s -m "fix duplicate karma award on re-settlement"
```

Use a real name and a working email — the sign-off is a statement of record, so it should identify
you the way you would identify yourself. Anonymous and pseudonymous sign-offs cannot be accepted.

**What you are certifying** is the full text of the [DCO version 1.1](https://developercertificate.org/):
in plain terms, that you wrote the contribution or otherwise have the right to submit it under this
repository's licence, and that you understand the contribution and your sign-off are public and
permanent.

**What you are not doing** is transferring anything. You keep the copyright in your own work; the
sign-off licenses it in under the [Apache License 2.0](LICENSE), the same terms the rest of the repository
carries. That is the whole of it — a DCO is a certification, not an assignment.

Forgot the sign-off? Nothing is lost:

```bash
git commit --amend -s --no-edit          # last commit
git rebase --signoff HEAD~3              # last three
git push --force-with-lease
```

CI checks every commit in a pull request for the trailer, so an unsigned commit will fail the run
rather than sit unnoticed until review.

## Credit and attribution

You get credit automatically. You never have to ask for it, and asking is not held against you
either — if you were missed, that is our process failing, not a verdict on your work.

Four layers, all of them automatic:

- **Git history.** Your commit carries your name and email permanently, and feeds `git blame` and the
  Contributors graph. We do not rewrite history and we do not squash away authorship.
- **[`CONTRIBUTORS.md`](CONTRIBUTORS.md).** Credits every kind of contribution, not just code — bug
  reports, docs, design, review, accessibility, dataset types, translation, infrastructure. Maintained
  by the [all-contributors](https://allcontributors.org) bot, so a maintainer adds you with a comment
  on your merged pull request and you do nothing.
- **Release notes.** Each release names the people whose work is in it and links the pull request.
- **The pull request.** Public, attached to your account, linked from the commit — in practice the
  most detailed record of what you did.

Two things worth knowing:

- **You can decline.** Say so in your pull request and we will leave you out of `CONTRIBUTORS.md` and
  the release notes. Your commit stays in git history regardless — that is authorship, not
  promotion, and removing it would mean rewriting the repository.
- **Security reports are credited in the advisory unless you ask us not to** — see
  [`SECURITY.md`](SECURITY.md).

If your commits show up under more than one name or email, add yourself to [`.mailmap`](.mailmap) —
that is what the file is for.

## Reporting bugs

Open an issue with:

- Which app, and which page or endpoint.
- What you expected, and what actually happened.
- Steps to reproduce, and the commit SHA you are on.
- For the frontends: browser console output and the failing network request.
- For the API: the request, the response status and body, and the relevant server log lines.

Before filing, check the **Works today · Being wired up · Not built** table in
[README.md](README.md#works-today--being-wired-up--not-built). Several things are known-incomplete on
purpose; a report against one of those is still useful, but say that you saw it listed.

## Security

**Do not open a public issue for a security vulnerability.** See [SECURITY.md](SECURITY.md) for the
private reporting channel and what is in scope.

## License

Your contributions are licensed under the [Apache License 2.0](LICENSE), the same terms that cover this
repository. You certify that with a DCO sign-off on each commit — see
[Certifying your contribution](#certifying-your-contribution-dco). You keep the copyright in your own
work; nothing here asks you to assign it.
