// SPDX-License-Identifier: Apache-2.0

/**
 * SEC-09 regression suite — a suspended owner must not retain upload-draft
 * capability access.
 *
 * The finding: `draftOwner()` reconstructed an actor straight from the owner
 * row with no account-status check, and the draft-scoped-token branch of
 * `resolveDraftAccess()` used that actor instead of the ordinary active-user
 * session guard. Executed evidence
 * (`docs/private/operations/community-security-evidence/restart-extra-api-results.json`,
 * check `suspended-draft-capability`): a valid, unexpired capability for a
 * dummy owner's draft still worked after the account was suspended — read and
 * cancel both returned 200 and the draft row actually became `cancelled` —
 * while the same owner's ordinary session was correctly rejected with 401.
 *
 * How this file tests it: the REAL route module is loaded and registered on a
 * real Fastify instance and driven with `app.inject()`. Everything the route
 * imports is replaced with an explicit in-memory double — no Postgres, no
 * storage driver, no network, no `.env`. Same doubling approach as
 * `artifacts.upload-immutability.test.ts`.
 *
 * The doubles are test doubles, not product code: the `prisma` double
 * re-implements only the `where` clauses these routes actually use (including
 * conditional-update matching, which the cancel path's race safety relies on),
 * and nothing here asserts on real database, bounty-contract or job-queue
 * behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";

const ACCESS_TOKEN = "a".repeat(64);
const HANDOFF_TOKEN = "b".repeat(64);
const OTHER_DRAFT_ID = "draft_other";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type DraftRow = {
  id: string;
  ownerUserId: string;
  targetKind: string;
  bountyId: string | null;
  contributorBatchId: string | null;
  generationMethod: string;
  expectedItemCount: number | null;
  sourceDescription: string | null;
  autoSubmitAuthorizedAt: Date | null;
  status: string;
  sourceArtifactId: string | null;
  previewSummary: unknown;
  tokenHash: string;
  tokenExpiresAt: Date;
  accessTokenHash: string | null;
  redeemedAt: Date | null;
  revokedAt: Date | null;
  draftExpiresAt: Date;
  submittedAt: Date | null;
  updatedAt: Date;
};

function baseDraft(): DraftRow {
  const now = Date.now();
  return {
    id: "draft_1",
    ownerUserId: "owner-1",
    targetKind: "community_pool",
    bountyId: "bounty-1",
    contributorBatchId: null,
    generationMethod: "human",
    expectedItemCount: 10,
    sourceDescription: null,
    autoSubmitAuthorizedAt: null,
    status: "awaiting_upload",
    sourceArtifactId: null,
    previewSummary: null,
    tokenHash: sha256(HANDOFF_TOKEN),
    tokenExpiresAt: new Date(now + 60 * 60 * 1000),
    accessTokenHash: sha256(ACCESS_TOKEN),
    redeemedAt: new Date(now - 60 * 1000),
    revokedAt: null,
    draftExpiresAt: new Date(now + 24 * 60 * 60 * 1000),
    submittedAt: null,
    updatedAt: new Date(now - 60 * 1000),
  };
}

/** Mutable test state, reset per test. */
const state: {
  draft: DraftRow;
  /** The owner row's `User.status`. `UserStatus` has exactly two members. */
  ownerStatus: "active" | "suspended";
  ownerEmailVerifiedAt: Date | null;
  /** How many usable (errorCode: null) SubmissionUploadDraftItem rows this
   * draft has — the route's `POST /:id/submit` now counts these to refuse an
   * empty ingest. Defaults to 1 so the happy-path submit test (which sets
   * `draft.status` to "review_ready" itself) has something to claim. */
  usableDraftItemCount: number;
  /** What `getAuthedUser` returns — the ordinary dashboard-session path. */
  sessionUser: { id: string; email: string | null; displayName: string; roles: string[]; emailVerifiedAt: Date | null; apiKeyScopes?: string[]; credentialKind?: string } | null;
} = {
  draft: baseDraft(),
  ownerStatus: "active",
  ownerEmailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
  usableDraftItemCount: 1,
  sessionUser: null,
};

const noop = async () => {};

