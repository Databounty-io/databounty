// SPDX-License-Identifier: Apache-2.0

/**
 * MCP scope-gate matrix — every registered tool, every declared scope, driven
 * through the real Fastify app, the real MCP streamable-HTTP transport, real
 * developer API keys, real OAuth access tokens and a real local Postgres.
 *
 * The matrix is DERIVED FROM THE REGISTRY (`src/mcp/tools.ts`), never from a
 * hand-written list, so a tool added later is covered the moment it is
 * registered — and the coverage assertion at the bottom fails loudly if any
 * tool escapes the sweep.
 *
 * What it proves, per tool:
 *   1. denial      — a credential carrying every scope EXCEPT the tool's own
 *                    declared scope is refused, with the scope-missing reason,
 *                    over BOTH credential paths (API key and OAuth access
 *                    token) because `routes/mcp.ts` builds the caller identity
 *                    by two different code paths.
 *   2. substance   — the denial wrote nothing: the account's row, its unread
 *                    notification, its artifact and its issue/submission
 *                    counts are byte-identical after the whole denial sweep,
 *                    including calls made with REAL write payloads.
 *   3. positive    — a credential holding exactly the declared scope is not
 *                    refused *for scope reasons*. It may still fail on a
 *                    missing fixture, a bad argument, verified-email or
 *                    onboarding — asserting only "not the scope refusal" is
 *                    what stops a wrongly-gated tool hiding behind an
 *                    unrelated error.
 *   4. no creds    — every non-public tool refused with no credential at all;
 *                    every registry-declared public tool callable with none,
 *                    and its payload free of owner-identifying data.
 *   5. empty scope — a credential issued with `scopes: []` is refused by every
 *                    non-public tool.
 *   6. meta        — coverage equals the registry size, and every declared
 *                    scope string is one of the six real scopes (a typo'd
 *                    scope makes a tool either uncallable or callable by the
 *                    wrong credential, and must fail the suite).
 *
 * Transport note. The credentialed sweeps run over the real JSON-RPC
 * `POST /mcp` sessionful transport, exactly as
 * `mcp-multiclient-apikeys.integration.test.ts` does. The NO-CREDENTIAL sweep
 * cannot: `routes/mcp.ts` rejects a bearer-less `/mcp` at the transport with
 * 401 `invalid_token` before any tool is reached, so an unauthenticated caller
 * can never get as far as the tool gate there. Those cases therefore go
 * through the other transport that mounts the same gate, `POST /mcp/call`
 * (`src/mcp/server.ts`) — which is the only surface on which a `public` tool
 * is reachable at all.
 *
 * Self-guards like every other integration test: refuses to run unless
 * DATABASE_URL names a disposable local database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  AgentIssueCategory,
  AgentIssueImpact,
  ApiKeyScope,
  ArtifactKind,
  ArtifactStatus,
  AuditVerdict,
  AuthMethod,
  FlagReason,
} from "@prisma/client";
import { buildApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";
import { tools } from "../mcp/tools.js";
import { PUBLIC_SCOPE } from "../mcp/core/contract.js";
import { MCP_SCOPES } from "../services/mcp-oauth.js";
import { issueApiKey as issueApiKeyDirect } from "../services/api-keys.js";
import { resetOnboardingCache } from "../mcp/onboarding-gate.js";
import { parsePublicProfilePrefs } from "../services/reputation.js";

requireDisposableDatabase();

let app: FastifyInstance;

const MCP_ACCEPT = "application/json, text/event-stream";
const KNOWN_SCOPES = new Set<string>(MCP_SCOPES);
const SCOPE_REFUSAL = /missing the required scope/i;

/** The registry, split the only way the gate itself splits it. */
const PUBLIC_TOOLS = tools.filter((t) => t.scope === PUBLIC_SCOPE);
const GATED_TOOLS = tools.filter((t) => t.scope !== PUBLIC_SCOPE);

type Account = { email: string; handle: string; userId: string; cookie: string };

let denialUser: Account;
let positiveUser: Account;
/** A third account nobody's credential belongs to — its handle and email must
 *  never appear in a public tool's unauthenticated payload. */
let stranger: { userId: string; email: string; handle: string };

/** Per-scope credentials, built once in beforeAll and reused for every tool. */
const allExceptKeySession = new Map<string, McpClientSession>();
const allExceptOauthSession = new Map<string, McpClientSession>();
const exactKeySession = new Map<string, McpClientSession>();
let emptyScopeSession: McpClientSession;
/** Raw value of the all-except-`sponsor` API key, for the one assertion that
 *  needs the other transport rather than an open MCP session. */
let sponsorlessRawKey: string;

const registeredClientIds: string[] = [];
const createdUserIds: string[] = [];

/**
 * Every (tool, sweep) pair the matrix actually executed. Populated by the
 * sweeps themselves and checked at the bottom, so a tool that is skipped —
 * for any reason, including a `describe` that silently short-circuits — is a
 * failure rather than an absence.
 */
const EXERCISED = new Map<string, Set<string>>();
function markExercised(sweep: string, tool: string): void {
  if (!EXERCISED.has(tool)) EXERCISED.set(tool, new Set());
  EXERCISED.get(tool)!.add(sweep);
}

