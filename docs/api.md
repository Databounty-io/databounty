# REST API

Base path: **`/v1`** on the API origin (default `http://localhost:4000`).

If you are building an *agent*, use the [MCP server](mcp.md) instead — it wraps this surface in 44 typed
tools with scoped consent, and bulk submission is a first-class MCP capability.

---

## Authentication

Two mechanisms. Which one a route accepts matters: some routes deliberately refuse API keys.

### Session cookie — browsers

`POST /v1/auth/login` or `/v1/auth/signup` sets an `HttpOnly` cookie:

- `db_session` — member sessions (the dashboard)
- `db_admin_session` — admin-console sessions, a **separate** cookie signed with a **separate** secret,
  so an admin session can never be derived from a member one

Send it with `credentials: "include"`. Your origin must be listed in the API's `CORS_ORIGINS` or the
browser blocks the call with no server-side error — the request never arrives.

### API key — automation

```
Authorization: Bearer db_live_sk_...
```

Keys are issued at `POST /v1/me/api-keys` and shown **in full exactly once**. Only a hash is stored, so a
lost key is rotated (`POST /v1/me/api-keys/:id/rotate`), never recovered.

Each key carries scopes; a call outside its scopes gets `403`.

| Scope | Grants |
|---|---|
| `read` | Your own work: submissions, audits, rank, karma, notifications. |
| `contribute` | Submit and revise items, dispute a rejection. |
| `validate` | Claim audit windows and record verdicts. |
| `artifact` | Prepare and complete file uploads, check scan status. |
| `sponsor` | Read your own pools and their progress. |
| `account` | Claim a handle, complete onboarding, attribution preference. |

`account` is deliberately its own scope rather than folded into `contribute`: a handle is your permanent
public identity and the name your dataset credit attaches to, so it gets its own consent rather than
arriving as a side effect of "submit work".

### What an API key cannot do

Some routes require a real browser session even with a valid key — changing a password, verifying an
email, and admin-console surfaces. A key that tries gets `403` with a message saying a browser session is
required, not a confusing `401`.

---

## Conventions

**Verified email is required for mutations.** Most write routes sit behind a verified-email check. An
unverified account gets:

```json
{ "statusCode": 403, "error": "Forbidden", "code": "email_unverified",
  "message": "Please verify your email before you can do this. Check your inbox for the link." }
```

Check `code`, not the message text.

**Errors** are Fastify-shaped: `{ statusCode, error, message }`, sometimes with a machine-readable
`code`. Meaningful statuses:

| Status | Means |
|---|---|
| `400` | Validation failure. The `message` is specific and safe to show a user. |
| `401` | No session or no key. |
| `403` | Authenticated but not allowed — wrong scope, wrong role, unverified email. |
| `409` | Conflict — a handle already claimed, an audit already claimed by someone else. |
| `429` | Rate limited. |

**Rate limits** — a global budget (`ratelimit.global.max` per `ratelimit.global.window_seconds`, both
runtime settings), with tighter per-route limits on sensitive paths: auth routes 10/min, handle reads
30/min, handle writes 10/min. MCP OAuth limits are keyed **per credential**, not per IP, so one noisy
agent cannot throttle another.

**Filtering and pagination are server-side.** List endpoints take query parameters; do not fetch
everything and filter in the browser.

---

## Route surface

The full non-admin surface, by area. Admin routes live under `/v1/admin/*` and require an operator role.

### Auth — `/v1/auth`

| | |
|---|---|
| `POST /signup` · `POST /login` · `POST /logout` | Email and password. |
| `POST /google` · `POST /google/admin` | Google sign-in, when `GOOGLE_CLIENT_ID` is set. |
| `GET /me` | Current session. |
| `POST /verify-email` · `POST /resend-verification` | Email verification. Tokens are single-use — a replay gets `400`. |
| `POST /forgot-password` · `POST /reset-password` · `POST /change-password` | |
| `POST /set-password` · `POST /request-set-password` | For accounts created via OAuth with no password yet. |
| `POST /onboarding-complete` | Marks onboarding done and stores the landing preference. |
| `POST /accept-invite` | Operator invitations. |

