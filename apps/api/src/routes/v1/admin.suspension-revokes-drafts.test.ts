// SPDX-License-Identifier: Apache-2.0

/**
 * SEC-09 follow-up, route-level regression for `POST /v1/admin/users/:id/restrict`.
 *
 * The read side (`routes/v1/upload-review-drafts.ts`) already refuses a
 * non-active owner. This file proves the WRITE side: suspending a user revokes
 * that user's still-live upload-review-draft capabilities in the SAME
 * transaction as the status flip, leaves finished drafts alone, records the
 * count in the existing audit entry, and re-activation never un-revokes.
 *
 * HERMETIC BY DESIGN: real Fastify routing and the real route handler, with
 * `prisma`, `rbac` and every service `admin.ts` imports as explicit doubles.
 * No PostgreSQL, no network. The transaction double records every write made
 * through the `tx` client and rolls the in-memory store back when the
 * callback throws, so atomicity is asserted through the code path that relies
 * on it rather than by a real database.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";

const H = vi.hoisted(() => {
  interface Row {
    [key: string]: unknown;
  }
  interface DraftRow extends Row {
    id: string;
    ownerUserId: string;
    status: string;
    revokedAt: Date | null;
    accessTokenHash: string | null;
    tokenHash: string;
  }

  const state = {
    users: [] as Row[],
    drafts: [] as DraftRow[],
    audit: [] as Row[],
    /** Every write issued through the transaction client, in order. */
    txWrites: [] as string[],
    /** When set, the draft revoke throws — used to prove rollback. */
    failDraftUpdateMany: false,
    /** The user id `requireRole` resolves for the `x-test-actor` header. */
    actorRoles: ["admin"] as string[],
  };

  function clone<T>(value: T): T {
    return structuredClone(value);
  }

  function matchesDraft(row: DraftRow, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, cond]) => {
      const actual = row[key] ?? null;
      if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as { notIn?: unknown[]; in?: unknown[]; not?: unknown };
        if (c.notIn) return !c.notIn.includes(actual);
        if (c.in) return c.in.includes(actual);
        if ("not" in c) return actual !== c.not;
        throw new Error(`Unsupported where operator on ${key}: ${JSON.stringify(cond)}`);
      }
      return actual === (cond ?? null);
    });
  }

  const userDelegate = {
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = state.users.find((u) => u.id === where.id);
      if (!row) throw new Error("Row not found");
      Object.assign(row, data);
      state.txWrites.push(`user.update:${where.id}:${String(data.status)}`);
      return clone(row);
    },
  };

  const draftDelegate = {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      state.txWrites.push(`submissionUploadDraft.updateMany:${String(where.ownerUserId)}`);
      if (state.failDraftUpdateMany) throw new Error("simulated draft write failure");
      let count = 0;
      for (const row of state.drafts) {
        if (!matchesDraft(row, where)) continue;
        Object.assign(row, data);
        count += 1;
      }
      return { count };
    },
  };

  const txClient = { user: userDelegate, submissionUploadDraft: draftDelegate };

  const prismaMock: Record<string, unknown> = {
    user: userDelegate,
    submissionUploadDraft: draftDelegate,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = { users: clone(state.users), drafts: clone(state.drafts), audit: clone(state.audit) };
      try {
        return await fn(txClient);
      } catch (err) {
        state.users = snapshot.users;
        state.drafts = snapshot.drafts;
        state.audit = snapshot.audit;
        throw err;
      }
    },
  };

  return { state, prismaMock, txClient };
});

const { state, prismaMock, txClient } = H;

