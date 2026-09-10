// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level parity fixes on the five upload routes:
 *
 *  - `MULTIPART_REQUIRED` steering on POST /upload-slot for a file at or above
 *    the multipart threshold, when the driver can actually do multipart
 *    (v1 `routes/v1/artifacts.ts:288-295`). Without it the server issues a
 *    single-PUT slot that storage then has to police.
 *  - per-route rate limits (v1 `routes/v1/artifacts.ts:86-87`). These routes
 *    had none — only the global limiter.
 *  - the 403/404/409 statuses upload-target authorization now returns are
 *    passed through instead of being flattened to 400.
 *  - a reused slot answers 200 (+ `reused: true`) rather than 201.
 *
 * Real route module on a real Fastify instance driven with `app.inject()`;
 * every dependency is an explicit in-memory double, so no Postgres, no storage
 * driver and no network — same approach as `artifacts.download-readiness.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Readable } from "node:stream";

const MULTIPART_THRESHOLD = 100 * 1024 * 1024;
const PART_SIZE = 16 * 1024 * 1024;

const state = {
  actor: { id: "user-1", roles: ["contributor"], apiKeyScopes: undefined as string[] | undefined },
  multipartCapable: true,
  slot: {
    artifactId: "art_new",
    storageKey: "artifacts/submission_attachment/art_new/x.json",
    uploadExpiresAt: new Date(Date.now() + 900_000),
    upload: { mode: "form_post", method: "POST", url: "/v1/artifacts/art_new/content?token=t", fields: {}, expiresAt: new Date() },
    reused: false,
  },
  createUploadSlotError: null as Error | null,
  createUploadSlotCalls: [] as unknown[],
};

class FakeValidationError extends Error {
  constructor(message: string, public readonly code: string, public readonly status?: number) {
    super(message);
  }
}

const noop = async () => undefined;

vi.mock("../../lib/rbac.js", () => ({
  ADMIN_AND_MEMBER: ["admin", "member"],
  requireAuth: async (req: { authedUser?: unknown }) => {
    (req as { authedUser?: unknown }).authedUser = state.actor;
  },
  requireRole: () => async (req: { authedUser?: unknown }) => {
    (req as { authedUser?: unknown }).authedUser = state.actor;
  },
  requireAnyScope: () => async (req: { authedUser?: unknown }) => {
    (req as { authedUser?: unknown }).authedUser = state.actor;
  },
  requireVerifiedEmail: async () => undefined,
  getAuthedUser: async () => state.actor,
}));
vi.mock("../../lib/audit-log.js", () => ({ writeAuditLog: noop }));
vi.mock("../../services/notifications.js", () => ({ notifyEvent: noop }));
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    artifact: { findUnique: async () => null, update: async () => ({}), updateMany: async () => ({ count: 1 }) },
    plannerSession: { findUnique: async () => null },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({}),
  },
}));
vi.mock("../../services/storage.js", () => ({
  getArtifactData: async () => Buffer.alloc(0),
  openArtifactStream: async () => Readable.from(Buffer.alloc(0)),
  putArtifactStream: async () => ({ sizeBytes: 0, checksumSha256: "a".repeat(64) }),
  resolveUploadByteCap: () => 1024,
  ArtifactUploadTooLargeError: class extends Error {},
}));
vi.mock("../../lib/storage/index.js", () => ({
  storage: () => ({ name: "fake" }),
  hasMultipartUpload: () => state.multipartCapable,
  hasDirectUpload: () => false,
}));
vi.mock("../../config.js", () => ({
  config: {
    storage: {
      multipartThresholdBytes: MULTIPART_THRESHOLD,
      multipartPartSizeBytes: PART_SIZE,
      maxUploadBytes: 100 * 1024 * 1024,
      directUploadExpiresSeconds: 900,
      maxPendingUploadsPerUser: 20,
    },
  },
}));
vi.mock("../../services/artifacts.js", () => ({
  ArtifactUploadValidationError: FakeValidationError,
  getArtifactById: async (id: string) => ({
    id,
    kind: "submission_attachment",
    visibility: "private",
    status: "pending_upload",
    scanStatus: "pending",
    modality: null,
    detectedMimeType: null,
    parserVersion: null,
    sponsorReviewStatus: null,
    sponsorReviewNote: null,
    sponsorReviewedAt: null,
    filename: "x.json",
    contentType: "application/json",
    sizeBytes: null,
    submissionId: null,
    plannerSessionId: null,
    createdAt: new Date(),
  }),
  serializeArtifact: (a: unknown) => a,
  listUserArtifacts: async () => [],
  verifyUploadToken: () => false,
  canReadArtifact: async () => true,
  createUploadSlot: async (params: unknown) => {
    state.createUploadSlotCalls.push(params);
    if (state.createUploadSlotError) throw state.createUploadSlotError;
    return state.slot;
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
}));

const { artifactRoutes } = await import("./artifacts.js");

let app: FastifyInstance;

async function buildApp(rateLimitEnabled = false) {
  const instance = Fastify();
  await instance.register(import("@fastify/sensible"));
  await instance.register(import("@fastify/multipart"));
  if (rateLimitEnabled) {
    // Registered globally but NOT applied globally, exactly like app.ts's
    // per-route usage: only routes carrying `config.rateLimit` get a bucket.
    await instance.register(import("@fastify/rate-limit"), { global: false });
  }
  await instance.register(artifactRoutes);
  await instance.ready();
  return instance;
}

const slotBody = (over: Record<string, unknown> = {}) => ({
  kind: "submission_attachment",
  filename: "x.json",
  contentType: "application/json",
  ...over,
});

beforeEach(async () => {
  state.multipartCapable = true;
  state.createUploadSlotError = null;
  state.createUploadSlotCalls = [];
  state.slot = { ...state.slot, reused: false };
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe("POST /upload-slot — MULTIPART_REQUIRED steering", () => {
  it("refuses a file at or above the multipart threshold with a code and the exact part size", async () => {
    const res = await app.inject({ method: "POST", url: "/upload-slot", payload: slotBody({ sizeBytes: MULTIPART_THRESHOLD }) });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("MULTIPART_REQUIRED");
    expect(body.error).toBe("Bad Request");
    // The caller cannot guess the server's part size — the message must name it.
    expect(body.message).toContain(String(PART_SIZE));
    // No slot is minted for a request that belongs on the other route.
    expect(state.createUploadSlotCalls).toHaveLength(0);
  });

  it("applies to the `declaredSizeBytes` alias as well as `sizeBytes`", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/upload-slot",
      payload: slotBody({ declaredSizeBytes: MULTIPART_THRESHOLD + 1 }),
    });
    expect(res.json().code).toBe("MULTIPART_REQUIRED");
  });

  it("does NOT steer a file just under the threshold", async () => {
    const res = await app.inject({ method: "POST", url: "/upload-slot", payload: slotBody({ sizeBytes: MULTIPART_THRESHOLD - 1 }) });
    expect(res.statusCode).toBe(201);
    expect(state.createUploadSlotCalls).toHaveLength(1);
  });

  it("does NOT steer when the driver has no multipart capability — that would be a dead end", async () => {
    state.multipartCapable = false;
    const res = await app.inject({ method: "POST", url: "/upload-slot", payload: slotBody({ sizeBytes: MULTIPART_THRESHOLD * 2 }) });
    expect(res.statusCode).toBe(201);
  });

  it("does NOT steer when no size was declared at all", async () => {
    const res = await app.inject({ method: "POST", url: "/upload-slot", payload: slotBody() });
    expect(res.statusCode).toBe(201);
  });
});

describe("POST /upload-slot — authorization statuses are passed through, not flattened to 400", () => {
  const cases: [string, number][] = [
    ["NOT_TARGET_OWNER", 403],
    ["NOT_SAMPLE_OWNER", 403],
    ["NOT_FOUND", 404],
    ["POOL_CLOSED", 409],
    ["TOO_MANY_PENDING_UPLOADS", 409],
    ["SAMPLES_FROZEN", 409],
    ["INVALID_FILE_DECLARATION", 400],
    ["MODALITY_MISMATCH", 400],
    ["ARCHIVE_TOO_LARGE", 400],
  ];

  for (const [code, status] of cases) {
    it(`maps ${code} to ${status} with a well-formed envelope`, async () => {
      state.createUploadSlotError = new FakeValidationError("refused", code, status);
      const res = await app.inject({ method: "POST", url: "/upload-slot", payload: slotBody() });
      expect(res.statusCode).toBe(status);
      const body = res.json();
      expect(body).toMatchObject({ statusCode: status, code, message: "refused" });
      // QA 2026-09-05: every error body carries `error` alongside `code`.
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    });
  }

  it("keeps the pre-existing code-only mapping for an error carrying no explicit status", async () => {
    state.createUploadSlotError = new FakeValidationError("nope", "SLOT_EXPIRED");
    expect((await app.inject({ method: "POST", url: "/upload-slot", payload: slotBody() })).statusCode).toBe(409);
    state.createUploadSlotError = new FakeValidationError("nope", "CHECKSUM_REQUIRED");
    expect((await app.inject({ method: "POST", url: "/upload-slot", payload: slotBody() })).statusCode).toBe(400);
  });
});

describe("POST /upload-slot — idempotent reuse is visible to the client", () => {
  it("answers 201 for a new slot and 200 + reused:true for a reused one", async () => {
    const fresh = await app.inject({ method: "POST", url: "/upload-slot", payload: slotBody() });
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json().reused).toBe(false);

    state.slot = { ...state.slot, reused: true };
    const again = await app.inject({ method: "POST", url: "/upload-slot", payload: slotBody() });
    expect(again.statusCode).toBe(200);
    expect(again.json().reused).toBe(true);
  });
});

describe("rate limits are declared on all five upload routes", () => {
  const routes: [string, string, number][] = [
    ["POST", "/upload-slot", 30],
    ["POST", "/multipart-slot", 30],
    ["POST", "/art_x/multipart-complete", 60],
    ["POST", "/art_x/multipart-abort", 60],
    ["POST", "/art_x/complete", 60],
  ];

  for (const [method, url, max] of routes) {
    it(`${method} ${url} advertises a limit of ${max}/minute`, async () => {
      const limited = await buildApp(true);
      try {
        // A malformed/erroring body is fine — the limiter runs regardless, and
        // its headers are what this asserts.
        const res = await limited.inject({ method: method as "POST", url, payload: {} });
        expect(res.headers["x-ratelimit-limit"]).toBe(String(max));
      } finally {
        await limited.close();
      }
    });
  }

  it("actually refuses the 31st slot request in a window with 429", async () => {
    const limited = await buildApp(true);
    try {
      for (let i = 0; i < 30; i += 1) {
        const res = await limited.inject({ method: "POST", url: "/upload-slot", payload: slotBody() });
        expect(res.statusCode).toBe(201);
      }
      const over = await limited.inject({ method: "POST", url: "/upload-slot", payload: slotBody() });
      expect(over.statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