/** Fixtures on `denialUser` that a successful write would visibly change. */
let denialNotificationId: string;
let denialArtifactId: string;

// ── helpers (same shapes as mcp-multiclient-apikeys.integration.test.ts) ────

async function sha256Base64Url(input: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(input).digest("base64url");
}

async function pkce() {
  const { randomBytes } = await import("node:crypto");
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: await sha256Base64Url(verifier) };
}

/** Streamable HTTP may answer with SSE; read either representation. */
function jsonRpcBody(payload: string): any {
  const trimmed = payload.trimStart();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLine = payload
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`No JSON-RPC payload in response: ${payload.slice(0, 200)}`);
  return JSON.parse(dataLine.slice("data:".length).trim());
}

async function signupVerified(prefix: string): Promise<Account> {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const email = `${prefix}-${stamp}@example.com`;
  const handle = `${prefix}${stamp}`.toLowerCase().slice(0, 20);
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Test@12345", handle, displayName: prefix },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  createdUserIds.push(userId);
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date(), onboarded: true } });
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, handle, userId, cookie };
}

async function registerDynamicClient(name: string, redirectUri: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/mcp/oauth/register",
    payload: { redirect_uris: [redirectUri], client_name: name, token_endpoint_auth_method: "none" },
  });
  expect(res.statusCode).toBe(201);
  const clientId = res.json().client_id as string;
  registeredClientIds.push(clientId);
  return clientId;
}

/** Full consent flow → a live OAuth access token carrying exactly `scopes`. */
async function oauthAccessToken(input: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  cookie: string;
}): Promise<string> {
  const { verifier, challenge } = await pkce();
  const authorize = await app.inject({
    method: "GET",
    url: "/mcp/oauth/authorize",
    query: {
      response_type: "code",
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: input.scopes.join(" "),
    },
  });
  expect(authorize.statusCode).toBe(302);
  const requestId = new URL(authorize.headers.location as string).searchParams.get("request_id");
  expect(requestId).toBeTruthy();

  const approved = await app.inject({
    method: "POST",
    url: `/mcp/oauth/request/${requestId}/approve`,
    headers: { cookie: input.cookie, origin: "http://localhost:3000" },
    payload: { scopes: input.scopes },
  });
  expect(approved.statusCode).toBe(200);

  const token = await app.inject({
    method: "POST",
    url: "/mcp/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: approved.json().code as string,
      code_verifier: verifier,
      redirect_uri: input.redirectUri,
    }).toString(),
  });
  expect(token.statusCode).toBe(200);
  const body = token.json();
  // The credential must carry exactly what the matrix assumes it carries.
  expect(new Set(String(body.scope).split(" "))).toEqual(new Set(input.scopes));
  return body.access_token as string;
}

async function issueKeyViaRoute(cookie: string, scopes: ApiKeyScope[]): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/v1/me/api-keys", headers: { cookie, origin: "http://localhost:3010" }, payload: { scopes } });
  expect(res.statusCode).toBe(201);
  expect(new Set(res.json().scopes as string[])).toEqual(new Set(scopes));
  return res.json().key as string;
}

interface McpClientSession {
  label: string;
  sessionId: string;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ statusCode: number; result: any }>;
}

/** Open a real sessionful streamable-HTTP MCP session on a bearer credential. */
async function openMcpSession(token: string, label: string): Promise<McpClientSession> {
  const auth = { authorization: `Bearer ${token}`, accept: MCP_ACCEPT, "content-type": "application/json" };
  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: auth,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest-scope-matrix", version: "0" } },
    },
  });
  expect(init.statusCode, `initialize failed for ${label}`).toBe(200);
  const sessionId = init.headers["mcp-session-id"] as string;
  expect(sessionId, `no session id for ${label}`).toBeTruthy();
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...auth, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  let id = 1;
  return {
    label,
    sessionId,
    call: async (name, args = {}) => {
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { ...auth, "mcp-session-id": sessionId },
        payload: { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } },
      });
      return { statusCode: res.statusCode, result: res.statusCode === 200 ? jsonRpcBody(res.payload).result : undefined };
    },
  };
}

/** The transport that a caller with NO credential can actually reach. */
async function callWithoutCredential(name: string, args: Record<string, unknown> = {}) {
  const res = await app.inject({ method: "POST", url: "/mcp/call", payload: { name, arguments: args } });
  return { statusCode: res.statusCode, body: res.json() as { content?: { text?: string }[]; isError?: boolean } };
}

function toolText(result: any): string {
  return String(result?.content?.[0]?.text ?? "");
}

/**
 * ONE schema-valid payload per tool, keyed by name.
 *
 * These are NOT a substitute for registry derivation — the tool LIST is still
 * the registry, and `describe("tool registry")` below asserts that every
 * registered tool's payload actually satisfies that tool's own Zod schema, so
 * a tool added later fails the suite loudly until its payload is supplied
 * rather than being silently skipped.
 *
 * They are required because the MCP SDK validates `inputSchema` at the
 * protocol layer BEFORE it invokes the registered callback, so a call with
 * missing arguments never reaches `assertToolAllowed` at all over
 * `POST /mcp` — it comes back as JSON-RPC -32602 and would make a scope
 * assertion vacuous. See the "argument validation precedes the gate" test.
 *
 * Ids point at rows that do not exist, EXCEPT where the point is that the
 * write would have succeeded: `mark_notifications_read`, `claim_handle`,
 * `complete_onboarding`, `set_attribution_preference`, `report_issue` and
 * `delete_file` all carry payloads the tool would happily execute against
 * real fixtures on `denialUser`, which is what makes "nothing was written"
 * a real claim rather than a side effect of a bad argument.
 */
