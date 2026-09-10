// SPDX-License-Identifier: Apache-2.0

/**
 * Regression suite for DELETE /v1/artifacts/:id.
 *
 * The finding: the route did not exist. `apps/web/lib/api-artifacts.ts`
 * `deleteArtifact()` called it and returned `res.ok`, which every caller
 * ignores, so the sponsor-facing "remove" control on a reference sample 404'd
 * and reported nothing at all. With `sampleSlotError`'s max-3 cap now really
 * enforced (409 SAMPLE_LIMIT_REACHED), that made a sponsor permanently pinned
 * to the first three files they uploaded — including a byte-less
 * `pending_upload` row left behind by a failed transfer, which occupies a slot
 * while its token is live and for which removal is the documented escape
 * hatch.
 *
 * What is asserted, and why each one is a distinct failure mode:
 *  - a soft delete stamps BOTH `status` and `deletedAt`. Stamping one is not a
 *    cosmetic shortfall: `sampleSlotError`/`listUserArtifacts` filter on
 *    `status`, while `buildSampleGate`/`listDatasetRequestSamples`/
 *    `buildPublicSamples` filter on `deletedAt IS NULL`, so a half-stamped row
 *    is freed from the cap while still counted by the gate (or the reverse).
 *    `mcp/tools.ts` has exactly that shape today.
 *  - the bytes are never hard-deleted (no storage delete call, row retained).
 *  - the ADD path's freeze applies to the REMOVE path, on all three sample
 *    owner legs, so the sample set cannot only ever shrink after sign-off.
 *  - ownership is per-row and fails closed on a NULL owner.
 *  - a repeated DELETE answers 409 instead of re-stamping `deletedAt`.
 *
 * Same harness as `artifacts.download-readiness.test.ts`: the REAL route
 * module on a real Fastify instance driven by `app.inject()`, with every
 * import an explicit in-memory double — no Postgres, no storage driver, no
 * `.env`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ArtifactKind,
  ArtifactScanStatus,
  ArtifactStatus,
  ArtifactVisibility,
  BountyStatus,
  DatasetRequestStatus,
} from "@prisma/client";

type Row = {
  id: string;
  kind: ArtifactKind;
  visibility: ArtifactVisibility;
  status: ArtifactStatus;
  scanStatus: ArtifactScanStatus;
  ownerUserId: string | null;
  bountyId: string | null;
  datasetRequestId: string | null;
  plannerSessionId: string | null;
  submissionId: string | null;
  filename: string;
  contentType: string;
  storageKey: string;
  sizeBytes: bigint | null;
  deletedAt: Date | null;
};

function baseRow(over: Partial<Row> = {}): Row {
  return {
    id: "art_del",
    kind: ArtifactKind.sponsor_reference,
    visibility: ArtifactVisibility.private,
    status: ArtifactStatus.ready,
    scanStatus: ArtifactScanStatus.clean,
    ownerUserId: "owner-1",
    bountyId: null,
    datasetRequestId: null,
    plannerSessionId: null,
    submissionId: null,
    filename: "sample.txt",
    contentType: "text/plain",
    storageKey: "artifacts/sponsor_reference/art_del/sample.txt",
    sizeBytes: BigInt(10),
    deletedAt: null,
    ...over,
  };
}

const state: {
  row: Row;
  actor: { id: string; roles: string[]; apiKeyScopes?: string[] };
  request: { status: DatasetRequestStatus } | null;
  bounty: { status: BountyStatus } | null;
  session: { completed: boolean } | null;
  /** Every raw `... FOR UPDATE` the route issued, so the lock-before-read
   * ordering is asserted rather than assumed. */
  locks: string[];
  audits: Array<{ action: string; targetId: string; metadata?: Record<string, unknown> }>;
  /** Any storage mutation. Must stay empty: a soft delete keeps the bytes. */
  storageWrites: string[];
} = {
  row: baseRow(),
  actor: { id: "owner-1", roles: [] },
  request: null,
  bounty: null,
  session: null,
  locks: [],
  audits: [],
  storageWrites: [],
};

