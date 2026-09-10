// SPDX-License-Identifier: Apache-2.0

/**
 * Streaming-upload suite for POST /v1/artifacts/:id/content — the
 * "large files stream" half of the universal modality invariant.
 *
 * The finding: the route called `data.toBuffer()` on a multipart file (and
 * awaited a whole Buffer on the raw path), so up to the 100 MiB multipart limit
 * of untrusted bytes sat in memory before the first one reached storage, and
 * the only size enforcement happened after the entire body had landed.
 *
 * What this file proves, and how:
 *
 *  - The REAL `services/storage.ts` (`putArtifactStream`, `resolveUploadByteCap`)
 *    and the REAL `lib/storage/local.ts` disk driver are used, writing into a
 *    per-run scratch directory. The driver is wrapped in a counting proxy so
 *    every assertion about "bytes that reached storage" is a measured number,
 *    not an inference from a status code.
 *  - Request bodies are fed to `app.inject()` as chunked Readables (not one
 *    Buffer), so a cap or an abort mid-body is observable as "fewer chunks were
 *    ever pulled from the source" — the server stopped reading.
 *  - The REAL route module is registered on a real Fastify instance; only its
 *    auth/db/service imports are in-memory doubles (same approach as the
 *    SEC-02/SEC-03 suites next to this file).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform, pipeline } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { ArtifactKind, ArtifactScanStatus, ArtifactStatus, ArtifactVisibility } from "@prisma/client";
import type { StorageDriver, StoredObject } from "../../lib/storage/types.js";

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
  declaredSizeBytes: bigint | null;
  sizeBytes: bigint | null;
  checksumSha256: string | null;
  uploadExpiresAt: Date | null;
};

const KiB = 1024;
const CHUNK = 16 * KiB;
/** The declared size the slot recorded, which becomes the per-upload cap. */
const DECLARED_CAP = 256 * KiB;

/**
 * Per-row storage PATH, so no two tests in this file write to the same object.
 * `storageKey` used to be a fixed constant, and the only cleanup was
 * `rmSync(scratchRoot/artifacts)` in `beforeEach`. Several tests here
 * deliberately leave work in flight — `countingDriver.put()` starts a
 * fire-and-forget `pipeline(...)`, and the abort paths are asserted via
 * `waitForStorageRemoval` rather than awaited to completion — so a late write
 * from the previous test could land AFTER that rmSync and recreate the exact
 * path the next test asserts is absent.
 *
 * That made `existsSync(objectPath())` timing-dependent: green with spare CPU,
 * red under contention (surfaced 2026-09-07, when adding one unrelated test
 * file was enough to lose the race). Only the path is uniquified — `id` stays
 * `art_stream` because request URLs and row lookups key on it — and every
 * assertion already reads `state.row.storageKey` rather than a literal, so
 * they follow it automatically.
 */
let storageKeySeq = 0;

function baseRow(): Row {
  storageKeySeq += 1;
  return {
    id: "art_stream",
    kind: ArtifactKind.submission_attachment,
    visibility: ArtifactVisibility.private,
    status: ArtifactStatus.pending_upload,
    scanStatus: ArtifactScanStatus.pending,
    sponsorReviewStatus: null,
    ownerUserId: "owner-1",
    bountyId: null,
    submissionId: null,
    filename: "big.bin",
    contentType: "application/octet-stream",
    storageKey: `artifacts/submission_attachment/art_stream_${storageKeySeq}/big.bin`,
    declaredSizeBytes: BigInt(DECLARED_CAP),
    sizeBytes: null,
    checksumSha256: null,
    uploadExpiresAt: new Date(Date.now() + 60_000),
  };
}