const NO_SUCH_ID = "scope-matrix-no-such-row";
const HEX64 = "a".repeat(64);

function argsFor(toolName: string): Record<string, unknown> {
  switch (toolName) {
    // public / catalog
    case "get_pool":
    case "get_pool_contract":
      return { bountyId: NO_SUCH_ID };

    // contribute
    case "submit_pool_items":
      return { bountyId: NO_SUCH_ID, items: [{ title: "scope-matrix probe", payloadJson: { probe: true } }] };
    case "revise_submission":
      return { submissionId: NO_SUCH_ID, payloadJson: { probe: true } };
    case "rerun_submission_validation":
      return { submissionId: NO_SUCH_ID };
    case "dispute_submission":
      return { submissionId: NO_SUCH_ID, argument: "scope-matrix denial probe argument" };
    case "create_upload_review_link":
      return { bountyId: NO_SUCH_ID, sourceArtifactId: NO_SUCH_ID, expectedItemCount: 1 };
    case "get_upload_review_status":
      return { draftId: NO_SUCH_ID };
    case "list_my_submissions":
      return {};

    // read
    case "check_submission":
      return { submissionId: NO_SUCH_ID };
    case "get_file_status":
    case "get_file_processing_checks":
      return { artifactId: NO_SUCH_ID };
    case "get_issue":
      return { issueId: NO_SUCH_ID };
    case "mark_notifications_read":
      return {}; // no id ⇒ mark ALL of the caller's notifications read

    // artifact
    case "prepare_file_upload":
      return { filename: "scope-matrix-probe.json", contentType: "application/json", sizeBytes: 32, checksumSha256: HEX64 };
    case "prepare_large_file_upload":
      return {
        filename: "scope-matrix-probe.bin",
        contentType: "application/octet-stream",
        totalSizeBytes: 1024,
        parts: [{ partNumber: 1, sizeBytes: 1024, checksumSha256Hex: HEX64 }],
      };
    case "complete_file_upload":
    case "abort_large_file_upload":
      return { artifactId: NO_SUCH_ID };
    case "complete_large_file_upload":
      return { artifactId: NO_SUCH_ID, parts: [{ partNumber: 1, etag: "scope-matrix" }] };
    case "delete_file":
      // A REAL artifact owned by denialUser: a leak here soft-deletes it.
      return { artifactId: denialArtifactId };

    // validate
    case "get_audit":
    case "claim_audit":
      return { windowId: NO_SUCH_ID };
    case "submit_decisions":
      return { windowId: NO_SUCH_ID, decisions: [{ auditItemId: NO_SUCH_ID, verdict: AuditVerdict.ok }] };

    // account
    case "suggest_handles":
      return { baseName: "scopematrix" };
    case "get_handle_availability":
      return { handle: "scopematrixprobe" };
    case "claim_handle":
      // A legal, free handle: a leak here rewrites denialUser's public identity.
      return { handle: `scopepwn${Math.random().toString(36).slice(2, 8)}` };
    case "complete_onboarding":
      return { persona: "validator" };
    case "set_attribution_preference":
      // UPDATED for the `profilePublic` -> `optOut` correction: this tool
      // writes the contributor's dataset-credit opt-out, not their profile
      // visibility. `true` is a real write on denialUser, which is what makes
      // "nothing was written" a claim about a leak rather than a no-op.
      return { optOut: true };
    case "reply_to_issue":
      return { issueId: NO_SUCH_ID, body: "scope-matrix denial probe" };
    case "report_issue":
      return {
        category: AgentIssueCategory.security_privacy,
        impact: AgentIssueImpact.blocked,
        summary: "scope-matrix denial probe — this row must never exist",
        expected: "the scope gate refuses this call",
        actual: "if this row exists, the gate let a write through",
        steps: "denial matrix",
      };

    // sponsor
    case "get_sponsor_submission_evidence":
      return { bountyId: NO_SUCH_ID };
    case "dispute_accepted_submission":
      return { submissionId: NO_SUCH_ID, reason: FlagReason.other, argument: "scope-matrix denial probe argument" };

    default:
      // Every remaining tool takes only optional arguments; the registry guard
      // below proves it rather than assuming it.
      return {};
  }
}

interface StateSnapshot {
  handle: string | null;
  onboarded: boolean;
  profilePublic: boolean;
  /** `set_attribution_preference` writes this (inside publicProfilePrefs),
   *  NOT profilePublic — so a leak through that tool would be invisible to a
   *  snapshot that only watched profilePublic. */
  attributionOptOut: boolean;
  persona: string | null;
  notificationRead: boolean;
  artifactStatus: string | null;
  issueCount: number;
  submissionCount: number;
  artifactCount: number;
}