const noop = async () => {};

vi.mock("../../lib/rbac.js", () => ({
  requireAuth: noop,
  requireAnyScope: () => async (req: { authedUser?: unknown }) => {
    req.authedUser = state.actor;
  },
  requireVerifiedEmail: async (req: { authedUser?: unknown }) => {
    req.authedUser = state.actor;
  },
  requireRole: () => noop,
  ADMIN_AND_MEMBER: ["admin", "member"],
  getAuthedUser: async () => state.actor,
}));

vi.mock("../../lib/audit-log.js", () => ({
  writeAuditLog: async (_tx: unknown, params: { action: string; targetId: string; metadata?: Record<string, unknown> }) => {
    state.audits.push({ action: params.action, targetId: params.targetId, metadata: params.metadata });
  },
}));
vi.mock("../../services/notifications.js", () => ({ notifyEvent: noop }));

// The real freeze predicates are re-stated here with the same membership the
// service exports, so this suite fails if the route stops consulting them
// (it asserts on the resulting refusal, not on a spy).
// Partial mock, not a full replacement. `softDeleteArtifact` was extracted
// into this module on 2026-09-07 so the REST route and the MCP `delete_file`
// tool share one rule (the MCP copy had no freeze gate and never stamped
// `deletedAt`). These tests were written against the route's then-inline
// logic with this whole module stubbed, so a total mock would have the route
// calling an undefined function and every case answering 500 — the assertions
// below would pass or fail for reasons unrelated to the behaviour they name.
// Spreading `importOriginal()` keeps the REAL `softDeleteArtifact` under test
// while the rest stays stubbed; it runs against the mocked `lib/prisma.js`
// and mocked `lib/audit-log.js` below, which is exactly what these tests
// already assert through.
vi.mock("../../services/artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/artifacts.js")>()),
  getArtifactById: async (id: string) => (id === state.row.id ? { ...state.row } : null),
  serializeArtifact: (a: unknown) => a,
  listUserArtifacts: async () => ({ items: [], limit: 50, hasMore: false, nextCursor: null }),
  verifyUploadToken: () => false,
  canReadArtifact: async () => true,
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
  ArtifactUploadValidationError: class ArtifactUploadValidationError extends Error {
    constructor(
      message: string,
      public readonly code: string,
      public readonly status?: number
    ) {
      super(message);
    }
  },
  requestSamplesEditable: (status: DatasetRequestStatus) =>
    status === DatasetRequestStatus.submitted ||
    status === DatasetRequestStatus.under_review ||
    status === DatasetRequestStatus.changes_requested,
  TERMINAL_BOUNTY_STATUSES: new Set([
    BountyStatus.cancelled,
    BountyStatus.completed,
    BountyStatus.partially_completed,
  ]),
}));

vi.mock("../../services/storage.js", () => ({
  getArtifactData: async () => Buffer.from("bytes"),
  openArtifactStream: async () => Readable.from(Buffer.from("bytes")),
  resolveUploadByteCap: () => 1024,
  ArtifactUploadTooLargeError: class extends Error {},
  putArtifactStream: async (key: string) => {
    state.storageWrites.push(`put:${key}`);
    return { sizeBytes: 5, checksumSha256: "a".repeat(64) };
  },
}));

vi.mock("../../lib/storage/index.js", () => ({
  storage: () => ({
    deleteObject: async (key: string) => {
      state.storageWrites.push(`delete:${key}`);
    },
  }),
  hasMultipartUpload: () => false,
}));

