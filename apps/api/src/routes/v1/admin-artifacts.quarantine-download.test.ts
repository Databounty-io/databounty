// SPDX-License-Identifier: Apache-2.0

/**
 * Operator quarantine-download suite — GET /v1/admin/artifacts/:id/content.
 *
 * Why the route exists: SEC-03 closed the generic GET /v1/artifacts/:id/content
 * to anything not `ready` + scan-cleared, for every caller including staff. The
 * admin console's details page fetched exactly that route to let an operator
 * examine a held file, so quarantine analysis went dark. The review's guidance
 * was a SEPARATE, narrowly authorized operator path; this suite pins down how
 * narrow.
 *
 * Auth is tested against the REAL `lib/rbac.ts` (`requireRole`, `getAuthedUser`)
 * — only its credential sources (`sessionTokenFrom`, `getUserFromSessionToken`,
 * `verifyApiKey`) and Prisma are doubled — so "an API key is refused on admin
 * paths" is proven against the guard that actually runs, not a re-implementation
 * of it. Storage and the audit log are in-memory doubles that record calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { ArtifactKind, ArtifactScanStatus, ArtifactStatus, ArtifactVisibility } from "@prisma/client";

type Row = {
  id: string;
  kind: ArtifactKind;
  visibility: ArtifactVisibility;
  status: ArtifactStatus;
  scanStatus: ArtifactScanStatus;
  sponsorReviewStatus: null;
  ownerUserId: string | null;
  bountyId: null;
  submissionId: null;
  filename: string;
  contentType: string;
  storageKey: string;
  sizeBytes: bigint | null;
  checksumSha256: string | null;
  uploadExpiresAt: Date | null;
  deletedAt: Date | null;
};

const BYTES = "FLAGGED PAYLOAD BYTES";

function baseRow(): Row {
  return {
    id: "art_q",
    kind: ArtifactKind.submission_attachment,
    visibility: ArtifactVisibility.private,
    status: ArtifactStatus.quarantined,
    scanStatus: ArtifactScanStatus.infected,
    sponsorReviewStatus: null,
    ownerUserId: "owner-1",
    bountyId: null,
    submissionId: null,
    filename: 'evil "sample".txt',
    contentType: "text/plain",
    storageKey: "artifacts/submission_attachment/art_q/evil_sample.txt",
    sizeBytes: BigInt(BYTES.length),
    checksumSha256: "a".repeat(64),
    uploadExpiresAt: null,
    deletedAt: null,
  };
}

type FakeUser = {
  id: string;
  email: string;
  displayName: string;
  emailVerifiedAt: Date;
  status: string;
  roles: { role: string }[];
};

const USERS: Record<string, FakeUser> = {
  "sess-admin": { id: "admin-1", email: "a@x", displayName: "Admin", emailVerifiedAt: new Date(), status: "active", roles: [{ role: "admin" }] },
  "sess-member": { id: "member-1", email: "m@x", displayName: "Member", emailVerifiedAt: new Date(), status: "active", roles: [{ role: "member" }] },
  "sess-support": { id: "support-1", email: "s@x", displayName: "Support", emailVerifiedAt: new Date(), status: "active", roles: [{ role: "support" }] },
  "sess-user": { id: "user-1", email: "u@x", displayName: "User", emailVerifiedAt: new Date(), status: "active", roles: [] },
};

/** An API key belonging to the ADMIN user, carrying every scope the public
 *  content route would accept — the point is that none of that matters here. */
const ADMIN_API_KEY = "db_live_sk_dummy_admin";

const state: {
  row: Row;
  reads: string[];
  audits: { action: string; actorUserId: string | null; targetId: string; metadata?: Record<string, unknown> }[];
  /** Interleaving log so "audit before bytes" can be asserted. */
  order: string[];
} = { row: baseRow(), reads: [], audits: [], order: [] };

vi.mock("../../lib/session-cookie.js", () => ({
  sessionTokenFrom: (req: { headers: Record<string, string | undefined> }) =>
    (req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""),
}));
vi.mock("../../lib/session.js", () => ({
  getUserFromSessionToken: async (token: string) => USERS[token] ?? null,
}));
vi.mock("../../services/api-keys.js", () => ({
  KEY_PREFIX: "db_live_sk_",
  verifyApiKey: async (token: string) =>
    token === ADMIN_API_KEY ? { id: "key-1", userId: "admin-1", scopes: ["artifact", "read", "contribute"] } : null,
}));

