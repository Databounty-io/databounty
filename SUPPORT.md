# Support

## Start here

Most questions are already answered in one of these:

| If you want to… | Read |
|---|---|
| Understand what this project is and what actually works today | [README.md](README.md) — including the **Works today · Being wired up · Not built** table |
| Get it running locally | [CONTRIBUTING.md](CONTRIBUTING.md#getting-it-running) |
| Deploy it for real | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Configure one specific app | that app's own `README.md` under `apps/` |
| Report a security vulnerability | [SECURITY.md](SECURITY.md) — **not** a public issue |

## Where to ask

- **A bug** — open a **GitHub issue**. Include which app, steps to reproduce, the commit SHA, and the
  console output or server log. See [Reporting bugs](CONTRIBUTING.md#reporting-bugs).
- **A question, or "am I holding this wrong?"** — open a **GitHub Discussion** if this repository has
  Discussions enabled; otherwise open an issue and label it a question.
- **A feature idea** — open an issue describing the problem you hit, not just the solution you have in
  mind. If it is a change to the API surface or the database schema, please do that *before* writing
  code — see [What we will and won't merge](CONTRIBUTING.md#what-we-will-and-wont-merge).
- **A security vulnerability** — private disclosure only. [SECURITY.md](SECURITY.md).
- **Something that does not fit any of the above** — email **support@databounty.io**. Please use GitHub
  for anything about the code itself; issues and discussions are searchable, and the answer helps the next
  person who hits the same thing.

## Things we cannot help with

- **Wallet, payments, escrow, payouts, validator bonds, or anything on-chain.** None of it exists in
  this codebase, by design — see [Where we draw the line](README.md#where-we-draw-the-line). We cannot help you
  enable it, and there is no flag to turn it on.
- **Your hosting provider, your database, or your DNS.** We are glad to clarify what this software needs;
  we cannot debug your infrastructure.
- **Private consulting or guaranteed response times.** This is a volunteer-supported open-source project.
  There is no SLA, and nobody is on call.

## Before you file: two things that cause most reports

Both look exactly like application bugs, and neither is:

1. **The background worker is not running.** Deduplication, sandboxed execution, and publication are
   background jobs, which run inside the API process (`npm run dev`, or the `api` service in `docker compose`). If the API is not running,
   submissions queue and nothing progresses.

2. **`CORS_ORIGINS` does not list the frontend you are using.** The browser blocks the API call with no
   server-side error, so the page just sits there empty. Make sure the API's `CORS_ORIGINS` includes
   every frontend origin you actually run, on the exact port you run it on.

## Response expectations

Maintainers read issues and respond as time allows. A clear, reproducible report with the commit SHA and
logs gets a useful answer far faster than one without — most of the delay on any given issue is the round
trip to find out what you actually ran.
