// SPDX-License-Identifier: Apache-2.0

/**
 * SEC-03 regression suite — readiness, publication policy and safe content
 * headers on GET /v1/artifacts/:id/content.
 *
 * The finding: `canReadArtifact` short-circuits to `true` on
 * `visibility === public_sample` before any scan consideration, and the route
 * served the bytes with no `ready` check at all. An anonymous GET of a
 * quarantined/`infected` public sample returned 200 and its bytes. The same
 * route also interpolated the stored display name straight into
 * `Content-Disposition` and echoed the declared content type, so an
 * `image/svg+xml` or `text/html` artifact was served executable and inline.
 *
 * How this file tests it: the REAL route module is registered on a real Fastify
 * instance and driven with `app.inject()`; every module it imports is an
 * explicit in-memory double, so there is no Postgres, no storage driver, no
 * network and no `.env` — the same approach the security review used
 * (`docs/private/operations/community-security-evidence/probe.cjs`).
 *
 * `canReadArtifact` here is a faithful re-implementation of the real function's
 * branches that this route exercises (deleted, benchmark kinds, public_sample
 * short-circuit, staff roles, owner, sponsor_reference review rule). The live
 * audit-window branch is not reachable from these fixtures and is not modelled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ArtifactKind,
  ArtifactScanStatus,
  ArtifactStatus,
  ArtifactVisibility,
  SponsorExampleReviewStatus,
} from "@prisma/client";

type Row = {
  id: string;
  kind: ArtifactKind;
  visibility: ArtifactVisibility;
  status: ArtifactStatus;
  scanStatus: ArtifactScanStatus;
  sponsorReviewStatus: SponsorExampleReviewStatus | null;
  ownerUserId: string | null;
  bountyId: string | null;
  submissionId: string | null;
  filename: string;
  contentType: string;
  storageKey: string;
  sizeBytes: bigint | null;
  checksumSha256: string | null;
  uploadExpiresAt: Date | null;
};

const BYTES = "SENSITIVE ARTIFACT BYTES";

function baseRow(): Row {
  return {
    id: "art_test",
    kind: ArtifactKind.submission_attachment,
    visibility: ArtifactVisibility.public_sample,
    status: ArtifactStatus.ready,
    scanStatus: ArtifactScanStatus.clean,
    sponsorReviewStatus: null,
    ownerUserId: "owner-1",
    bountyId: null,
    submissionId: null,
    filename: "sample.txt",
    contentType: "text/plain",
    storageKey: "artifacts/submission_attachment/art_test/sample.txt",
    sizeBytes: BigInt(BYTES.length),
    checksumSha256: "a".repeat(64),
    uploadExpiresAt: null,
  };
}

const state: {
  row: Row;
  actor: { id: string; roles: string[]; apiKeyScopes?: string[] } | null;
  reads: string[];
} = { row: baseRow(), actor: null, reads: [] };

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
  serializeArtifact: (a: unknown) => a,
  listUserArtifacts: async () => [],
  verifyUploadToken: () => false,
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
  canReadArtifact: async (
    artifact: Row,
    user: { id: string; roles?: string[] } | null
  ): Promise<boolean> => {
    if (artifact.status === ArtifactStatus.deleted) return false;
    if (
      artifact.kind === ArtifactKind.benchmark_manifest ||
      artifact.kind === ArtifactKind.benchmark_private_split ||
      artifact.kind === ArtifactKind.benchmark_run_output
    ) {
      return false;
    }
    if (artifact.visibility === ArtifactVisibility.public_sample) return true;
    if (!user) return false;
    if (user.roles?.some((r) => r === "admin" || r === "member" || r === "support")) return true;
    if (artifact.ownerUserId && artifact.ownerUserId === user.id) return true;
    if (
      artifact.kind === ArtifactKind.sponsor_reference &&
      (artifact.status !== ArtifactStatus.ready ||
        artifact.sponsorReviewStatus !== SponsorExampleReviewStatus.approved)
    ) {
      return false;
    }
    return false;
  },
}));

vi.mock("../../services/storage.js", () => ({
  getArtifactData: async (key: string) => {
    state.reads.push(key);
    return Buffer.from(BYTES, "utf8");
  },
  // The route streams the object out now (no whole-file buffer); a read is
  // still recorded per storage key so the "never touches storage" assertions
  // keep their meaning.
  openArtifactStream: async (key: string) => {
    state.reads.push(key);
    return Readable.from(Buffer.from(BYTES, "utf8"));
  },
  resolveUploadByteCap: () => 1024 * 1024,
  ArtifactUploadTooLargeError: class extends Error {},
  putArtifactStream: async (_key: string, body: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return { sizeBytes: Buffer.concat(chunks).length, checksumSha256: "a".repeat(64) };
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
      updateMany: async () => ({ count: 1 }),
    },
    plannerSession: { findUnique: async () => null },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({}),
  },
}));

const { artifactRoutes } = await import("./artifacts.js");

let app: FastifyInstance;

beforeEach(async () => {
  state.row = baseRow();
  state.actor = null;
  state.reads = [];
  app = Fastify();
  await app.register(import("@fastify/sensible"));
  await app.register(import("@fastify/multipart"));
  await app.register(artifactRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const get = () => app.inject({ method: "GET", url: "/art_test/content" });

describe("SEC-03 · a public_sample is not a bypass for scan readiness", () => {
  const blocked: [string, ArtifactStatus, ArtifactScanStatus][] = [
    ["quarantined/infected", ArtifactStatus.quarantined, ArtifactScanStatus.infected],
    ["quarantined/content_mismatch", ArtifactStatus.quarantined, ArtifactScanStatus.content_mismatch],
    ["pending_upload", ArtifactStatus.pending_upload, ArtifactScanStatus.not_required],
    ["scanning/pending", ArtifactStatus.scanning, ArtifactScanStatus.pending],
    ["ready but scan errored", ArtifactStatus.ready, ArtifactScanStatus.error],
    ["ready but scan still pending", ArtifactStatus.ready, ArtifactScanStatus.pending],
    ["ready but scan infected", ArtifactStatus.ready, ArtifactScanStatus.infected],
  ];

  for (const [label, status, scanStatus] of blocked) {
    it(`refuses an ANONYMOUS read of a ${label} public sample and never touches storage`, async () => {
      state.row = { ...baseRow(), status, scanStatus };
      const res = await get();
      expect(res.statusCode).toBe(409);
      expect(res.body).not.toContain(BYTES);
      expect(state.reads).toHaveLength(0);
    });

    it(`refuses the OWNER's read of their own ${label} artifact`, async () => {
      state.row = { ...baseRow(), status, scanStatus, visibility: ArtifactVisibility.private };
      state.actor = { id: "owner-1", roles: [] };
      const res = await get();
      expect(res.statusCode).toBe(409);
      expect(res.body).not.toContain(BYTES);
      expect(state.reads).toHaveLength(0);
    });

    it(`refuses a PLATFORM STAFF read of a ${label} artifact through this generic route`, async () => {
      state.row = { ...baseRow(), status, scanStatus, visibility: ArtifactVisibility.private };
      state.actor = { id: "admin-1", roles: ["admin"] };
      const res = await get();
      expect(res.statusCode).toBe(409);
      expect(state.reads).toHaveLength(0);
    });
  }

  it("serves a ready + clean public sample anonymously", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(BYTES);
    expect(state.reads).toEqual([state.row.storageKey]);
  });

  it("serves a ready artifact whose scan was not_required", async () => {
    state.row = { ...baseRow(), scanStatus: ArtifactScanStatus.not_required };
    const res = await get();
    expect(res.statusCode).toBe(200);
  });
});

describe("SEC-03 · the readiness gate does not replace the access rules", () => {
  it("404s an unknown id", async () => {
    const res = await app.inject({ method: "GET", url: "/art_missing/content" });
    expect(res.statusCode).toBe(404);
  });

  it("401s an anonymous read of a private ready artifact (access decided before readiness)", async () => {
    state.row = { ...baseRow(), visibility: ArtifactVisibility.private };
    const res = await get();
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(BYTES);
    expect(state.reads).toHaveLength(0);
  });

  it("403s an UNRELATED account on a private ready artifact", async () => {
    state.row = { ...baseRow(), visibility: ArtifactVisibility.private };
    state.actor = { id: "stranger-9", roles: [] };
    const res = await get();
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(BYTES);
    expect(state.reads).toHaveLength(0);
  });

  it("serves the owner their own ready private artifact", async () => {
    state.row = { ...baseRow(), visibility: ArtifactVisibility.private };
    state.actor = { id: "owner-1", roles: [] };
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(BYTES);
  });

  it("refuses a DELETED artifact as an access failure, for every caller", async () => {
    state.row = { ...baseRow(), status: ArtifactStatus.deleted };
    const anon = await get();
    expect(anon.statusCode).toBe(401);

    state.actor = { id: "owner-1", roles: [] };
    const owner = await get();
    expect(owner.statusCode).toBe(403);

    state.actor = { id: "admin-1", roles: ["admin"] };
    const admin = await get();
    expect(admin.statusCode).toBe(403);
    expect(state.reads).toHaveLength(0);
  });

  it("403s an API key that carries neither read nor artifact scope", async () => {
    state.actor = { id: "owner-1", roles: [], apiKeyScopes: ["contribute"] };
    const res = await get();
    expect(res.statusCode).toBe(403);
    expect(state.reads).toHaveLength(0);
  });
});

describe("SEC-03 · a rejected sponsor sample does not become public through visibility alone", () => {
  function sponsorSample(reviewStatus: SponsorExampleReviewStatus | null): Row {
    return {
      ...baseRow(),
      kind: ArtifactKind.sponsor_reference,
      visibility: ArtifactVisibility.public_sample,
      sponsorReviewStatus: reviewStatus,
      bountyId: "bounty-1",
    };
  }

  for (const reviewStatus of [null, SponsorExampleReviewStatus.pending, SponsorExampleReviewStatus.rejected]) {
    it(`refuses an anonymous read of a ready, clean, public_sample sponsor example whose review is ${reviewStatus ?? "unset"}`, async () => {
      state.row = sponsorSample(reviewStatus);
      const res = await get();
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain(BYTES);
      expect(state.reads).toHaveLength(0);
    });

    it(`403s an unrelated account on that same ${reviewStatus ?? "unset"} sponsor example`, async () => {
      state.row = sponsorSample(reviewStatus);
      state.actor = { id: "stranger-9", roles: [] };
      const res = await get();
      expect(res.statusCode).toBe(403);
      expect(state.reads).toHaveLength(0);
    });

    it(`still lets the sponsor (owner) and platform staff open their ${reviewStatus ?? "unset"} example for review`, async () => {
      state.row = sponsorSample(reviewStatus);
      state.actor = { id: "owner-1", roles: [] };
      expect((await get()).statusCode).toBe(200);
      state.actor = { id: "member-1", roles: ["member"] };
      expect((await get()).statusCode).toBe(200);
    });
  }

  it("serves an APPROVED public sponsor sample anonymously — the published case still works", async () => {
    state.row = sponsorSample(SponsorExampleReviewStatus.approved);
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(BYTES);
  });
});

describe("SEC-03 · safe content headers for untrusted bytes", () => {
  it("neutralizes a quoted / CRLF-bearing filename instead of interpolating it raw", async () => {
    state.row = { ...baseRow(), filename: 'evil".txt\r\nX-Injected: yes' };
    const res = await get();

    expect(res.statusCode).toBe(200);
    const disposition = res.headers["content-disposition"] as string;
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
    // The stray quote can no longer terminate the quoted-string.
    expect(disposition).toContain('filename="evil_.txt__X-Injected: yes"');
    // The real name survives losslessly in the RFC 5987 parameter.
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent(state.row.filename)}`);
    expect(res.headers["x-injected"]).toBeUndefined();
  });

  it("downgrades an SVG to a non-executable attachment", async () => {
    state.row = { ...baseRow(), filename: "proof.svg", contentType: "image/svg+xml" };
    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("sandbox");
    expect(res.headers["content-security-policy"]).toContain("script-src 'none'");
  });

  it("downgrades text/html (including a parameterized charset) to a non-executable attachment", async () => {
    state.row = { ...baseRow(), filename: "page.html", contentType: "text/html; charset=utf-8" };
    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
  });

  it("keeps a preview-safe type inline with its own content type", async () => {
    state.row = { ...baseRow(), filename: "shot.png", contentType: "image/png" };
    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-disposition"]).toMatch(/^inline;/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves an unrecognized type as an attachment rather than inline", async () => {
    state.row = { ...baseRow(), filename: "blob.bin", contentType: "application/x-ndjson" };
    const res = await get();
    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(res.headers["content-type"]).toBe("application/x-ndjson");
  });

  it("marks a private file uncacheable and a public sample shared-cacheable", async () => {
    state.row = { ...baseRow(), visibility: ArtifactVisibility.private };
    state.actor = { id: "owner-1", roles: [] };
    expect((await get()).headers["cache-control"]).toBe("private, no-store");

    state.row = baseRow();
    state.actor = null;
    expect((await get()).headers["cache-control"]).toBe("public, max-age=300");
  });
});