const state: {
  row: Row;
  actor: { id: string; roles: string[]; apiKeyScopes?: string[] } | null;
} = { row: baseRow(), actor: null };

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
  verifyUploadToken: () => false,
}));
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    artifact: {
      findUnique: async () => ({ ...state.row }),
      update: async ({ data }: { data: Partial<Row> }) => {
        Object.assign(state.row, data);
        return { ...state.row };
      },
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

// Real storage service + real local-disk driver, in a scratch root.
const { LocalDiskDriver } = await import("../../lib/storage/local.js");
const { setStorageDriverForTests, resetStorageDriverForTests } = await import("../../lib/storage/index.js");
const storageService = await import("../../services/storage.js");
const { artifactRoutes } = await import("./artifacts.js");

const scratchRoot = mkdtempSync(join(process.env.CLAUDE_SCRATCHPAD_DIR ?? tmpdir(), "artifact-streaming-"));

/** Bytes that actually reached the driver's `put()` (post-cap), and the keys
 *  `remove()` was asked to drop. This is the measurement the suite is about. */
const meter = { bytesToDriver: 0, puts: 0, removes: [] as string[] };

function countingDriver(inner: StorageDriver): StorageDriver {
  return {
    name: inner.name,
    bucket: inner.bucket,
    async put(key, body, contentType): Promise<StoredObject> {
      meter.puts += 1;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          meter.bytesToDriver += chunk.length;
          cb(null, chunk);
        },
      });
      // `pipeline` (not `.pipe()`) so an error on `body` propagates into the
      // meter — and on to the inner driver's own pipeline — with listeners in
      // place, exactly as it would without the meter in between.
      pipeline(body, counter, () => {});
      return inner.put(key, counter, contentType);
    },
    get: (key) => inner.get(key),
    head: (key) => inner.head(key),
    remove: async (key) => {
      meter.removes.push(key);
      return inner.remove(key);
    },
  };
}

const disk = new LocalDiskDriver(scratchRoot);
const objectPath = () => join(scratchRoot, state.row.storageKey);