const tx = {
  $queryRaw: async (query: unknown) => {
    // A tagged-template `$queryRaw` hands the mock the raw
    // TemplateStringsArray (array-like, with `.raw`); a pre-built Prisma `Sql`
    // would instead carry `.strings`. Both are accepted so the assertion is
    // about the route issuing the lock, not about which shape Prisma chose.
    const fragments = Array.isArray(query)
      ? (query as string[])
      : ((query as { strings?: string[] }).strings ?? []);
    state.locks.push(fragments.join("?"));
    return [];
  },
  datasetRequest: { findUnique: async () => (state.request ? { ...state.request } : null) },
  bounty: { findUnique: async () => (state.bounty ? { ...state.bounty } : null) },
  plannerSession: { findUnique: async () => (state.session ? { ...state.session } : null) },
  artifact: {
    updateMany: async ({ where, data }: { where: { id: string; status: { not: ArtifactStatus } }; data: Partial<Row> }) => {
      if (where.id !== state.row.id || state.row.status === where.status.not) return { count: 0 };
      Object.assign(state.row, data);
      return { count: 1 };
    },
  },
};

vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    artifact: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === state.row.id ? { ...state.row } : null),
      updateMany: async () => ({ count: 1 }),
    },
    plannerSession: { findUnique: async () => null },
    $transaction: async (fn: (client: unknown) => unknown) => fn(tx),
  },
}));

const { artifactRoutes } = await import("./artifacts.js");

let app: FastifyInstance;

beforeEach(async () => {
  state.row = baseRow();
  state.actor = { id: "owner-1", roles: [] };
  state.request = null;
  state.bounty = null;
  state.session = null;
  state.locks = [];
  state.audits = [];
  state.storageWrites = [];
  app = Fastify();
  await app.register(import("@fastify/sensible"));
  await app.register(import("@fastify/multipart"));
  await app.register(artifactRoutes);
  await app.ready();
});

const del = (id = "art_del") => app.inject({ method: "DELETE", url: `/${id}` });

describe("DELETE /v1/artifacts/:id · the route exists and soft-deletes", () => {
  it("answers 200 and stamps BOTH status and deletedAt", async () => {
    const res = await del();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(state.row.status).toBe(ArtifactStatus.deleted);
    // The half-stamp `mcp/tools.ts` performs today is exactly what this asserts
    // against: `deletedAt` is what `buildSampleGate` and
    // `listDatasetRequestSamples` filter on, so without it a removed sample
    // still counts toward the gate and still renders.
    expect(state.row.deletedAt).toBeInstanceOf(Date);
  });

  it("never touches the stored bytes", async () => {
    await del();
    expect(state.storageWrites).toEqual([]);
  });

  it("writes one artifact.deleted audit row", async () => {
    await del();
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]!.action).toBe("artifact.deleted");
    expect(state.audits[0]!.targetId).toBe("art_del");
    expect(state.audits[0]!.metadata?.byStaff).toBe(false);
  });

  it("answers 409 on a repeat delete rather than re-stamping deletedAt", async () => {
    const first = await del();
    expect(first.statusCode).toBe(200);
    const stampedAt = state.row.deletedAt;
    const second = await del();
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("ARTIFACT_ALREADY_DELETED");
    expect(state.row.deletedAt).toBe(stampedAt);
  });

  it("answers 404 for an unknown id", async () => {
    expect((await del("art_missing")).statusCode).toBe(404);
  });
});

describe("DELETE /v1/artifacts/:id · ownership is per row", () => {
  it("refuses another signed-in account", async () => {
    state.actor = { id: "someone-else", roles: [] };
    const res = await del();
    expect(res.statusCode).toBe(403);
    expect(state.row.status).toBe(ArtifactStatus.ready);
  });

  it("allows admin/member staff, and records that it was a staff removal", async () => {
    state.actor = { id: "staff-1", roles: ["admin"] };
    expect((await del()).statusCode).toBe(200);
    expect(state.audits[0]!.metadata?.byStaff).toBe(true);
  });

  it("fails closed on an orphaned row with a NULL owner", async () => {
    state.row = baseRow({ ownerUserId: null });
    state.actor = { id: "owner-1", roles: [] };
    expect((await del()).statusCode).toBe(403);
    expect(state.row.status).toBe(ArtifactStatus.ready);
  });
});