async function snapshotState(userId: string): Promise<StateSnapshot> {
  const [user, notification, artifact, issueCount, submissionCount, artifactCount] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { handle: true, onboarded: true, profilePublic: true, persona: true, publicProfilePrefs: true },
    }),
    prisma.notification.findUniqueOrThrow({ where: { id: denialNotificationId }, select: { read: true } }),
    prisma.artifact.findUniqueOrThrow({ where: { id: denialArtifactId }, select: { status: true } }),
    prisma.agentIssue.count({ where: { reporterUserId: userId } }),
    prisma.submission.count({ where: { contributorUserId: userId } }),
    prisma.artifact.count({ where: { ownerUserId: userId } }),
  ]);
  return {
    handle: user.handle,
    onboarded: user.onboarded,
    profilePublic: user.profilePublic,
    attributionOptOut: parsePublicProfilePrefs(user.publicProfilePrefs).attributionOptOut,
    persona: user.persona === null || user.persona === undefined ? null : String(user.persona),
    notificationRead: notification.read,
    artifactStatus: artifact.status,
    issueCount,
    submissionCount,
    artifactCount,
  };
}

// ── fixtures ───────────────────────────────────────────────────────────────

let stateBeforeDenials: StateSnapshot;

beforeAll(async () => {
  // The global per-IP limiter is a BOOT-TIME read of `ratelimit.global.max`
  // (app.ts). This file issues several hundred requests from one IP, so raise
  // it before buildApp() and remove it in afterAll. The per-credential
  // limiter (300/min, read per call) is deliberately left real — no single
  // credential here comes close to it.
  process.env.RATELIMIT_GLOBAL_MAX = "100000";

  app = await buildApp();
  await app.ready();

  // Two auth-route calls total — inside AUTH_RATE_LIMIT's 10/min/IP budget.
  denialUser = await signupVerified("scopeden");
  positiveUser = await signupVerified("scopepos");

  // Created straight through Prisma so it costs no auth-route budget.
  const strangerHandle = `scopestranger${Math.random().toString(36).slice(2, 7)}`;
  const strangerEmail = `${strangerHandle}@example.com`;
  const strangerRow = await prisma.user.create({
    data: {
      email: strangerEmail,
      handle: strangerHandle,
      displayName: "Scope Stranger",
      authMethod: AuthMethod.email,
      passwordHash: "not-a-real-hash",
      emailVerifiedAt: new Date(),
      onboarded: true,
      profilePublic: true,
    },
    select: { id: true },
  });
  createdUserIds.push(strangerRow.id);
  stranger = { userId: strangerRow.id, email: strangerEmail, handle: strangerHandle };

  // Fixtures a successful write would visibly change.
  denialNotificationId = (
    await prisma.notification.create({
      data: {
        userId: denialUser.userId,
        type: "scope.matrix.probe",
        title: "scope matrix probe",
        body: "must stay unread through the denial sweep",
        eventKey: `scope-matrix-${denialUser.userId}`,
        read: false,
      },
      select: { id: true },
    })
  ).id;
  denialArtifactId = (
    await prisma.artifact.create({
      data: {
        kind: ArtifactKind.submission_attachment,
        status: ArtifactStatus.ready,
        ownerUserId: denialUser.userId,
        filename: "scope-matrix-probe.json",
        contentType: "application/json",
        storageKey: `scope-matrix/${denialUser.userId}/probe.json`,
      },
      select: { id: true },
    })
  ).id;

  // ── credentials, built once ──────────────────────────────────────────────
  for (const scope of MCP_SCOPES) {
    const allExcept = MCP_SCOPES.filter((s) => s !== scope);

    const key = await issueKeyViaRoute(denialUser.cookie, allExcept as unknown as ApiKeyScope[]);
    if (scope === "sponsor") sponsorlessRawKey = key;
    allExceptKeySession.set(scope, await openMcpSession(key, `apikey:all-except-${scope}`));

    // One dynamic client per scope set: `approveAuthorizationRequest` writes
    // the grant per (client, user), so reusing one client would rewrite the
    // previous grant's scopes.
    const clientId = await registerDynamicClient(`scope-matrix-except-${scope}`, `http://127.0.0.1:44201/cb-${scope}`);
    const accessToken = await oauthAccessToken({
      clientId,
      redirectUri: `http://127.0.0.1:44201/cb-${scope}`,
      scopes: allExcept as unknown as string[],
      cookie: denialUser.cookie,
    });
    allExceptOauthSession.set(scope, await openMcpSession(accessToken, `oauth:all-except-${scope}`));

    const exact = await issueKeyViaRoute(positiveUser.cookie, [scope] as unknown as ApiKeyScope[]);
    exactKeySession.set(scope, await openMcpSession(exact, `apikey:only-${scope}`));
  }

  // A credential with NO scopes at all. `POST /v1/me/api-keys` enforces
  // `.min(1)` on the request body, so this is minted through the real
  // `services/api-keys.ts` issuer the route itself calls — the same row shape,
  // the same hashing, the same verification path.
  const empty = await issueApiKeyDirect({ userId: denialUser.userId, scopes: [] });
  emptyScopeSession = await openMcpSession(empty.rawKey, "apikey:empty-scope");

  resetOnboardingCache();
  stateBeforeDenials = await snapshotState(denialUser.userId);
}, 180_000);