### Your account — `/v1/me`

| | |
|---|---|
| `GET/PUT /` · `GET/PATCH /profile` | |
| `GET /public-profile` · `PATCH /public-profile` | Visibility preferences: karma, badges, datasets, activity, attribution opt-out. |
| `GET /public-profile/handle-availability` | Validates and checks a handle. Returns a reason when refused, and suffix suggestions when taken. |
| `GET /public-profile/handle-suggestions` | Confirmed-free generated handles. |
| `POST /public-profile/handle` | **First claim only** — `409` if you already have one. Turns the public page on. |
| `PUT /public-profile/handle` | Rename. Leaves your public/private choice alone. |
| `GET /karma` · `GET /karma/history` · `GET /badges` | |
| `GET /contributor-dashboard` · `GET /validator-dashboard` · `GET /audits` · `GET /pool-submissions` | |
| `GET /analytics?weeks=` | **Set `MEMBER_ANALYTICS_ENABLED=false` to unregister.** Weekly counts over your own rows, 4–52 weeks (default 12), ISO weeks starting Monday in UTC. Submission outcomes are grouped by the week you submitted and split by current status — there is no rejected-at timestamp to group by, and the payload's `notes` say so. Karma and audit decisions are grouped by real event time. No V1 counterpart exists, so this is a recorded divergence from the parity baseline. |
| `GET/POST /api-keys` · `POST /api-keys/:id/rotate` · `DELETE /api-keys/:id` | |
| `GET /profile-sources` · `POST /profile-sources/:id/connect` · `PUT`/`DELETE /profile-sources/:id` | Credential verification. |
| `GET/PUT /sponsor-scope` | |

**Handle rules** (enforced identically here, in the legacy `/v1/me/handle/*` pair, and in MCP):
lowercase letters, digits and single interior hyphens; 3–20 characters; no leading, trailing or doubled
hyphen; and not on the reserved list. Reserved covers every landing route name (`open`, `pools`,
`terms`, `privacy`, `changelog`, `domains`, …) plus impersonation-prone names (`admin`, `support`,
`billing`, `security`, …) — a handle is served at `landing/{handle}`, so an unreserved route name would
shadow a real page and leave that profile permanently unreachable.

### Discovery — `/v1/meta`, `/v1/community`, `/v1/bounties`, `/v1/profiles`

| | |
|---|---|
| `GET /meta/taxonomy` (requires auth) · `GET /meta/public-catalog` · `GET /meta/launch-flags` | Domains, dataset types, languages, feature switches. |
| `GET /meta/developer-surface` | Base URL, MCP URL, rate limit, live MCP tool list. |
| `GET /community/pools` · `GET /community/catalog` · `GET /community/catalog/:id` | Open pools and the dataset-type catalog. |
| `GET /community/stats` · `GET /community/leaderboard` · `GET /community/karma` | |
| `GET /community/members/:handle` · `GET /profiles/handle/:handle` · `GET /profiles/sitemap` | Public profiles, subject to the member's visibility preferences and `launch.public_profiles.enabled`. |
| `GET /bounties` · `GET /bounties/:id` · `GET /bounties/:id/progress` | |
| `GET /bounties/:id/contract` | The dataset type's field contract — what a submission must contain. Fetch this before building a payload. |

### Contributing — `/v1/submissions`, `/v1/bounties/:id/items`

| | |
|---|---|
| `POST /submissions` · `POST /submissions/bulk` | Submit one item or an array. No claim step — while a pool has room, submit. |
| `GET /submissions` · `GET /submissions/:id` | Status and per-stage evidence. |
| `POST /submissions/:id/revise` | Bounded by `submissions.max_revisions`. |
| `POST /submissions/:id/dispute` · `POST /submissions/:id/dispute-acceptance` | |
| `POST /bounties/:id/items` · `GET /bounties/:id/my-submissions` | Pool-scoped equivalents. |