describe("DELETE /v1/artifacts/:id · REMOVE honours the same freeze as ADD", () => {
  const frozenRequestStatuses: DatasetRequestStatus[] = [
    DatasetRequestStatus.approved,
    DatasetRequestStatus.implemented,
    DatasetRequestStatus.declined,
  ];

  for (const status of frozenRequestStatuses) {
    it(`refuses removal of a sample on a ${status} dataset request`, async () => {
      state.row = baseRow({ datasetRequestId: "req_1" });
      state.request = { status };
      const res = await del();
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("SPONSOR_EXAMPLES_LOCKED");
      expect(state.row.status).toBe(ArtifactStatus.ready);
      expect(state.row.deletedAt).toBeNull();
    });
  }

  const editableRequestStatuses: DatasetRequestStatus[] = [
    DatasetRequestStatus.submitted,
    DatasetRequestStatus.under_review,
    DatasetRequestStatus.changes_requested,
  ];

  for (const status of editableRequestStatuses) {
    it(`allows removal while the request is ${status}`, async () => {
      state.row = baseRow({ datasetRequestId: "req_1" });
      state.request = { status };
      expect((await del()).statusCode).toBe(200);
      expect(state.row.status).toBe(ArtifactStatus.deleted);
    });
  }

  it("refuses staff too — a signed-off set is not rewritten through the sponsor's own route", async () => {
    state.row = baseRow({ datasetRequestId: "req_1" });
    state.request = { status: DatasetRequestStatus.approved };
    state.actor = { id: "staff-1", roles: ["admin"] };
    expect((await del()).statusCode).toBe(409);
  });

  it("locks the dataset_requests row BEFORE reading its status", async () => {
    state.row = baseRow({ datasetRequestId: "req_1" });
    state.request = { status: DatasetRequestStatus.submitted };
    await del();
    expect(state.locks.some((q) => q.includes("dataset_requests") && q.includes("FOR UPDATE"))).toBe(true);
  });

  const terminalBountyStatuses: BountyStatus[] = [
    BountyStatus.cancelled,
    BountyStatus.completed,
    BountyStatus.partially_completed,
  ];

  for (const status of terminalBountyStatuses) {
    it(`refuses removal of a sample on a ${status} pool`, async () => {
      state.row = baseRow({ bountyId: "bnt_1" });
      state.bounty = { status };
      const res = await del();
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("SPONSOR_EXAMPLES_LOCKED");
      expect(state.row.deletedAt).toBeNull();
    });
  }

  it("allows removal on a live pool, locking the bounty row first", async () => {
    state.row = baseRow({ bountyId: "bnt_1" });
    state.bounty = { status: BountyStatus.active };
    expect((await del()).statusCode).toBe(200);
    expect(state.locks.some((q) => q.includes("bounties") && q.includes("FOR UPDATE"))).toBe(true);
  });

  it("refuses removal on a planner draft that has already been submitted", async () => {
    state.row = baseRow({ plannerSessionId: "ps_1" });
    state.session = { completed: true };
    const res = await del();
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("SPONSOR_EXAMPLES_LOCKED");
    expect(state.row.deletedAt).toBeNull();
  });

  it("allows removal on an in-progress planner draft", async () => {
    state.row = baseRow({ plannerSessionId: "ps_1" });
    state.session = { completed: false };
    expect((await del()).statusCode).toBe(200);
  });

  it("does not apply the sponsor-sample freeze to other artifact kinds", async () => {
    // A submission attachment on a completed bounty is not a reviewed sample
    // set; freezing it here would be an invented rule, and v1 does not.
    state.row = baseRow({ kind: ArtifactKind.submission_attachment, bountyId: "bnt_1", submissionId: "sub_1" });
    state.bounty = { status: BountyStatus.completed };
    expect((await del()).statusCode).toBe(200);
    expect(state.locks).toEqual([]);
  });
});