afterAll(async () => {
  if (createdUserIds.length) {
    await prisma.oAuthAuditEvent.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.agentIssue.deleteMany({ where: { reporterUserId: { in: createdUserIds } } });
    await prisma.artifact.deleteMany({ where: { ownerUserId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  if (registeredClientIds.length) {
    await prisma.oAuthAuditEvent.deleteMany({ where: { clientId: { in: registeredClientIds } } });
    await prisma.oAuthClient.deleteMany({ where: { clientId: { in: registeredClientIds } } });
  }

  delete process.env.RATELIMIT_GLOBAL_MAX;

  resetOnboardingCache();
  await app.close();
  await prisma.$disconnect();
}, 60_000);

// ══ 0. registry sanity — a typo'd scope must fail the suite ════════════════

describe("tool registry", () => {
  it("declares only real scopes, and nothing is registered twice", () => {
    expect(tools.length).toBeGreaterThan(0);

    const badScopes = tools
      .filter((t) => t.scope !== PUBLIC_SCOPE && !KNOWN_SCOPES.has(t.scope))
      .map((t) => `${t.name} → "${t.scope}"`);
    // A scope string that is not an ApiKeyScope can never appear on any
    // credential, so the tool is permanently uncallable; a scope that is a
    // *different* real scope hands it to the wrong credential. Either way the
    // registry is wrong, not the test.
    expect(badScopes, `tools declaring an unknown scope: ${badScopes.join(", ")}`).toEqual([]);

    const names = tools.map((t) => t.name);
    expect(new Set(names).size, `duplicate tool names: ${names.join(",")}`).toBe(names.length);
  });

  it("has a schema-valid probe payload for EVERY registered tool — a new tool cannot be silently skipped", () => {
    const invalid: string[] = [];
    for (const tool of tools) {
      const parsed = tool.schema.safeParse(argsFor(tool.name));
      if (!parsed.success) invalid.push(`${tool.name}: ${parsed.error.issues.map((i) => i.path.join(".")).join(",")}`);
    }
    // Without this, a tool added with new required arguments would be
    // "covered" by a call the MCP SDK rejects at -32602 before the scope gate
    // ever runs — a green test proving nothing. Add the payload in argsFor().
    expect(invalid, `tools with no schema-valid probe payload: ${invalid.join(" | ")}`).toEqual([]);
  });

  it("exposes at least one tool per declared scope so every credential path is exercised", () => {
    const covered = new Set(tools.map((t) => t.scope));
    for (const scope of MCP_SCOPES) {
      expect(covered.has(scope), `no tool declares the \`${scope}\` scope — that credential path is untested`).toBe(true);
    }
  });
});

// ══ 1. denial matrix — every scope except the declared one ═════════════════

describe("denial matrix: a credential holding every scope EXCEPT the tool's own", () => {
  const denied: string[] = [];

  it.each(GATED_TOOLS.map((t) => [t.name, t.scope] as const))(
    "refuses %s (scope %s) on an API key missing only that scope",
    async (name, scope) => {
      const session = allExceptKeySession.get(scope)!;
      expect(session, `no all-except-${scope} API key session`).toBeTruthy();
      const res = await session.call(name, argsFor(name));
      const text = toolText(res.result);
      expect(res.result?.isError, `${name} was NOT refused: ${text.slice(0, 300)}`).toBe(true);
      expect(text, `${name} refused for the wrong reason: ${text.slice(0, 300)}`).toMatch(SCOPE_REFUSAL);
      expect(text).toContain(scope);
      denied.push(name);
      markExercised("denial:apikey", name);
    },
  );

  it.each(GATED_TOOLS.map((t) => [t.name, t.scope] as const))(
    "refuses %s (scope %s) on an OAuth access token missing only that scope",
    async (name, scope) => {
      const session = allExceptOauthSession.get(scope)!;
      expect(session, `no all-except-${scope} OAuth session`).toBeTruthy();
      const res = await session.call(name, argsFor(name));
      const text = toolText(res.result);
      expect(res.result?.isError, `${name} was NOT refused: ${text.slice(0, 300)}`).toBe(true);
      expect(text, `${name} refused for the wrong reason: ${text.slice(0, 300)}`).toMatch(SCOPE_REFUSAL);
      expect(text).toContain(scope);
      markExercised("denial:oauth", name);
    },
  );

  it("covered every gated tool on both credential paths", () => {
    expect(new Set(denied)).toEqual(new Set(GATED_TOOLS.map((t) => t.name)));
  });

  it("wrote nothing: the account is byte-identical after the whole denial sweep", async () => {
    const after = await snapshotState(denialUser.userId);
    expect(after).toEqual(stateBeforeDenials);
    // Named explicitly so a failure says WHAT leaked, not just "objects differ".
    expect(after.notificationRead, "a read-scope denial still marked notifications read").toBe(false);
    expect(after.artifactStatus, "an artifact-scope denial still soft-deleted the artifact").toBe(ArtifactStatus.ready);
    expect(after.issueCount, "an account-scope denial still created an AgentIssue row").toBe(
      stateBeforeDenials.issueCount,
    );
    expect(after.handle, "an account-scope denial still rewrote the public handle").toBe(stateBeforeDenials.handle);
    expect(after.profilePublic, "an account-scope denial still flipped profile visibility").toBe(
      stateBeforeDenials.profilePublic,
    );
    expect(after.persona, "an account-scope denial still rewrote the persona").toBe(stateBeforeDenials.persona);
  });
});

// ══ 2. positive control — exactly the declared scope clears the gate ═══════

describe("positive control: a credential holding exactly the declared scope", () => {
  const reached: string[] = [];

  it.each(GATED_TOOLS.map((t) => [t.name, t.scope] as const))(
    "does not refuse %s for scope reasons when the credential carries %s",
    async (name, scope) => {
      const session = exactKeySession.get(scope)!;
      expect(session, `no only-${scope} session`).toBeTruthy();
      // Schema-valid arguments, so the call really does reach the gate. A
      // missing-fixture / verified-email / onboarding / domain failure is an
      // ACCEPTABLE outcome here; the single thing asserted is that the failure
      // is not the scope refusal, which is what prevents a mis-gated tool
      // hiding behind an unrelated error.
      const res = await session.call(name, argsFor(name));
      const text = toolText(res.result);
      expect(text, `${name} was refused for scope despite holding \`${scope}\`: ${text.slice(0, 300)}`).not.toMatch(
        SCOPE_REFUSAL,
      );
      expect(text, `${name} answered with an authentication refusal on a valid credential`).not.toMatch(
        /^Authentication required/i,
      );
      reached.push(name);
      markExercised("positive", name);
    },
  );

  it("covered every gated tool", () => {
    expect(new Set(reached)).toEqual(new Set(GATED_TOOLS.map((t) => t.name)));
  });
});

// ══ 3. no-credential control ══════════════════════════════════════════════

describe("no credential at all", () => {
  it("is rejected by the sessionful /mcp transport before any tool is reached", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: MCP_ACCEPT, "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "anon", version: "0" } },
      },
    });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers["www-authenticate"] ?? "")).toMatch(/Bearer/i);
  });

  it.each(GATED_TOOLS.map((t) => [t.name, t.scope] as const))(
    "refuses %s (scope %s) with no credential",
    async (name, scope) => {
      const { statusCode, body } = await callWithoutCredential(name, argsFor(name));
      const text = String(body.content?.[0]?.text ?? "");
      expect(body.isError, `${name} was reachable with NO credential: ${text.slice(0, 300)}`).toBe(true);
      expect(statusCode, `${name} refused with an unexpected status`).toBe(401);
      expect(text).toMatch(/Authentication required/i);
      expect(text).toContain(scope);
      markExercised("no-credential", name);
    },
  );

  it.each(PUBLIC_TOOLS.map((t) => [t.name] as const))(
    "lets the registry-declared public tool %s run with no credential",
    async (name) => {
      const { statusCode, body } = await callWithoutCredential(name, argsFor(name));
      const text = String(body.content?.[0]?.text ?? "");
      expect(statusCode, `${name} is declared public but answered ${statusCode}: ${text.slice(0, 200)}`).not.toBe(401);
      expect(text, `${name} is declared public but demanded a credential`).not.toMatch(/Authentication required/i);
      expect(text, `${name} is declared public but demanded a scope`).not.toMatch(SCOPE_REFUSAL);
      markExercised("public:anonymous", name);
    },
  );

  it.each(PUBLIC_TOOLS.map((t) => [t.name] as const))(
    "returns no owner-identifying data from public tool %s",
    async (name) => {
      const { body } = await callWithoutCredential(name, argsFor(name));
      const text = String(body.content?.[0]?.text ?? "");
      for (const secret of [
        denialUser.email,
        positiveUser.email,
        stranger.email,
        denialUser.handle,
        positiveUser.handle,
        stranger.handle,
      ]) {
        expect(text.toLowerCase(), `${name} leaked ${secret} to an unauthenticated caller`).not.toContain(
          secret.toLowerCase(),
        );
        markExercised("public:no-owner-data", name);
      }
      // Any email address at all in an unauthenticated payload is a finding,
      // not just one of ours.
      const emailLike = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
      expect(emailLike, `${name} returned email-shaped strings to an unauthenticated caller`).toEqual([]);
    },
  );
});