vi.mock("../../lib/rbac.js", () => ({
  requireAuth: noop,
  requireVerifiedEmail: noop,
  requireRole: () => noop,
  requireScope: () => noop,
  requireAnyScope: () => noop,
  getAuthedUser: async () => state.sessionUser,
}));

vi.mock("../../config.js", () => ({ config: { appUrl: "https://app.test" } }));

vi.mock("../../services/artifacts.js", () => ({
  getArtifactById: async () => null,
  completeUpload: async () => {
    throw new Error("not exercised");
  },
  createUploadSlot: async () => ({
    artifactId: "art_new",
    upload: { url: "/v1/artifacts/art_new/content", method: "POST", headers: {} },
  }),
}));

vi.mock("../../services/bounties.js", () => ({
  getPoolContractForBounty: async () => ({
    sourceUpload: {
      profile: "jsonl",
      version: 1,
      extensions: [".jsonl"],
      mimeTypes: ["application/x-ndjson"],
      accept: ".jsonl",
      available: true,
    },
  }),
}));

vi.mock("../../services/jobs/bulk-source-parse.js", () => ({ enqueueBulkSourceParse: noop }));
vi.mock("../../services/jobs/upload-draft-submit.js", () => ({ enqueueUploadDraftSubmit: noop }));

vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    user: {
      // Only the two shapes the route asks for: the full owner row (with
      // roles) in draftOwner(), and the status-only select at redemption.
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (where.id !== state.draft.ownerUserId) return null;
        return {
          id: state.draft.ownerUserId,
          email: "owner@test.invalid",
          displayName: "Owner",
          status: state.ownerStatus,
          emailVerifiedAt: state.ownerEmailVerifiedAt,
          roles: [],
        };
      },
    },
    bounty: { findUnique: async () => null },
    artifact: { findFirst: async () => null },
    submissionUploadDraftItem: {
      findMany: async () => [],
      count: async () => state.usableDraftItemCount,
    },
    submissionUploadDraft: {
      findUnique: async ({ where }: { where: { tokenHash?: string; id?: string } }) => {
        if (where.tokenHash !== undefined) return where.tokenHash === state.draft.tokenHash ? { ...state.draft } : null;
        return where.id === state.draft.id ? { ...state.draft } : null;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        if (where.id !== state.draft.id) throw new Error("no such draft");
        return { ...state.draft };
      },
      // The two `where` shapes resolveDraftAccess() uses: the token branch
      // (accessTokenHash + revokedAt) and the session branch (id +
      // ownerUserId + revokedAt). Draft-id and expiry checks live in the
      // route, so they are deliberately NOT re-implemented here.
      findFirst: async ({ where }: { where: { accessTokenHash?: string; id?: string; ownerUserId?: string; revokedAt?: null } }) => {
        const row = state.draft;
        if (where.revokedAt === null && row.revokedAt !== null) return null;
        if (where.accessTokenHash !== undefined) {
          return row.accessTokenHash !== null && where.accessTokenHash === row.accessTokenHash ? { ...row } : null;
        }
        if (where.id !== undefined && where.id !== row.id) return null;
        if (where.ownerUserId !== undefined && where.ownerUserId !== row.ownerUserId) return null;
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<DraftRow> }) => {
        if (where.id !== state.draft.id) throw new Error("no such draft");
        Object.assign(state.draft, data);
        return { ...state.draft };
      },
      // Conditional-update matching — the mechanism cancel's race safety and
      // redeem's single-use guarantee both rely on. A non-match writes
      // nothing and reports count 0.
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          id?: string;
          ownerUserId?: string;
          revokedAt?: null;
          redeemedAt?: null;
          sourceArtifactId?: null;
          status?: string;
          tokenExpiresAt?: { gt: Date };
          draftExpiresAt?: { gt: Date };
          OR?: { status?: string | { not: string }; updatedAt?: { lt: Date } }[];
        };
        data: Partial<DraftRow>;
      }) => {
        const row = state.draft;
        if (where.id !== undefined && where.id !== row.id) return { count: 0 };
        if (where.ownerUserId !== undefined && where.ownerUserId !== row.ownerUserId) return { count: 0 };
        if (where.revokedAt === null && row.revokedAt !== null) return { count: 0 };
        if (where.redeemedAt === null && row.redeemedAt !== null) return { count: 0 };
        if (where.sourceArtifactId === null && row.sourceArtifactId !== null) return { count: 0 };
        if (typeof where.status === "string" && row.status !== where.status) return { count: 0 };
        if (where.tokenExpiresAt?.gt && row.tokenExpiresAt.getTime() <= where.tokenExpiresAt.gt.getTime()) return { count: 0 };
        if (where.draftExpiresAt?.gt && row.draftExpiresAt.getTime() <= where.draftExpiresAt.gt.getTime()) return { count: 0 };
        if (where.OR) {
          const matchesClause = (clause: { status?: string | { not: string }; updatedAt?: { lt: Date } }) => {
            if (typeof clause.status === "string" && row.status !== clause.status) return false;
            if (clause.status && typeof clause.status === "object" && row.status === clause.status.not) return false;
            if (clause.updatedAt?.lt && row.updatedAt.getTime() >= clause.updatedAt.lt.getTime()) return false;
            return true;
          };
          if (!where.OR.some(matchesClause)) return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  },
}));