const noop = async () => {};
vi.mock("../../services/notifications.js", () => ({ notifyEvent: noop }));
vi.mock("../../services/artifacts.js", () => ({
  getArtifactById: async () => null,
  canReadArtifact: async () => false,
  serializeArtifact: (a: unknown) => a,
  listUserArtifacts: async () => [],
  createUploadSlot: async () => {
    throw new Error("not exercised");
  },
  completeUpload: async () => {
    throw new Error("not exercised");
  },
  createMultipartUpload: async () => {
    throw new Error("not exercised");
  },
  completeMultipartUpload: async () => {
    throw new Error("not exercised");
  },
  abortMultipartUpload: async () => {
    throw new Error("not exercised");
  },
  ArtifactUploadValidationError: class extends Error {},
  verifyUploadToken: () => false,
}));
vi.mock("../../lib/audit-log.js", () => ({
  writeAuditLog: async (
    _tx: unknown,
    params: { action: string; actorUserId: string | null; targetId: string; metadata?: Record<string, unknown> }
  ) => {
    state.order.push("audit");
    state.audits.push({ action: params.action, actorUserId: params.actorUserId, targetId: params.targetId, metadata: params.metadata });
  },
}));
vi.mock("../../services/storage.js", () => ({
  openArtifactStream: async (key: string) => {
    state.order.push("read");
    state.reads.push(key);
    if (key.endsWith("/missing")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return Readable.from(Buffer.from(BYTES, "utf8"));
  },
  getArtifactData: async () => Buffer.from(BYTES, "utf8"),
  resolveUploadByteCap: () => 1024,
  ArtifactUploadTooLargeError: class extends Error {},
  putArtifactStream: async () => ({ sizeBytes: 0, checksumSha256: "a".repeat(64) }),
}));
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    user: {
      // Only the API-key branch of getAuthedUser reaches this.
      findUnique: async ({ where }: { where: { id: string } }) => {
        const user = Object.values(USERS).find((u) => u.id === where.id);
        return user ? { ...user } : null;
      },
    },
    artifact: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === state.row.id ? { ...state.row } : null),
      findMany: async () => [],
      update: async () => ({ ...state.row }),
      updateMany: async () => ({ count: 0 }),
    },
    artifactProcessingEvent: { findMany: async () => [] },
    plannerSession: { findUnique: async () => null },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({}),
  },
}));

const { adminArtifactRoutes } = await import("./admin-artifacts.js");

let app: FastifyInstance;