async function waitForStorageRemoval(key: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!meter.removes.includes(key) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A chunked body that records how many chunks were ever pulled from it. */
function chunkedSource(total: Buffer, chunk = CHUNK, opts: { abortAfterChunks?: number } = {}) {
  const pulled = { chunks: 0, bytes: 0 };
  let offset = 0;
  const stream = new Readable({
    read() {
      if (opts.abortAfterChunks !== undefined && pulled.chunks >= opts.abortAfterChunks) {
        this.destroy(new Error("client went away mid-body"));
        return;
      }
      if (offset >= total.length) {
        this.push(null);
        return;
      }
      const next = total.subarray(offset, Math.min(offset + chunk, total.length));
      offset += next.length;
      pulled.chunks += 1;
      pulled.bytes += next.length;
      this.push(next);
    },
  });
  return { stream, pulled };
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const BOUNDARY = "----dbStreamBoundary";
/** Multipart framing around a chunked file body, itself streamed chunk by
 *  chunk so busboy sees the file arrive incrementally. */
function multipartSource(file: Buffer, opts: { abortAfterChunks?: number } = {}) {
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  const { stream: fileStream, pulled } = chunkedSource(file, CHUNK, opts);
  async function* frame() {
    yield head;
    for await (const c of fileStream) yield c as Buffer;
    yield tail;
  }
  return {
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload: Readable.from(frame()),
    pulled,
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  state.row = baseRow();
  state.actor = { id: "owner-1", roles: [] };
  meter.bytesToDriver = 0;
  meter.puts = 0;
  meter.removes = [];
  rmSync(join(scratchRoot, "artifacts"), { recursive: true, force: true });
  setStorageDriverForTests(countingDriver(disk));
  app = Fastify();
  await app.register(import("@fastify/sensible"));
  await app.register(import("@fastify/multipart"));
  await app.register(artifactRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  resetStorageDriverForTests();
});

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

describe("resolveUploadByteCap", () => {
  it("uses the platform ceiling when the slot declared no size", () => {
    const cap = storageService.resolveUploadByteCap(null);
    expect(cap).toBeGreaterThan(0);
    expect(storageService.resolveUploadByteCap(undefined)).toBe(cap);
  });

  it("uses the declared size when it is below the ceiling, and never exceeds the ceiling", () => {
    const ceiling = storageService.resolveUploadByteCap(null);
    expect(storageService.resolveUploadByteCap(BigInt(DECLARED_CAP))).toBe(DECLARED_CAP);
    expect(storageService.resolveUploadByteCap(ceiling * 10)).toBe(ceiling);
    expect(storageService.resolveUploadByteCap(0)).toBe(ceiling);
    expect(storageService.resolveUploadByteCap(-5)).toBe(ceiling);
  });
});

describe("putArtifactStream (service layer, real disk driver)", () => {
  it("lands a legitimate stream and reports the server-measured size and sha256", async () => {
    const body = randomBytes(3 * DECLARED_CAP + 7);
    const { stream, pulled } = chunkedSource(body);

    const stored = await storageService.putArtifactStream(state.row.storageKey, stream, "application/octet-stream", {
      maxBytes: body.length,
    });

    expect(stored.sizeBytes).toBe(body.length);
    expect(stored.checksumSha256).toBe(sha256(body));
    expect(pulled.bytes).toBe(body.length);
    expect(meter.bytesToDriver).toBe(body.length);
    expect(statSync(objectPath()).size).toBe(body.length);
    expect(meter.removes).toEqual([]);
  });

  it("rejects a stream over the cap WITHOUT reading or writing the rest of it, and removes the partial object", async () => {
    const body = randomBytes(2 * 1024 * KiB); // 2 MiB
    const { stream, pulled } = chunkedSource(body);

    await expect(
      storageService.putArtifactStream(state.row.storageKey, stream, "application/octet-stream", { maxBytes: DECLARED_CAP })
    ).rejects.toBeInstanceOf(storageService.ArtifactUploadTooLargeError);

    // Not a single byte past the cap reached the driver ...
    expect(meter.bytesToDriver).toBeLessThanOrEqual(DECLARED_CAP);
    // ... and the source was cut off right after the cap tripped: what was
    // pulled beyond it is only the streams' own highWaterMark buffering (a
    // handful of 16 KiB chunks), not the remaining ~1.75 MiB of body.
    expect(pulled.bytes).toBeLessThanOrEqual(DECLARED_CAP + 8 * CHUNK);
    expect(pulled.bytes).toBeLessThan(body.length / 4);
    expect(stream.destroyed).toBe(true);
    // ... and nothing half-written is left behind for /complete to find.
    expect(meter.removes).toEqual([state.row.storageKey]);
    expect(existsSync(objectPath())).toBe(false);
  });

  it("does not report success for a source that dies mid-stream, and removes the partial object", async () => {
    const body = randomBytes(DECLARED_CAP);
    const { stream } = chunkedSource(body, CHUNK, { abortAfterChunks: 3 });

    await expect(
      storageService.putArtifactStream(state.row.storageKey, stream, "application/octet-stream", { maxBytes: DECLARED_CAP })
    ).rejects.toThrow(/client went away/);

    // Stream scheduling differs across Node/OS implementations: the third
    // chunk may be pulled and then discarded when the source error reaches
    // the downstream pipeline. What matters is that no success is reported,
    // no bytes after the abort reach storage, and the partial object is gone.
    expect(meter.bytesToDriver).toBeGreaterThan(0);
    expect(meter.bytesToDriver).toBeLessThanOrEqual(3 * CHUNK);
    expect(meter.removes).toEqual([state.row.storageKey]);
    expect(existsSync(objectPath())).toBe(false);
  });
});

describe("POST /:id/content streams the body through the cap (route layer)", () => {
  it("stores a legitimate multipart upload with the server-verified size and checksum, without a whole-body buffer", async () => {
    const body = randomBytes(DECLARED_CAP - 3);
    const { headers, payload, pulled } = multipartSource(body);

    const res = await app.inject({ method: "POST", url: "/art_stream/content", headers, payload });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, sizeBytes: body.length });
    expect(state.row.sizeBytes).toBe(BigInt(body.length));
    expect(state.row.checksumSha256).toBe(sha256(body));
    expect(state.row.status).toBe(ArtifactStatus.pending_upload);
    expect(pulled.bytes).toBe(body.length);
    expect(meter.bytesToDriver).toBe(body.length);
    expect(statSync(objectPath()).size).toBe(body.length);
  });

  it("stores a raw application/octet-stream upload the same way", async () => {
    const body = randomBytes(DECLARED_CAP);
    const { stream } = chunkedSource(body);

    const res = await app.inject({
      method: "POST",
      url: "/art_stream/content",
      headers: { "content-type": "application/octet-stream" },
      payload: stream,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, sizeBytes: body.length });
    expect(state.row.checksumSha256).toBe(sha256(body));
    expect(meter.bytesToDriver).toBe(body.length);
  });

  it("answers 413 to a body over the cap before the body has been read, persists nothing, leaves no object", async () => {
    const body = randomBytes(8 * 1024 * KiB); // 8 MiB against a 256 KiB declared cap
    const { headers, payload, pulled } = multipartSource(body);

    const res = await app.inject({ method: "POST", url: "/art_stream/content", headers, payload });

    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe("ARTIFACT_TOO_LARGE");
    expect(res.headers.connection).toBe("close");
    // The measured proof that this was streamed, not buffered-then-checked:
    // nothing past the cap reached the driver, and the 413 went out with the
    // overwhelming majority of the body still unread (what was pulled beyond
    // the cap is multipart/stream highWaterMark buffering, a fixed few hundred
    // KiB, not a function of body size).
    expect(meter.bytesToDriver).toBeLessThanOrEqual(DECLARED_CAP);
    expect(pulled.bytes).toBeLessThan(body.length / 4);
    // Row untouched (still a pending slot with no size/checksum), object gone.
    expect(state.row.sizeBytes).toBeNull();
    expect(state.row.checksumSha256).toBeNull();
    expect(state.row.status).toBe(ArtifactStatus.pending_upload);
    expect(meter.removes).toEqual([state.row.storageKey]);
    expect(existsSync(objectPath())).toBe(false);
  });

  it("applies the cap to the raw octet-stream path too", async () => {
    const body = randomBytes(DECLARED_CAP + 1);
    const { stream, pulled } = chunkedSource(body, CHUNK);

    let statusCode: number | null = null;
    let streamError: unknown = null;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/art_stream/content",
        headers: { "content-type": "application/octet-stream" },
        payload: stream,
      });
      statusCode = res.statusCode;
    } catch (err) {
      // light-my-request can surface the intentionally destroyed raw request
      // stream as a rejection on Linux while macOS returns the route's 413.
      // Both prove the request failed closed; production Fastify still maps
      // ArtifactUploadTooLargeError to 413 before closing the connection.
      streamError = err;
    }

    if (statusCode !== null) expect(statusCode).toBe(413);
    else expect(streamError).toBeInstanceOf(storageService.ArtifactUploadTooLargeError);
    // On Linux, light-my-request can reject as soon as the synthetic payload
    // stream is destroyed, a few ticks before the route finishes its awaited
    // best-effort remove. Synchronize on that observable cleanup event so this
    // test and the following one inspect the terminal state, not that race.
    await waitForStorageRemoval(state.row.storageKey);
    expect(meter.bytesToDriver).toBeLessThanOrEqual(DECLARED_CAP);
    expect(pulled.bytes).toBeLessThanOrEqual(DECLARED_CAP + CHUNK);
    expect(state.row.sizeBytes).toBeNull();
    expect(existsSync(objectPath())).toBe(false);
  });

  it("falls back to the platform ceiling when the slot declared no size", async () => {
    state.row = { ...baseRow(), declaredSizeBytes: null };
    const body = randomBytes(2 * DECLARED_CAP); // over the declared cap, under the ceiling
    const { headers, payload } = multipartSource(body);

    const res = await app.inject({ method: "POST", url: "/art_stream/content", headers, payload });

    expect(res.statusCode).toBe(200);
    expect(state.row.sizeBytes).toBe(BigInt(body.length));
  });

  it("does not report success, persist metadata or keep the object when the client aborts mid-body", async () => {
    const body = randomBytes(DECLARED_CAP);
    const { headers, payload } = multipartSource(body, { abortAfterChunks: 4 });

    let statusCode: number | null = null;
    try {
      const res = await app.inject({ method: "POST", url: "/art_stream/content", headers, payload });
      statusCode = res.statusCode;
    } catch {
      // light-my-request may surface the broken request stream as a rejection
      // rather than a response; either way there must be no success below.
    }

    expect(statusCode).not.toBe(200);
    expect(state.row.sizeBytes).toBeNull();
    expect(state.row.checksumSha256).toBeNull();
    expect(state.row.status).toBe(ArtifactStatus.pending_upload);
    expect(meter.bytesToDriver).toBeLessThan(body.length);
    expect(existsSync(objectPath())).toBe(false);
  });

  it("still 400s a body that is neither multipart nor octet-stream, and writes nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/art_stream/content",
      headers: { "content-type": "application/json" },
      payload: { hello: "world" },
    });
    expect(res.statusCode).toBe(400);
    expect(meter.puts).toBe(0);
  });

  it("keeps the SEC-02 claim ahead of the stream: a non-pending row is 409 before any byte is read", async () => {
    state.row = { ...baseRow(), status: ArtifactStatus.ready, scanStatus: ArtifactScanStatus.clean };
    const { headers, payload, pulled } = multipartSource(randomBytes(4 * CHUNK));

    const res = await app.inject({ method: "POST", url: "/art_stream/content", headers, payload });

    expect(res.statusCode).toBe(409);
    expect(meter.puts).toBe(0);
    expect(pulled.chunks).toBe(0);
    expect(existsSync(objectPath())).toBe(false);
  });
});