// ══ 4. empty-scope credential ═════════════════════════════════════════════

describe("a credential issued with an empty scope array", () => {
  it.each(GATED_TOOLS.map((t) => [t.name, t.scope] as const))(
    "refuses %s (needs %s)",
    async (name, scope) => {
      const res = await emptyScopeSession.call(name, argsFor(name));
      const text = toolText(res.result);
      expect(res.result?.isError, `${name} ran on a zero-scope credential: ${text.slice(0, 300)}`).toBe(true);
      expect(text, `${name} refused for the wrong reason on a zero-scope credential: ${text.slice(0, 300)}`).toMatch(
        SCOPE_REFUSAL,
      );
      expect(text).toContain(scope);
      markExercised("empty-scope", name);
    },
  );

  it("still resolves to a real account, so the refusal is the scope gate and not a broken credential", async () => {
    // `whoami` is `read`-scoped, so it is refused too — but by SCOPE, which is
    // exactly the distinction being asserted: an unusable credential would
    // fail with `invalid_token` at the transport instead, and the session
    // above would never have opened.
    expect(emptyScopeSession.sessionId).toBeTruthy();
  });
});

// ══ 4b. observed gate ordering on the real MCP transport ══════════════════

describe("the authorization gate precedes argument validation over POST /mcp", () => {
  // UPDATED — this block used to assert the OPPOSITE, recording the SDK's
  // protocol-layer `inputSchema` check running BEFORE the scope gate. That
  // divergence had two consequences: the -32602 refusal disclosed the tool's
  // required parameter names to a caller holding none of its scope, and
  // `recordMcpToolInvocation` never ran, so the unauthorized attempt left NO
  // audit row — the one hole in the "always recorded" claim. It is now closed
  // (`transport.ts` `disableSdkInputValidation`), so the assertions are
  // inverted to lock the corrected order in.
  it("refuses a scope-less caller on SCOPE, not on a schema error, even with no arguments at all", async () => {
    const session = allExceptKeySession.get("sponsor")!;
    const res = await session.call("get_sponsor_submission_evidence", {});
    const text = toolText(res.result);
    expect(res.result?.isError).toBe(true);
    expect(text).toMatch(SCOPE_REFUSAL);
    // No parameter-name disclosure to a caller that holds none of the scope.
    expect(text).not.toMatch(/-32602|Input validation error/i);
    expect(text).not.toContain("bountyId");
  });

  it("still rejects malformed arguments — for a caller that DOES hold the scope", async () => {
    const session = exactKeySession.get("sponsor")!;
    const res = await session.call("get_sponsor_submission_evidence", {});
    expect(res.result?.isError).toBe(true);
    // The tool's own Zod schema, applied inside the audited handler.
    expect(toolText(res.result)).toMatch(/bountyId|required|invalid/i);
  });

  it("writes an audit row for the unauthorized, malformed-argument attempt", async () => {
    // The point of the fix: the attempt is now RECORDED. Previously the SDK
    // answered -32602 before `makeToolHandler` ran, so `tool.invoked` never
    // fired for it.
    const countRows = async () => {
      const rows = await prisma.oAuthAuditEvent.findMany({ where: { action: "tool.invoked" }, select: { metadata: true } });
      return rows.filter((r) => {
        const m = r.metadata as { tool?: string; ok?: boolean } | null;
        return m?.tool === "get_sponsor_submission_evidence" && m?.ok === false;
      }).length;
    };
    const before = await countRows();
    const session = allExceptKeySession.get("sponsor")!;
    await session.call("get_sponsor_submission_evidence", {});
    // recordMcpToolInvocation is fire-and-forget; give it a beat to land.
    let after = before;
    for (let i = 0; i < 30 && after <= before; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      after = await countRows();
    }
    expect(after, "an unauthorized malformed-argument call left no audit row").toBeGreaterThan(before);
  });

  it("the legacy POST /mcp/call pair still refuses on scope first", async () => {
    const legacy = await app.inject({
      method: "POST",
      url: "/mcp/call",
      headers: { authorization: `Bearer ${sponsorlessRawKey}` },
      payload: { name: "get_sponsor_submission_evidence", arguments: {} },
    });
    expect(legacy.statusCode).toBe(403);
    expect(String(legacy.json().content?.[0]?.text ?? "")).toMatch(SCOPE_REFUSAL);
  });
});

