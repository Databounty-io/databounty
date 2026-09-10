// SPDX-License-Identifier: Apache-2.0

/**
 * SEC-02 regression suite — completed-upload immutability on
 * POST /v1/artifacts/:id/content.
 *
 * The finding: `verifyUploadToken` refuses a non-pending slot, but the route's
 * authenticated-owner fallback wrote to the same storage key with no
 * status/expiry check. An owner (or their artifact/contribute-scoped API key)
 * could therefore replace the bytes of an artifact that was already
 * `ready`/`clean`, while the row's scan verdict and sponsor review stayed
 * untouched and kept vouching for bytes that no longer existed.
 *
 * How this file tests it: the REAL route module is loaded and registered on a
 * real Fastify instance, driven with `app.inject()`. Everything the route
 * imports is replaced with an explicit in-memory double — no Postgres, no
 * storage driver, no network, no `.env`. This is the same doubling approach the
 * security review used to prove the finding
 * (`docs/private/operations/community-security-evidence/probe.cjs`).
 *
 * The doubles are test doubles, not product code: `verifyUploadToken` and
 * `prisma.artifact.updateMany` are faithful re-implementations of the two
 * behaviours under test (the capability predicate's fail-closed rules, and
 * conditional-update matching), and nothing here asserts on real scanner,
 * storage or database behaviour.
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
};

/** Mutable test state, reset per test. */
const state: {
  row: Row;
  actor: { id: string; roles: string[]; apiKeyScopes?: string[] } | null;
  /** Forces the capability-token double to accept, to prove the route's own
   *  state gate stands on its own rather than leaning on the verifier. */
  tokenAlwaysValid: boolean;
  writes: { key: string; body: string; contentType: string }[];
  /** Runs inside the storage write, simulating a POST /:id/complete that lands
   *  while the bytes are in flight. */
  onWrite: (() => void) | null;
} = {
  row: baseRow(),
  actor: null,
  tokenAlwaysValid: false,
  writes: [],
  onWrite: null,
};

function baseRow(): Row {
  return {
    id: "art_test",
    kind: ArtifactKind.submission_attachment,
    visibility: ArtifactVisibility.private,
    status: ArtifactStatus.pending_upload,
    scanStatus: ArtifactScanStatus.not_required,
    sponsorReviewStatus: null,
    ownerUserId: "owner-1",
    bountyId: null,
    submissionId: null,
    filename: "sample.txt",
    contentType: "text/plain",
    storageKey: "artifacts/submission_attachment/art_test/sample.txt",
    sizeBytes: null,
    checksumSha256: null,
    uploadExpiresAt: new Date(Date.now() + 60_000),
  };
}

const noop = async () => {};

vi.mock("../../lib/rbac.js", () => ({
  requireAuth: noop,
  requireAnyScope: () => noop,
  requireVerifiedEmail: noop,
  requireRole: () => noop,
  ADMIN_AND_MEMBER: ["admin", "member"],
  getAuthedUser: async () => state.actor,
}));

vi.mock("../../lib/audit-log.js", () => ({ writeAuditLog: noop }));
vi.mock("../../services/notifications.js", () => ({ notifyEvent: noop }));

vi.mock("../../services/artifacts.js", () => ({
  getArtifactById: async (id: string) => (id === state.row.id ? { ...state.row } : null),
  canReadArtifact: async () => true,
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
  // Faithful double of the real predicate's fail-closed rules (services/
  // artifacts.ts: non-string/empty -> false, non-pending -> false, missing or
  // elapsed expiry -> false, otherwise constant-time compare). The HMAC itself
  // is out of scope here, so a fixed secret string stands in for the digest.
  verifyUploadToken: (
    artifact: { status: ArtifactStatus; uploadExpiresAt: Date | null },
    presented: unknown
  ) => {
    if (state.tokenAlwaysValid) return true;
    if (typeof presented !== "string" || presented.length === 0) return false;
    if (artifact.status !== ArtifactStatus.pending_upload) return false;
    if (!artifact.uploadExpiresAt || artifact.uploadExpiresAt.getTime() <= Date.now()) return false;
    return presented === "valid-slot-token";
  },
}));

vi.mock("../../services/storage.js", () => ({
  getArtifactData: async () => Buffer.from("unused in this suite"),
  openArtifactStream: async () => Readable.from(Buffer.from("unused in this suite")),
  // The route now hands the driver a live stream (see artifacts.streaming.test.ts
  // for the cap/abort mechanics); this double drains it so the assertions below
  // can keep reasoning about the bytes that reached storage.
  resolveUploadByteCap: () => 1024 * 1024,
  ArtifactUploadTooLargeError: class extends Error {},
  putArtifactStream: async (key: string, body: Readable, contentType: string) => {
    state.onWrite?.();
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const buffer = Buffer.concat(chunks);
    state.writes.push({ key, body: buffer.toString("utf8"), contentType });
    return { sizeBytes: buffer.length, checksumSha256: "a".repeat(64) };
  },
}));

vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    artifact: {
      findUnique: async () => ({ ...state.row }),
      update: async ({ data }: { data: Partial<Row> }) => {
        Object.assign(state.row, data);
        return { ...state.row };
      },
      // Conditional-update matching, the mechanism the race-safe claim relies
      // on: only the `where` clauses this route actually uses are honoured, and
      // a non-match writes nothing and reports count 0.
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: ArtifactStatus; uploadExpiresAt?: { gt: Date } };
        data: Partial<Row>;
      }) => {
        const row = state.row;
        if (where.id !== row.id) return { count: 0 };
        if (where.status !== undefined && row.status !== where.status) return { count: 0 };
        if (where.uploadExpiresAt?.gt !== undefined) {
          if (!row.uploadExpiresAt || row.uploadExpiresAt.getTime() <= where.uploadExpiresAt.gt.getTime()) {
            return { count: 0 };
          }
        }
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    plannerSession: { findUnique: async () => null },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({}),
  },
}));

const { artifactRoutes } = await import("./artifacts.js");

const BOUNDARY = "----dbTestBoundary";
function multipart(contents: string, filename = "new.txt") {
  return {
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: text/plain\r\n\r\n`
      ),
      Buffer.from(contents),
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]),
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  state.row = baseRow();
  state.actor = null;
  state.tokenAlwaysValid = false;
  state.writes = [];
  state.onWrite = null;
  app = Fastify();
  await app.register(import("@fastify/sensible"));
  await app.register(import("@fastify/multipart"));
  await app.register(artifactRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function post(url: string, contents = "ATTACKER BYTES", cookie?: string) {
  const body = multipart(contents);
  return app.inject({
    method: "POST",
    url,
    headers: cookie ? { ...body.headers, cookie } : body.headers,
    payload: body.payload,
  });
}

describe("SEC-02 · POST /:id/content refuses to write to a non-pending slot", () => {
  const nonPending: [string, ArtifactStatus, ArtifactScanStatus][] = [
    ["scanning", ArtifactStatus.scanning, ArtifactScanStatus.pending],
    ["ready/clean", ArtifactStatus.ready, ArtifactScanStatus.clean],
    ["quarantined/infected", ArtifactStatus.quarantined, ArtifactScanStatus.infected],
    ["deleted", ArtifactStatus.deleted, ArtifactScanStatus.clean],
  ];

  for (const [label, status, scanStatus] of nonPending) {
    it(`rejects the authenticated OWNER path on a ${label} artifact and writes nothing`, async () => {
      state.row = { ...baseRow(), status, scanStatus };
      state.actor = { id: "owner-1", roles: [] };

      const res = await post("/art_test/content");

      expect(res.statusCode).toBe(409);
      expect(state.writes).toHaveLength(0);
      expect(state.row.status).toBe(status);
      expect(state.row.scanStatus).toBe(scanStatus);
      expect(state.row.sizeBytes).toBeNull();
      expect(state.row.checksumSha256).toBeNull();
    });

    it(`rejects an artifact-scoped API KEY of the owner on a ${label} artifact`, async () => {
      state.row = { ...baseRow(), status, scanStatus };
      state.actor = { id: "owner-1", roles: [], apiKeyScopes: ["artifact"] };

      const res = await post("/art_test/content");

      expect(res.statusCode).toBe(409);
      expect(state.writes).toHaveLength(0);
    });

    it(`rejects the CAPABILITY TOKEN path on a ${label} artifact even if the verifier accepted`, async () => {
      state.row = { ...baseRow(), status, scanStatus };
      state.tokenAlwaysValid = true;
      state.actor = null;

      const res = await post("/art_test/content?token=valid-slot-token");

      expect(res.statusCode).toBe(409);
      expect(state.writes).toHaveLength(0);
      expect(state.row.status).toBe(status);
      expect(state.row.scanStatus).toBe(scanStatus);
    });
  }

  it("rejects an EXPIRED pending slot on the owner path", async () => {
    state.row = { ...baseRow(), uploadExpiresAt: new Date(Date.now() - 1_000) };
    state.actor = { id: "owner-1", roles: [] };

    const res = await post("/art_test/content");

    expect(res.statusCode).toBe(409);
    expect(state.writes).toHaveLength(0);
  });

  it("rejects a pending slot with NO expiry at all on the owner path (fail closed)", async () => {
    state.row = { ...baseRow(), uploadExpiresAt: null };
    state.actor = { id: "owner-1", roles: [] };

    const res = await post("/art_test/content");

    expect(res.statusCode).toBe(409);
    expect(state.writes).toHaveLength(0);
  });

  it("rejects an expired slot on the capability-token path even if the verifier accepted", async () => {
    state.row = { ...baseRow(), uploadExpiresAt: new Date(Date.now() - 1_000) };
    state.tokenAlwaysValid = true;

    const res = await post("/art_test/content?token=valid-slot-token");

    expect(res.statusCode).toBe(409);
    expect(state.writes).toHaveLength(0);
  });
});

describe("SEC-02 · the state gate does not disturb the existing auth semantics", () => {
  it("still 404s an unknown artifact id before anything else", async () => {
    state.actor = { id: "owner-1", roles: [] };
    const res = await post("/art_missing/content");
    expect(res.statusCode).toBe(404);
    expect(state.writes).toHaveLength(0);
  });

  it("still 401s an anonymous caller with no token", async () => {
    const res = await post("/art_test/content");
    expect(res.statusCode).toBe(401);
    expect(state.writes).toHaveLength(0);
  });

  it("still 403s an authenticated non-owner (no existence disclosure change)", async () => {
    state.actor = { id: "stranger-9", roles: [] };
    const res = await post("/art_test/content");
    expect(res.statusCode).toBe(403);
    expect(state.writes).toHaveLength(0);
  });

  it("still 403s an owner whose API key lacks artifact/contribute scope", async () => {
    state.actor = { id: "owner-1", roles: [], apiKeyScopes: ["read"] };
    const res = await post("/art_test/content");
    expect(res.statusCode).toBe(403);
    expect(state.writes).toHaveLength(0);
  });

  it("still 403s a non-owner on a ready artifact — ownership is decided before readiness", async () => {
    state.row = { ...baseRow(), status: ArtifactStatus.ready, scanStatus: ArtifactScanStatus.clean };
    state.actor = { id: "stranger-9", roles: [] };
    const res = await post("/art_test/content");
    expect(res.statusCode).toBe(403);
    expect(state.writes).toHaveLength(0);
  });
});

describe("SEC-02 · a legitimate first upload still works", () => {
  it("accepts the capability-token upload into a pending, unexpired slot and records the stored size", async () => {
    const res = await post("/art_test/content?token=valid-slot-token", "HELLO BYTES");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, sizeBytes: "HELLO BYTES".length });
    expect(state.writes).toEqual([
      { key: state.row.storageKey, body: "HELLO BYTES", contentType: "text/plain" },
    ]);
    expect(state.row.sizeBytes).toBe(BigInt("HELLO BYTES".length));
    expect(state.row.checksumSha256).toBe("a".repeat(64));
    // The gate is a no-op claim: it must not advance the lifecycle itself.
    expect(state.row.status).toBe(ArtifactStatus.pending_upload);
  });

  it("accepts the authenticated owner (MCP) upload into a pending slot", async () => {
    state.actor = { id: "owner-1", roles: [], apiKeyScopes: ["contribute"] };
    const res = await post("/art_test/content", "AGENT BYTES");
    expect(res.statusCode).toBe(200);
    expect(state.writes).toHaveLength(1);
  });
});

describe("SEC-02 · concurrent write versus completion", () => {
  it("does not record metadata and reports 409 when a completion lands during the storage write", async () => {
    state.actor = { id: "owner-1", roles: [] };
    // The concurrent POST /:id/complete: it advances the row while the bytes
    // are being stored, exactly the interleaving a read-then-write check
    // cannot see.
    state.onWrite = () => {
      state.row.status = ArtifactStatus.scanning;
      state.row.scanStatus = ArtifactScanStatus.pending;
    };

    const res = await post("/art_test/content", "LATE BYTES");

    expect(res.statusCode).toBe(409);
    // The completion's state stands; the late writer did not stamp its own
    // size/checksum over it and did not get a false success.
    expect(state.row.status).toBe(ArtifactStatus.scanning);
    expect(state.row.scanStatus).toBe(ArtifactScanStatus.pending);
    expect(state.row.sizeBytes).toBeNull();
    expect(state.row.checksumSha256).toBeNull();
  });

  it("rejects a second write attempt made after the completion has already happened", async () => {
    state.actor = { id: "owner-1", roles: [] };
    const first = await post("/art_test/content", "FIRST BYTES");
    expect(first.statusCode).toBe(200);

    // The completion the client makes next.
    state.row.status = ArtifactStatus.scanning;
    state.row.scanStatus = ArtifactScanStatus.pending;

    const second = await post("/art_test/content", "SECOND BYTES");
    expect(second.statusCode).toBe(409);
    expect(state.writes.map((w) => w.body)).toEqual(["FIRST BYTES"]);
  });
});