vi.mock("../../config.js", () => ({ config: { isProd: false } }));
vi.mock("../../lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../../lib/rbac.js", () => ({
  ADMIN_ONLY: ["admin"],
  ADMIN_AND_MEMBER: ["admin", "member"],
  ADMIN_AND_ABOVE_READONLY: ["admin", "member", "support"],
  requireRole:
    (...roles: string[]) =>
    async (req: { headers: Record<string, string | string[] | undefined> }, reply: { unauthorized: (m: string) => unknown; forbidden: (m: string) => unknown }) => {
      const actor = req.headers["x-test-actor"];
      if (typeof actor !== "string") return reply.unauthorized("Sign in required");
      if (!roles.some((r) => state.actorRoles.includes(r))) return reply.forbidden("Requires role");
      (req as unknown as { authedUser: unknown }).authedUser = { id: actor, roles: state.actorRoles, displayName: "Dummy Admin" };
    },
}));
vi.mock("../../lib/audit-log.js", () => ({
  writeAuditLog: async (tx: unknown, entry: Record<string, unknown>) => {
    if (tx !== txClient) throw new Error("writeAuditLog was called outside the transaction client");
    state.txWrites.push(`auditLog:${String(entry.action)}`);
    state.audit.push(entry);
  },
  verifyAuditChainIntegrity: async () => ({ ok: true }),
}));
vi.mock("../../services/admin-settings.js", () => ({
  listAdminSettingsForApi: async () => [],
  setAdminSetting: async () => {},
  getAdminSettingHistory: async () => [],
  validateAdminSettingValue: () => ({ ok: true }),
}));
vi.mock("../../services/api-keys.js", () => ({
  adminListApiKeys: async () => [],
  adminRevokeApiKey: async () => {},
  adminCountActiveApiKeys: async () => 0,
}));
vi.mock("../../lib/admin-invite.js", () => ({ createAdminInvite: async () => "dummy" }));
vi.mock("../../lib/auth-notify.js", () => ({ sendAdminInviteEmail: async () => {} }));
vi.mock("../../services/badges.js", () => ({ grantBadge: async () => {}, revokeBadge: async () => {} }));
vi.mock("../../services/karma.js", () => ({ reverseAcceptedSubmissionKarma: async () => {} }));
vi.mock("../../services/karma-holds.js", () => ({ awardOrHoldAcceptedItemKarma: async () => {} }));
vi.mock("../../services/audit-routing.js", () => ({
  createWindowAuditBatch: async () => {},
  reopenAuditItemForReview: async () => {},
}));
vi.mock("../../services/notifications.js", () => ({
  notifyEvent: async () => {},
  subscribeAdminNotificationStream: () => () => {},
}));
vi.mock("../../services/admin-quality-metrics.js", () => ({ getCommunityQualityMetrics: async () => ({}) }));
vi.mock("../../services/submission-acceptance.js", () => ({ recomputeAcceptedItemCounters: async () => {} }));

// The real helper is exercised — it is the write under test.
const { adminRoutes } = await import("./admin.js");

let app: FastifyInstance;

async function buildTestApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(sensible);
  await instance.register(adminRoutes, { prefix: "/v1/admin" });
  await instance.ready();
  return instance;
}

const OWNER = "user_owner";
const OTHER = "user_other";
const ADMIN = "user_admin";

function seedDraft(id: string, ownerUserId: string, status: string, overrides: Partial<(typeof state.drafts)[number]> = {}) {
  state.drafts.push({
    id,
    ownerUserId,
    status,
    revokedAt: null,
    accessTokenHash: `hash_${id}`,
    tokenHash: `handoff_${id}`,
    ...overrides,
  });
}

function draft(id: string) {
  const row = state.drafts.find((d) => d.id === id);
  if (!row) throw new Error(`missing draft ${id}`);
  return row;
}

async function restrict(id: string, body: Record<string, unknown>, actor: string | null = ADMIN) {
  return app.inject({
    method: "POST",
    url: `/v1/admin/users/${id}/restrict`,
    headers: actor ? { "x-test-actor": actor } : {},
    payload: body,
  });
}

beforeEach(async () => {
  state.users = [
    { id: OWNER, status: "active" },
    { id: OTHER, status: "active" },
    { id: ADMIN, status: "active" },
  ];
  state.drafts = [];
  state.audit = [];
  state.txWrites = [];
  state.failDraftUpdateMany = false;
  state.actorRoles = ["admin"];
  if (app) await app.close();
  app = await buildTestApp();
});