// ══ 4c. is the DECLARED scope the RIGHT scope? ════════════════════════════

/**
 * Scope consistency (everything above) proves each tool is gated by the scope
 * it declares. It cannot catch a tool that declares the WRONG scope — a write
 * shipped under `read`, say, is perfectly "consistent" and hands an operator's
 * read-only agent a mutation. This block tests the property the scope names
 * promise, derived from the registry so it keeps holding as tools are added.
 */
describe("declared scope vs. what the tool actually does", () => {
  const READ_ONLY_TOOLS = tools.filter((t) => t.scope === "read");
  const PUBLIC_ONLY_TOOLS = PUBLIC_TOOLS;

  async function mutableState(userId: string, notificationId: string) {
    const [user, notification, unread, issues, artifacts, submissions] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { handle: true, onboarded: true, profilePublic: true, persona: true },
      }),
      prisma.notification.findUniqueOrThrow({ where: { id: notificationId }, select: { read: true } }),
      prisma.notification.count({ where: { userId, read: false } }),
      prisma.agentIssue.count({ where: { reporterUserId: userId } }),
      prisma.artifact.count({ where: { ownerUserId: userId, status: { not: ArtifactStatus.deleted } } }),
      prisma.submission.count({ where: { contributorUserId: userId } }),
    ]);
    return { ...user, persona: user.persona ?? null, read: notification.read, unread, issues, artifacts, submissions };
  }

  it("keeps every `read`-scoped tool a pure read — a read-only credential must not mutate anything", async () => {
    expect(READ_ONLY_TOOLS.length, "no read-scoped tools in the registry").toBeGreaterThan(0);

    const notification = await prisma.notification.create({
      data: {
        userId: positiveUser.userId,
        type: "scope.matrix.readonly.probe",
        title: "read-scope write probe",
        body: "a read-only credential must not be able to change this row",
        eventKey: `scope-matrix-readonly-${positiveUser.userId}`,
        read: false,
      },
      select: { id: true },
    });
    const before = await mutableState(positiveUser.userId, notification.id);

    const readOnly = exactKeySession.get("read")!;
    const ran: string[] = [];
    for (const tool of READ_ONLY_TOOLS) {
      await readOnly.call(tool.name, argsFor(tool.name));
      ran.push(tool.name);
    }
    expect(new Set(ran)).toEqual(new Set(READ_ONLY_TOOLS.map((t) => t.name)));

    const after = await mutableState(positiveUser.userId, notification.id);
    // If this fails, one of the tools named in `ran` is declared `read` but
    // writes. `read` is the scope an operator grants an agent for observation,
    // so a write under it is a privilege the operator never consented to. The
    // fix is the tool's `scope:` declaration, not this assertion.
    expect(after, `a read-only credential mutated state while calling: ${ran.join(", ")}`).toEqual(before);
  });

  it("keeps every `public` tool free of any account state, called with no credential at all", async () => {
    expect(PUBLIC_ONLY_TOOLS.length, "no public tools in the registry").toBeGreaterThan(0);

    const notification = await prisma.notification.create({
      data: {
        userId: positiveUser.userId,
        type: "scope.matrix.public.probe",
        title: "public-scope write probe",
        body: "an unauthenticated caller must not be able to change this row",
        eventKey: `scope-matrix-public-${positiveUser.userId}`,
        read: false,
      },
      select: { id: true },
    });
    const before = await mutableState(positiveUser.userId, notification.id);

    for (const tool of PUBLIC_ONLY_TOOLS) {
      await callWithoutCredential(tool.name, argsFor(tool.name));
    }

    const after = await mutableState(positiveUser.userId, notification.id);
    expect(after, "an unauthenticated call to a `public` tool mutated account state").toEqual(before);
  });
});