const { uploadReviewDraftRoutes } = await import("./upload-review-drafts.js");

let app: FastifyInstance;

beforeEach(async () => {
  state.draft = baseDraft();
  state.ownerStatus = "active";
  state.ownerEmailVerifiedAt = new Date("2026-01-01T00:00:00.000Z");
  state.usableDraftItemCount = 1;
  state.sessionUser = null;
  app = Fastify();
  await app.register(import("@fastify/sensible"));
  await app.register(uploadReviewDraftRoutes, { prefix: "/v1/upload-review-drafts" });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function withToken(method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { "x-upload-draft-token": ACCESS_TOKEN },
    ...(method === "POST" ? { payload: payload ?? {} } : {}),
  });
}

const base = "/v1/upload-review-drafts";

describe("SEC-09 · a suspended owner's draft capability is refused on every action", () => {
  const actions: [string, () => ReturnType<typeof withToken>][] = [
    ["read", () => withToken("GET", `${base}/draft_1`)],
    ["rejected-rows", () => withToken("GET", `${base}/draft_1/rejected-rows`)],
    ["cancel", () => withToken("POST", `${base}/draft_1/cancel`)],
    ["upload (source-slot)", () => withToken("POST", `${base}/draft_1/source-slot`, { filename: "rows.jsonl", contentType: "application/x-ndjson" })],
    ["upload (attach-source)", () => withToken("POST", `${base}/draft_1/attach-source`, { artifactId: "art_x" })],
    ["upload (source-complete)", () => withToken("POST", `${base}/draft_1/source-complete`, { artifactId: "art_x" })],
    ["submit", () => withToken("POST", `${base}/draft_1/submit`)],
  ];

  for (const [name, call] of actions) {
    it(`refuses ${name} with 403 ACCOUNT_SUSPENDED`, async () => {
      state.ownerStatus = "suspended";
      const res = await call();
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("ACCOUNT_SUSPENDED");
    });
  }

  it("leaves the draft row untouched — cancel no longer mutates it", async () => {
    state.ownerStatus = "suspended";
    const res = await withToken("POST", `${base}/draft_1/cancel`);
    expect(res.statusCode).toBe(403);
    // The executed finding's exact symptom: the row became `cancelled`.
    expect(state.draft.status).toBe("awaiting_upload");
    expect(state.draft.revokedAt).toBeNull();
    expect(state.draft.accessTokenHash).toBe(sha256(ACCESS_TOKEN));
  });

  it("does not mark the draft submitted", async () => {
    state.ownerStatus = "suspended";
    const res = await withToken("POST", `${base}/draft_1/submit`);
    expect(res.statusCode).toBe(403);
    expect(state.draft.status).toBe("awaiting_upload");
    expect(state.draft.submittedAt).toBeNull();
  });

  it("refuses redemption of an unredeemed handoff link (as a plain 404, no metadata)", async () => {
    state.draft.redeemedAt = null;
    state.draft.accessTokenHash = null;
    state.ownerStatus = "suspended";
    const res = await app.inject({ method: "POST", url: `${base}/redeem`, payload: { token: HANDOFF_TOKEN } });
    expect(res.statusCode).toBe(404);
    // The link must still be unspent, not burned by the refused attempt.
    expect(state.draft.redeemedAt).toBeNull();
    expect(state.draft.accessTokenHash).toBeNull();
  });
});

