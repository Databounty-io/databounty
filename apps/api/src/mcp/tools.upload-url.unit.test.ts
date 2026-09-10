// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the MCP file-upload absolute-URL fix, updated for
 * the real storage-capability abstraction (`lib/storage/types.ts`).
 *
 * `services/artifacts.ts`'s `createUploadSlot()` returns a path-only `url`
 * inside `upload` (e.g. `/v1/artifacts/:id/content?token=...`) ONLY on the
 * local-driver token fallback — a real direct-upload target from an object
 * store is already absolute. `routes/v1/artifacts.ts` `POST /upload-slot` is a
 * browser flow that re-prefixes the relative case with the inbound request's
 * own protocol/host before it ever reaches the client (see that route's
 * comment on `url`).
 *
 * The MCP tool `prepare_file_upload` used to hand that same path-only URL
 * straight to an MCP caller — an out-of-process client (CLI, agent host) with
 * no "current page" for a relative path to resolve against, and no request/
 * response cycle to borrow a Host header from. A real MCP client had no way
 * to turn the returned value into somewhere it could PUT/POST file bytes.
 *
 * `prepare_large_file_upload` used to silently reuse this same single-slot
 * mechanism under a different name (see git history) — its own tool
 * description said so honestly. It now calls the real
 * `MultipartUploadStorageDriver` capability. Local dev's disk driver has no
 * such capability, so the honest behavior here is a clear
 * MULTIPART_UPLOAD_UNSUPPORTED error, not a fabricated single-slot fallback —
 * proving the tool no longer silently downgrades to "not actually chunked."
 * The real multipart flow (prepare -> upload parts -> complete, and abort) is
 * covered end-to-end against a fake `MultipartUploadStorageDriver` in
 * `services/artifacts.multipart.integration.test.ts`, and against real S3 in
 * `lib/storage/s3-multipart.e2e.integration.test.ts` (opt-in, skipped unless
 * RUN_S3_MULTIPART_E2E=true).
 *
 * These tests call the tool functions directly (bypassing the OAuth/
 * transport layer, already covered by mcp/transport.integration.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AuthMethod } from "@prisma/client";
import { McpToolError } from "./core/errors.js";
import { buildApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { tools } from "./tools.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdArtifactIds: string[] = [];

const prepareFileUploadTool = tools.find((t) => t.name === "prepare_file_upload")!;
const prepareLargeFileUploadTool = tools.find((t) => t.name === "prepare_large_file_upload")!;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.artifact.deleteMany({ where: { id: { in: createdArtifactIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function createVerifiedUser(prefix: string) {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const uniquePart = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: {
      email: `${prefix}-${stamp}@example.com`,
      handle: `${prefix.slice(0, 6)}${uniquePart}`.toLowerCase().slice(0, 20),
      displayName: prefix,
      authMethod: AuthMethod.email,
      passwordHash: "not-used-in-these-tests",
      emailVerifiedAt: new Date(),
      onboarded: true,
    },
  });
  createdUserIds.push(user.id);
  return user.id;
}

describe("MCP upload tools use real storage-capability detection", () => {
  it("prepare_file_upload's upload.url is absolute and directly resolvable by an out-of-process client", async () => {
    const userId = await createVerifiedUser("upl-single");
    const result = await prepareFileUploadTool.call(
      { filename: "bulk-item.json", contentType: "application/json", kind: "submission_attachment" },
      { userId },
    );
    createdArtifactIds.push(result.artifactId);

    expect(result.upload.url).toMatch(/^https?:\/\//);
    // `new URL()` throws on anything that is not a fully-qualified URL — the
    // exact operation an out-of-process MCP client performs before issuing
    // the PUT/POST. A path-only string fails this; an absolute one does not.
    expect(() => new URL(result.upload.url)).not.toThrow();
    expect(new URL(result.upload.url).pathname).toBe(`/v1/artifacts/${result.artifactId}/content`);
  });

  it("prepare_large_file_upload honestly refuses on a driver with no multipart capability, instead of silently downgrading to a single slot", async () => {
    const userId = await createVerifiedUser("upl-large");
    const call = prepareLargeFileUploadTool.call(
      {
        filename: "bulk-source.jsonl",
        contentType: "application/jsonl",
        totalSizeBytes: 10,
        parts: [{ partNumber: 1, sizeBytes: 10, checksumSha256Hex: "a".repeat(64) }],
      },
      { userId },
    );
    await expect(call).rejects.toBeInstanceOf(McpToolError);
    await expect(call).rejects.toThrow(/does not support multipart upload/);
  });
});