// ══ 5. coverage — the assertion that must fail loudly ═════════════════════

describe("matrix coverage", () => {
  it("covered every tool in the registry, with no silent skips", () => {
    const registrySize = tools.length;

    // Not a partition restatement: EXERCISED is written by the sweeps as they
    // run, so a tool the matrix never actually called is missing here.
    const uncovered = tools.map((t) => t.name).filter((name) => !EXERCISED.has(name));
    expect(uncovered, `tools the matrix never executed: ${uncovered.join(", ")}`).toEqual([]);
    expect(EXERCISED.size, `matrix executed ${EXERCISED.size} tools but the registry has ${registrySize}`).toBe(
      registrySize,
    );

    // …and each tool was exercised by EVERY sweep that applies to its scope.
    const missing: string[] = [];
    for (const tool of tools) {
      const expectedSweeps =
        tool.scope === PUBLIC_SCOPE
          ? ["public:anonymous", "public:no-owner-data"]
          : ["denial:apikey", "denial:oauth", "positive", "no-credential", "empty-scope"];
      const got = EXERCISED.get(tool.name) ?? new Set<string>();
      for (const sweep of expectedSweeps) if (!got.has(sweep)) missing.push(`${tool.name}/${sweep}`);
    }
    expect(missing, `tool/sweep pairs that did not run: ${missing.join(", ")}`).toEqual([]);

    // Registry partition is exhaustive: every tool is either public (2 sweeps:
    // callable-anonymously + no-owner-data) or gated (5 sweeps: API-key denial,
    // OAuth denial, positive control, no-credential, empty-scope). Asserted as
    // arithmetic on the registry itself so adding a tool without extending the
    // matrix cannot pass.
    expect(GATED_TOOLS.length + PUBLIC_TOOLS.length).toBe(registrySize);
    // eslint-disable-next-line no-console
    console.log(
      `[scope-matrix] registry=${registrySize} gated=${GATED_TOOLS.length} public=${PUBLIC_TOOLS.length} ` +
        `cases=${GATED_TOOLS.length * 5 + PUBLIC_TOOLS.length * 2}`,
    );
  });

  it("built one credential pair per scope, so no tool was matched against a credential it shares with another scope", () => {
    for (const scope of MCP_SCOPES) {
      expect(allExceptKeySession.has(scope), `missing all-except-${scope} API key`).toBe(true);
      expect(allExceptOauthSession.has(scope), `missing all-except-${scope} OAuth token`).toBe(true);
      expect(exactKeySession.has(scope), `missing only-${scope} API key`).toBe(true);
    }
    const sessionIds = [
      ...[...allExceptKeySession.values()].map((s) => s.sessionId),
      ...[...allExceptOauthSession.values()].map((s) => s.sessionId),
      ...[...exactKeySession.values()].map((s) => s.sessionId),
      emptyScopeSession.sessionId,
    ];
    expect(new Set(sessionIds).size, "two credentials shared one MCP session").toBe(sessionIds.length);
  });
});
