# MCP server

DataBounty Community ships a real [Model Context Protocol](https://modelcontextprotocol.io) server — JSON-RPC,
OAuth 2.1 with PKCE, client ID metadata documents or dynamic client registration, API-key auth as an
alternative, and per-credential rate limiting. **46 tools.**

This is the intended path for agents. Large contributions use the website's
bulk-upload-review handoff: MCP creates the one-time link, then the contributor reviews parsed rows in the browser before submitting.

---

## Connecting

**Endpoint:** `POST/GET http://<dashboard-host>/mcp`

That is the *only* MCP endpoint. There is deliberately **no `/mcp/sse`** — it was removed on purpose, so
a client configured for it will hang rather than connect. Point at `/mcp`.

`apps/web` is the public MCP gateway and proxies `/mcp/*` plus the OAuth discovery documents through to
the API. Clients should use the dashboard origin; the API origin remains an internal implementation detail.

### Interactive — OAuth 2.1 + PKCE

For a client a person is driving (Claude Desktop, Claude Code, Cursor, Codex, Windsurf). The client
discovers, registers and redirects the person to approve scopes in their browser. **The client never
receives the password.**

**Discovery.** An unauthenticated request to `/mcp` answers `401` with a `WWW-Authenticate: Bearer`
header whose `resource_metadata` parameter points at the protected-resource document. From there the
client finds the authorization server. Both documents are served at the path-inserted spelling and at
the root fallback, so every client generation finds them:

```
/.well-known/oauth-protected-resource/mcp        # path-inserted (preferred)
/.well-known/oauth-authorization-server/mcp
/.well-known/oauth-protected-resource            # root fallback
/.well-known/oauth-authorization-server
```

`MCP_PUBLIC_URL` is the public dashboard/MCP **origin** (`https://console.example.com`). A trailing `/mcp`
is tolerated and stripped, so a value copied from a client config still works.

**Client registration.** Two options, both accepted:

- *Client ID metadata document* (preferred) — the client's `client_id` is an `https` URL that serves its
  own metadata (name, redirect URIs). Nothing to register in advance; the consent screen shows that host.
- *Dynamic client registration* — `POST /mcp/oauth/register`, for clients that do not publish a metadata
  document.

**Authorization rules.** PKCE is mandatory and `S256` is the only accepted method. The `resource`
indicator (RFC 8707) is required on both the authorization and token requests and must name this MCP
server. Authorization responses carry `iss` (RFC 9207) so the client can reject a response from any other
issuer. Redirects to a loopback address are allowed for desktop and CLI clients, and the consent screen
says so explicitly, since the client name in that case comes from the client itself.

Endpoints: `POST /mcp/oauth/register` · `GET /mcp/oauth/authorize` · `POST /mcp/oauth/token` ·
`POST /mcp/oauth/revoke` · `GET /mcp/oauth/grants`.

**Credential lifetime and refresh recovery.** Access tokens last eight hours and refresh tokens last 30
days. When two desktop-client processes race to rotate the same refresh token, a token retired by a
successful rotation has a bounded 60-second recovery window: each caller receives a new working pair
instead of disconnecting the whole MCP server. This exception never applies to an explicit revoke or
account suspension. A stale replay is rejected and audited without destroying the current healthy
successor credential.

### Protocol versions

The server speaks both MCP transport eras over the same `/mcp` endpoint, so no client-side flag is needed:

- **Sessionful streamable HTTP** — `initialize`, then a server-issued `Mcp-Session-Id` header on every
  request. This is what today's Claude Code, Codex and Cursor send.
- **Stateless (2026-07-28)** — no session; the client calls `server/discover` and names the method in an
  `Mcp-Method` header on each request.

The negotiated version is echoed back in the response, so a client can confirm which path it is on.

The dashboard's **API & MCP** page has a ready-made config for each supported client — start there rather
than hand-writing one.

### Automation — API key

For unattended jobs. Issue a scoped key in the dashboard and send:

```
Authorization: Bearer db_live_sk_...
```

Keys are shown in full exactly once. Only a hash is stored, so a lost key is rotated, never recovered.

### Rate limits

Keyed **per credential**, not per IP — one noisy agent cannot throttle another on the same host or
behind the same NAT.

---

## Scopes

A tool runs only if the credential carries its scope. Grant the narrowest set that does the job.

| Scope | Tools | Grants |
|---|---|---|
| `public` | 6 | Browse pools, categories, stats, contracts, upload limits. No account needed. |
| `read` | 9 | Your own work: submissions, progress, karma, notifications, issues, file status. |
| `contribute` | 6 | Submit, revise, dispute, create an upload-review link, check its status. |
| `validate` | 5 | Claim audit windows, decide them, and list your own audits. |
| `artifact` | 7 | Prepare and complete uploads, list and delete your files. |
| `account` | 10 | Handle, onboarding, attribution preference, notification read-state, issue replies. |
| `sponsor` | 2 | Evidence for items in your own community request's pool; dispute an accepted item during the window. |

**`account` is deliberately separate from `contribute`.** A handle is your permanent public profile URL
and the name your dataset credit attaches to, so claiming one is its own consent decision rather than a
side effect of "submit work". An `account` credential still cannot verify an email, change a password,
or read admin surfaces.

---

## The 45 tools

### Discovery — `public`

| Tool | |
|---|---|
| `list_community_pools` | Active pools open for contribution, with dataset type, difficulty and karma per accepted item. |
| `get_pool` | One pool: contract summary, live progress, karma per accepted item. |
| `get_pool_contract` | The dataset type's schema, fields and verification requirements. **Read this in full before submitting.** |
| `list_dataset_categories` | Supported coding and benchmark categories. |
| `get_community_stats` | Public totals: pools, published datasets, accepted items, karma awarded. |
| `get_file_upload_limits` | Live byte limits (single vs multipart) **and** the item-count limits `submit_pool_items` enforces (`bulkThresholdItems`, `maxItemsPerRequest`). |

### Contributing — `contribute`

| Tool | |
|---|---|
| `submit_pool_items` | Submit up to the contract's live inline limit. Larger contributions use `create_upload_review_link`. **Validation runs asynchronously** — wait the returned recheck interval, then call `check_submission` once. Karma is awarded on final acceptance, never on submit. |
| `revise_submission` | Revise an item sent back for fixes. A fixed item that is then accepted still earns the pool's full per-item karma. |
| `dispute_submission` | Dispute a flagged verdict. |
| `list_my_submissions` | |
| `create_upload_review_link` | Draft upload-review link for bulk preview. |
| `get_upload_review_status` | Check what happened after handing off an upload-review link — still being reviewed, submitted, cancelled, or abandoned. |

### Checking your work — `read`

| Tool | |
|---|---|
| `check_submission` | Validation status and test outcomes, including the persisted-job recheck estimate. This is the polling tool after `submit_pool_items`. |
| `whoami` | Identity, handle, karma balance, ranks, live active-audit count against your validator cap, and your earned badges. |
| `get_karma_details` | Breakdown, tier ladder, progress to next tier. |
| `get_my_work_progress` | Contributions, accepted items, earned karma. |
| `get_file_status` · `get_file_processing_checks` | Scan verdict and processing results for a file you own. |
| `list_notifications` | |
| `get_issue` · `list_my_issues` | |

### Validating — `validate`

| Tool | |
|---|---|
| `list_audits` | Windows open to you, with item count and karma reward. Never includes your own submissions. |
| `claim_audit` | **Exclusive for 24 hours.** No other validator can claim or decide it while held. Required before `submit_decisions`. |
| `get_audit` | Details and items in a window. |
| `submit_decisions` | Your verdicts. Requires having claimed the window first. |
| `list_my_audits` | |

### Files — `artifact`

| Tool | |
|---|---|
| `prepare_file_upload` → `complete_file_upload` | Single-request upload. Use only when `sizeBytes` is under the limit `get_file_upload_limits` reports. |
| `prepare_large_file_upload` → `complete_large_file_upload` | Real chunked multipart — parallel and resumable, backed by the active storage driver. Supply every part number and ETag on completion. |
| `abort_large_file_upload` | Cancels an in-flight multipart upload and releases reserved parts. |
| `list_files` · `delete_file` | Artifacts owned by your account. |

Completion queues scanning and parsing as background jobs — a completed upload is not a processed file.
Check status before assuming it is usable.

### Account — `account`

| Tool | |
|---|---|
| `suggest_handles` | Confirmed-free suggestions, DB-checked and valid under the handle rules. |
| `get_handle_availability` | Validates and checks one handle; returns a reason when refused. |
| `claim_handle` | Claim your public handle. |
| `complete_onboarding` | |
| `resend_email_verification` | |
| `get_attribution_preference` · `set_attribution_preference` | Public-profile visibility and whether your name appears on published dataset credit. |
| `mark_notifications_read` | Mark one notification, or every notification, read. |
| `report_issue` · `reply_to_issue` | File and follow up on a support case. |

### Sponsoring — `sponsor`

For the person whose community request created the pool. Creating a request stays dashboard-only; these
tools manage one that already exists.

| Tool | |
|---|---|
| `get_sponsor_submission_evidence` | Per-stage evidence (dedupe, contamination, execution, LLM review, human audit) for submissions in a pool you own. Owner-only — a request you do not own returns nothing, not a partial view. |
| `dispute_accepted_submission` | Dispute an item that was accepted into your pool, while its dispute window is open. Routes to a handler; it never reverses the acceptance on its own. Outside the window it is refused. |

Handle rules are identical across MCP and REST: lowercase letters, digits and single interior hyphens,
3–20 characters, no leading/trailing/doubled hyphen, and not reserved. Reserved covers every landing
route name and impersonation-prone names — see [api.md](api.md#your-account--v1me).

---

## Working with it well

**Read the contract first.** `get_pool_contract` returns the exact field keys, roles and verification
requirements. Payload shape is per dataset type — there are 50 — so do not assume a shape from another
pool.

**Everything heavy is asynchronous.** Submit, wait the returned `recheckAfterSeconds`, then call
`check_submission` once. Upload, then follow the returned `get_file_status` interval. A tool returning
successfully means the work was *accepted for processing*.

**Karma is awarded on final acceptance only** — never for claiming or submitting — and is then held
through the dispute window before it lands.

**Trust states are honest, so read them.** A stage that was skipped, is unsupported, unconfigured or
stale says exactly that. `execution` with no sandbox key reports `no_provider_configured`; `llm` with no
key reports the same outcome, carrying `status: "pending_llm_review"` in its evidence detail. Neither means
passed — both route the item to a human. Treat any stage result that is not an explicit pass as not-passed.

**Claims expire.** An audit window is yours for 24 hours; walk away and it returns to the queue.

**You cannot review your own work.** Conflict-of-interest filtering is server-side, so `list_audits`
simply never offers you a window containing your submissions.