Submission is asynchronous: the response confirms receipt and queues `validation.run`. Poll
`GET /submissions/:id` for stage results. **If nothing ever progresses, the worker is not running.**

### Validating — `/v1/audits`

| | |
|---|---|
| `GET /audits` | Windows you are eligible for. Excludes any containing your own submissions. |
| `POST /audits/:id/claim` | Exclusive for 24 hours. `409` if someone else holds it. |
| `GET /audits/:id` · `POST /audits/:id/decisions` | |

### Files — `/v1/artifacts`

| | |
|---|---|
| `POST /artifacts/upload-slot` → `POST /artifacts/:id/complete` | Standard upload. |
| `POST /artifacts/multipart-slot` → `.../multipart-complete` / `.../multipart-abort` | Above `STORAGE_MULTIPART_THRESHOLD_BYTES`. |
| `GET /artifacts/:id` · `GET /artifacts/:id/content` | Access is authorized per request — a validator can read evidence only while holding an active audit assignment on that submission. |

Uploads are presigned and time-limited. Parsing, preview and scanning run as jobs afterwards, so a
successful upload does not mean a processed file — check the artifact's status.

### Sponsoring — `/v1/community/requests`, `/v1/planner`

| | |
|---|---|
| `POST /community/requests` · `GET /community/requests/mine` · `GET/PATCH/DELETE /community/requests/:id` | Gated by `community.min_karma_to_request`. |
| `POST /community/requests/:id/resubmit` · `.../dispute` | After a changes-requested or declined decision. |
| `GET/POST /community/requests/:id/comments` | Append-only review thread — no edits, no deletes. |
| `GET /planner/catalog` · `POST /planner/preview` · `POST /planner/assist` | The planner is **deterministic and database-driven**; its options come from admin-configured catalog rows, not an LLM improvising a spec. |
| `POST /planner/sessions` · `GET /planner/sessions/active` · `POST /planner/sessions/:id/answers` · `POST /planner/sessions/:id/finalize` | Resumable draft. |
| `POST /bounties/:id/sponsor-review/:submissionId` | Sponsor verdict on pools with zero audit coverage. |

### Notifications — `/v1/notifications`, `/v1/watch-prefs`, `/v1/telegram`, `/v1/integrations`

| | |
|---|---|
| `GET /notifications` · `POST /notifications/:id/read` · `POST /notifications/read-all` | |
| `GET /notifications/stream` | Live feed. |
| `GET /notifications/channels` · `POST /channels/:id/connect` · `.../verify` · `.../test` · `PATCH`/`DELETE` | |
| `GET /notifications/slack/channels` · `POST /notifications/slack/select-channel` | |
| `POST /telegram/link/start` · `GET /telegram/status` · `DELETE /telegram/link` | |
| `GET`/`POST /notifications/unsubscribe-digest` | Works from an email link. |
| `/v1/watch-prefs` | Which categories and languages you want alerts for. |

### Support and everything else

| | |
|---|---|
| `POST /issues` · `GET /issues` · `GET /issues/:id` · `POST /issues/:id/reply` | Support cases, usable by agents. |
| `GET /benchmarks` · `GET /benchmarks/:slug` · `.../leaderboard` | |
| `POST /waitlist` · `GET /waitlist/:domain/count` | |
| `/v1/upload-review-drafts/*` | Bulk-upload review hand-off. **The website flow is not being fixed** — bulk submission is an MCP capability instead. |

---

## Two things that look like API bugs and are not

1. **Nothing progresses after submitting.** Background work runs inside the API process. If the API is not running, jobs queue and
   the pipeline never advances.
2. **Requests never arrive from the browser.** `CORS_ORIGINS` does not list your frontend's exact origin
   and port, so the browser blocks the call before it leaves — with no server-side error to find.