beforeEach(async () => {
  state.row = baseRow();
  state.reads = [];
  state.audits = [];
  state.order = [];
  app = Fastify();
  await app.register(import("@fastify/sensible"));
  await app.register(import("@fastify/multipart"));
  await app.register(adminArtifactRoutes, { prefix: "/admin" });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const get = (token?: string, id = "art_q") =>
  app.inject({
    method: "GET",
    url: `/admin/artifacts/${id}/content`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe("operator quarantine download · who may call it", () => {
  it("401s an anonymous caller and never touches storage or the audit log", async () => {
    const res = await get();
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(BYTES);
    expect(state.reads).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("403s a regular signed-in user", async () => {
    const res = await get("sess-user");
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(BYTES);
    expect(state.reads).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("403s member and support sessions — this is admin-only, narrower than the artifact listing", async () => {
    for (const token of ["sess-member", "sess-support"]) {
      const res = await get(token);
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain(BYTES);
    }
    expect(state.reads).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("403s an ADMIN's own API key: admin paths require a dashboard session, whatever the key's scopes", async () => {
    const res = await get(ADMIN_API_KEY);
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/dashboard session/i);
    expect(res.body).not.toContain(BYTES);
    expect(state.reads).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("401s an unknown/revoked API-key string (not a silent fall-through to anonymous)", async () => {
    const res = await get("db_live_sk_revoked");
    expect(res.statusCode).toBe(401);
    expect(state.reads).toEqual([]);
  });
});

describe("operator quarantine download · an admin session", () => {
  it("serves a quarantined/infected artifact the public route refuses, with safe untrusted-file headers", async () => {
    const res = await get("sess-admin");

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(BYTES);
    expect(state.reads).toEqual([state.row.storageKey]);

    // Always a download, never a preview — even for a type the public route
    // would show inline (text/plain here).
    expect(String(res.headers["content-disposition"])).toMatch(/^attachment;/);
    // The raw display name (with its `"`) never reaches the header unescaped;
    // the real name rides in the RFC 5987 parameter.
    expect(String(res.headers["content-disposition"])).toContain('filename="evil _sample_.txt"');
    expect(String(res.headers["content-disposition"])).toContain("filename*=UTF-8''evil%20%22sample%22.txt");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(res.headers["content-security-policy"])).toContain("sandbox");
    expect(String(res.headers["content-security-policy"])).toContain("script-src 'none'");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["x-download-options"]).toBe("noopen");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });

  it("downgrades an active content type to application/octet-stream", async () => {
    state.row = { ...baseRow(), contentType: "image/svg+xml", filename: "vector.svg" };
    const res = await get("sess-admin");
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/^application\/octet-stream/);
    expect(String(res.headers["content-disposition"])).toMatch(/^attachment;/);
  });

  it("keeps a benign declared type but still forces attachment (image/png is inline on the public route)", async () => {
    state.row = { ...baseRow(), contentType: "image/png", filename: "shot.png" };
    const res = await get("sess-admin");
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/^image\/png/);
    expect(String(res.headers["content-disposition"])).toMatch(/^attachment;/);
  });

  it("also serves a still-scanning artifact and a content_mismatch quarantine", async () => {
    state.row = { ...baseRow(), status: ArtifactStatus.scanning, scanStatus: ArtifactScanStatus.pending };
    expect((await get("sess-admin")).statusCode).toBe(200);
    state.row = { ...baseRow(), status: ArtifactStatus.quarantined, scanStatus: ArtifactScanStatus.content_mismatch };
    expect((await get("sess-admin")).statusCode).toBe(200);
    state.row = { ...baseRow(), status: ArtifactStatus.scanning, scanStatus: ArtifactScanStatus.error };
    expect((await get("sess-admin")).statusCode).toBe(200);
  });

  it("409s a pending_upload slot — nothing has been claimed as landed, so there is nothing to analyze", async () => {
    state.row = { ...baseRow(), status: ArtifactStatus.pending_upload, scanStatus: ArtifactScanStatus.pending };
    const res = await get("sess-admin");
    expect(res.statusCode).toBe(409);
    expect(state.reads).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("404s a soft-deleted artifact and an unknown id", async () => {
    state.row = { ...baseRow(), status: ArtifactStatus.deleted };
    expect((await get("sess-admin")).statusCode).toBe(404);
    state.row = { ...baseRow(), deletedAt: new Date() };
    expect((await get("sess-admin")).statusCode).toBe(404);
    expect((await get("sess-admin", "art_nope")).statusCode).toBe(404);
    expect(state.reads).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("404s cleanly when the object is missing from storage", async () => {
    state.row = { ...baseRow(), storageKey: "artifacts/submission_attachment/art_q/missing" };
    const res = await get("sess-admin");
    expect(res.statusCode).toBe(404);
  });

  it("writes an admin audit entry naming the operator and the artifact BEFORE the bytes are read", async () => {
    const res = await get("sess-admin");
    expect(res.statusCode).toBe(200);
    expect(state.audits).toHaveLength(1);
    const audit = state.audits[0]!;
    expect(audit.action).toBe("admin.artifact.content_downloaded");
    expect(audit.actorUserId).toBe("admin-1");
    expect(audit.targetId).toBe("art_q");
    expect(audit.metadata).toMatchObject({
      filename: 'evil "sample".txt',
      status: ArtifactStatus.quarantined,
      scanStatus: ArtifactScanStatus.infected,
      purpose: "quarantine_analysis",
    });
    expect(state.order).toEqual(["audit", "read"]);
  });
});