describe("POST /v1/admin/users/:id/restrict — SEC-09 write side", () => {
  it("suspending revokes the owner's live drafts and leaves cancelled/submitted ones and other owners alone", async () => {
    seedDraft("d_awaiting", OWNER, "awaiting_upload", { accessTokenHash: null }); // minted, not yet redeemed
    seedDraft("d_uploading", OWNER, "uploading");
    seedDraft("d_ready", OWNER, "ready");
    seedDraft("d_submitting", OWNER, "submitting");
    seedDraft("d_cancelled", OWNER, "cancelled", { revokedAt: new Date("2026-09-01T00:00:00Z"), accessTokenHash: null });
    seedDraft("d_submitted", OWNER, "submitted", { accessTokenHash: null });
    seedDraft("d_other_live", OTHER, "ready");

    const res = await restrict(OWNER, { status: "suspended", reason: "abuse" });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(json.user.status).toBe("suspended");
    // QA 2026-09-05 (P1): the route used to echo the raw Prisma row. The
    // response must be a projection — never the hash, the Google subject or
    // any other internal column.
    // The Prisma double here returns a partial row, so assert containment
    // rather than equality: every key must be in the allowed projection.
    const allowed = new Set(["displayName", "email", "handle", "id", "status"]);
    expect(Object.keys(json.user).every((k) => allowed.has(k))).toBe(true);
    expect(json.user).not.toHaveProperty("passwordHash");
    expect(json.user).not.toHaveProperty("googleId");
    expect(JSON.stringify(json)).not.toMatch(/\$2[aby]\$/);
    expect(json.revokedUploadDrafts).toBe(4);

    for (const id of ["d_awaiting", "d_uploading", "d_ready", "d_submitting"]) {
      expect(draft(id).revokedAt, id).toBeInstanceOf(Date);
      expect(draft(id).accessTokenHash, id).toBeNull();
      // Data stays: the row is not cancelled, deleted or otherwise re-statused.
      expect(draft(id).status, id).not.toBe("cancelled");
    }
    expect(draft("d_cancelled").revokedAt).toEqual(new Date("2026-09-01T00:00:00Z"));
    expect(draft("d_submitted").revokedAt).toBeNull();
    expect(draft("d_other_live").revokedAt).toBeNull();
    expect(draft("d_other_live").accessTokenHash).toBe("hash_d_other_live");
    expect(state.drafts).toHaveLength(7);

    // The existing audit entry carries the count — no new mechanism.
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]).toMatchObject({
      action: "admin.user.suspended",
      targetType: "user",
      targetId: OWNER,
      metadata: { reason: "abuse", revokedUploadDrafts: 4 },
    });
  });

  it("performs the status flip, the draft revoke and the audit write on the same transaction client", async () => {
    seedDraft("d_ready", OWNER, "ready");
    const res = await restrict(OWNER, { status: "suspended" });
    expect(res.statusCode).toBe(200);
    expect(state.txWrites).toEqual([
      `user.update:${OWNER}:suspended`,
      `submissionUploadDraft.updateMany:${OWNER}`,
      "auditLog:admin.user.suspended",
    ]);
  });

  it("rolls the status change back when the draft revoke fails (atomicity)", async () => {
    seedDraft("d_ready", OWNER, "ready");
    state.failDraftUpdateMany = true;

    const res = await restrict(OWNER, { status: "suspended" });
    expect(res.statusCode).toBe(500);
    expect(state.users.find((u) => u.id === OWNER)?.status).toBe("active");
    expect(draft("d_ready").revokedAt).toBeNull();
    expect(draft("d_ready").accessTokenHash).toBe("hash_d_ready");
    expect(state.audit).toHaveLength(0);
    // The status write was attempted and then discarded with the transaction.
    expect(state.txWrites).toEqual([`user.update:${OWNER}:suspended`, `submissionUploadDraft.updateMany:${OWNER}`]);
  });

  it("re-activation does not un-revoke and does not touch drafts at all", async () => {
    seedDraft("d_ready", OWNER, "ready");
    seedDraft("d_fresh", OWNER, "awaiting_upload", { accessTokenHash: null });
    const suspend = await restrict(OWNER, { status: "suspended" });
    expect(suspend.statusCode).toBe(200);
    const revokedAt = draft("d_ready").revokedAt;
    expect(revokedAt).toBeInstanceOf(Date);
    state.txWrites = [];

    const reactivate = await restrict(OWNER, { status: "active" });
    expect(reactivate.statusCode).toBe(200);
    expect(reactivate.json().user.status).toBe("active");
    expect(reactivate.json().revokedUploadDrafts).toBe(0);

    expect(draft("d_ready").revokedAt).toEqual(revokedAt);
    expect(draft("d_ready").accessTokenHash).toBeNull();
    expect(draft("d_fresh").revokedAt).toBeInstanceOf(Date);
    expect(state.txWrites).toEqual([`user.update:${OWNER}:active`, "auditLog:admin.user.activated"]);
    expect(state.audit[1]).toMatchObject({
      action: "admin.user.activated",
      metadata: { revokedUploadDrafts: 0 },
    });
  });

  it("an activate call on an already-active user is a no-op for drafts", async () => {
    seedDraft("d_ready", OWNER, "ready");
    const res = await restrict(OWNER, { status: "active", reason: "noop" });
    expect(res.statusCode).toBe(200);
    expect(draft("d_ready").revokedAt).toBeNull();
    expect(draft("d_ready").accessTokenHash).toBe("hash_d_ready");
    expect(state.txWrites.some((w) => w.startsWith("submissionUploadDraft"))).toBe(false);
  });

  it("rejects a status outside the real UserStatus enum with 400 before any write", async () => {
    seedDraft("d_ready", OWNER, "ready");
    const res = await restrict(OWNER, { status: "closed" });
    expect(res.statusCode).toBe(400);
    expect(state.txWrites).toEqual([]);
    expect(state.users.find((u) => u.id === OWNER)?.status).toBe("active");
    expect(draft("d_ready").revokedAt).toBeNull();
  });

  it("requires an admin-or-member dashboard session", async () => {
    seedDraft("d_ready", OWNER, "ready");
    const anon = await restrict(OWNER, { status: "suspended" }, null);
    expect(anon.statusCode).toBe(401);
    state.actorRoles = ["support"];
    const support = await restrict(OWNER, { status: "suspended" });
    expect(support.statusCode).toBe(403);
    expect(draft("d_ready").revokedAt).toBeNull();
    expect(state.txWrites).toEqual([]);
  });
});