describe("SEC-09 · an active owner keeps the intended behaviour", () => {
  it("reads the draft over the capability token", async () => {
    const res = await withToken("GET", `${base}/draft_1`);
    expect(res.statusCode).toBe(200);
    expect(res.json().draft.id).toBe("draft_1");
  });

  it("cancels the draft and burns the capability", async () => {
    const res = await withToken("POST", `${base}/draft_1/cancel`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cancelled: true, draftId: "draft_1" });
    expect(state.draft.status).toBe("cancelled");
    expect(state.draft.accessTokenHash).toBeNull();
  });

  it("submits the draft", async () => {
    // POST /:id/submit now only claims a review-ready draft with usable rows
    // into "submitting" and enqueues the real async ingest job (see
    // services/jobs/upload-draft-submit.ts, mocked above) — it no longer
    // creates Submission rows or reaches "submitted" synchronously.
    state.draft.status = "review_ready";
    const res = await withToken("POST", `${base}/draft_1/submit`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ submitted: false, submitting: true, draftId: "draft_1", count: 1 });
    expect(state.draft.status).toBe("submitting");
  });

  it("gets past the eligibility gate on source-slot", async () => {
    const res = await withToken("POST", `${base}/draft_1/source-slot`, {
      filename: "rows.jsonl",
      contentType: "application/x-ndjson",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().artifactId).toBe("art_new");
  });

  it("redeems an unredeemed handoff link", async () => {
    state.draft.redeemedAt = null;
    state.draft.accessTokenHash = null;
    const res = await app.inject({ method: "POST", url: `${base}/redeem`, payload: { token: HANDOFF_TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(res.json().draftId).toBe("draft_1");
    expect(state.draft.redeemedAt).not.toBeNull();
  });

  it("still applies the owner email-verification gate", async () => {
    state.ownerEmailVerifiedAt = null;
    const res = await withToken("POST", `${base}/draft_1/submit`);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("EMAIL_UNVERIFIED");
  });
});

describe("SEC-09 · the pre-existing token protections are unchanged", () => {
  it("404s an expired draft even for an active owner", async () => {
    state.draft.draftExpiresAt = new Date(Date.now() - 1000);
    const res = await withToken("GET", `${base}/draft_1`);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("DRAFT_NOT_FOUND");
  });

  it("404s a valid token pointed at a different draft id", async () => {
    const res = await withToken("GET", `${base}/${OTHER_DRAFT_ID}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("DRAFT_NOT_FOUND");
  });

  it("404s an expired handoff link at redemption", async () => {
    state.draft.redeemedAt = null;
    state.draft.accessTokenHash = null;
    state.draft.tokenExpiresAt = new Date(Date.now() - 1000);
    const res = await app.inject({ method: "POST", url: `${base}/redeem`, payload: { token: HANDOFF_TOKEN } });
    expect(res.statusCode).toBe(404);
    expect(state.draft.redeemedAt).toBeNull();
  });

  it("401s when no credential is presented at all", async () => {
    const res = await app.inject({ method: "GET", url: `${base}/draft_1` });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("NO_CREDENTIAL");
  });

  it("401s the suspended owner's ordinary session (unchanged: getAuthedUser already rejects it)", async () => {
    state.ownerStatus = "suspended";
    state.sessionUser = null; // lib/session.ts / lib/rbac.ts return null for a non-active user
    const res = await app.inject({ method: "GET", url: `${base}/draft_1` });
    expect(res.statusCode).toBe(401);
  });

  it("still serves the active owner's ordinary session", async () => {
    state.sessionUser = {
      id: "owner-1",
      email: "owner@test.invalid",
      displayName: "Owner",
      roles: [],
      emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      credentialKind: "session",
    };
    const res = await app.inject({ method: "GET", url: `${base}/draft_1` });
    expect(res.statusCode).toBe(200);
    expect(res.json().draft.id).toBe("draft_1");
  });
});
