// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { z } from "zod";
import { ArtifactStatus, type Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { requireRole, ADMIN_ONLY, ADMIN_AND_ABOVE_READONLY, type AuthedUser } from "../../lib/rbac.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { openArtifactStream } from "../../services/storage.js";
import { safeArtifactContentHeaders } from "./artifacts.js";

/**
 * Format-registry evidence surface backing community/apps/admin's /artifacts
 * page. Every field is a real Artifact row plus its real (possibly absent)
 * ArtifactProcessingEvent rows — this API has no format-registry pipeline
 * that writes those events yet (searched: no handler/registry module exists
 * under src/), so every artifact today honestly reports "missing" for all
 * three stages rather than a fabricated pass. When a real pipeline starts
 * writing ArtifactProcessingEvent rows, this route needs no changes — it
 * already reads them.
 */

const STAGES = ["parse", "preview", "similarity_check"] as const;
type Stage = (typeof STAGES)[number];

type StageStatus = "missing" | "stale" | "not_supported" | "passed" | "failed" | "pending";

const KNOWN_STATUSES = new Set<StageStatus>(["missing", "stale", "not_supported", "passed", "failed", "pending"]);

const listQuery = z.object({
  status: z.enum(["all", "missing", "stale", "unsupported", "unconfigured", "passed", "failed", "pending"]).default("all"),
  search: z.string().trim().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// Bounds how many Artifact rows a single request will scan while filtering
// for a sparse status (e.g. "failed" when almost nothing has failed). The
// admin console still gets a real, correctly-continuable cursor either way —
// this only caps request latency, not correctness.
const SCAN_CAP = 2000;
const BATCH_SIZE = 200;

export async function adminArtifactRoutes(app: FastifyInstance) {
  app.get("/artifacts", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const { status, search, cursor } = parsed.data;
    const limit = parsed.data.limit ?? 25;

    const where: Prisma.ArtifactWhereInput = {
      deletedAt: null,
      ...(search ? { filename: { contains: search, mode: "insensitive" } } : {}),
    };

    const matched: Array<{
      id: string;
      filename: string;
      kind: string;
      modality: string | null;
      unconfigured: boolean;
      artifactStatus: string;
      // The malware/AV verdict, kept SEPARATE from `artifactStatus`.
      // `artifactStatus: "ready"` only means the bytes landed. Scanning is
      // optional and off by default (owner decision 2026-09-05): with the switch
      // off an upload is recorded `not_required` and goes to `ready`; with the
      // switch on but no ARTIFACT_SCAN_URL it fails closed as `error` and stays
      // `scanning` (SEC-08). Without this field the console could not tell an
      // operator that nothing was scanned, which is the whole state that needs
      // to be visible. v1 exposes it for the same reason (v1 routes/v1/admin.ts
      // artifact select). `null` = no verdict recorded at all.
      scanStatus: string | null;
      bountyId: string | null;
      submissionId: string | null;
      createdAt: string;
      currentHandlerVersion: string;
      stages: { stage: Stage; status: StageStatus; handlerVersion: string | null; createdAt: string | null }[];
      // Sponsor reference-example review state (kind === "sponsor_reference"
      // only; null on every other kind). Surfaced here — not a separate page —
      // so an admin doesn't need to already know an artifact id to review it.
      sponsorReviewStatus: string | null;
      sponsorReviewNote: string | null;
      datasetRequestId: string | null;
    }> = [];

    let scanCursor = cursor;
    let scanned = 0;
    let exhausted = false;

    while (matched.length < limit + 1 && scanned < SCAN_CAP) {
      const batch = await prisma.artifact.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: BATCH_SIZE,
        ...(scanCursor ? { cursor: { id: scanCursor }, skip: 1 } : {}),
      });
      if (batch.length === 0) {
        exhausted = true;
        break;
      }
      scanned += batch.length;
      scanCursor = batch[batch.length - 1]!.id;

      const events = await prisma.artifactProcessingEvent.findMany({
        where: { artifactId: { in: batch.map((a) => a.id) } },
        orderBy: { createdAt: "desc" },
      });
      const latestByArtifactStage = new Map<string, (typeof events)[number]>();
      for (const e of events) {
        const key = `${e.artifactId}:${e.stage}`;
        if (!latestByArtifactStage.has(key)) latestByArtifactStage.set(key, e);
      }

      for (const a of batch) {
        const unconfigured = a.modality === null;
        const stages = STAGES.map((stage) => {
          const ev = latestByArtifactStage.get(`${a.id}:${stage}`);
          if (!ev) return { stage, status: "missing" as StageStatus, handlerVersion: null, createdAt: null };
          const st: StageStatus = KNOWN_STATUSES.has(ev.status as StageStatus) ? (ev.status as StageStatus) : "missing";
          return { stage, status: st, handlerVersion: ev.handlerVersion, createdAt: ev.createdAt.toISOString() };
        });

        const rowMatches =
          status === "all" ||
          (status === "unconfigured" && unconfigured) ||
          (status === "unsupported" && stages.some((s) => s.status === "not_supported")) ||
          (status !== "unconfigured" && status !== "unsupported" && stages.some((s) => s.status === status));

        if (rowMatches) {
          matched.push({
            id: a.id,
            filename: a.filename,
            kind: a.kind,
            modality: a.modality,
            unconfigured,
            artifactStatus: a.status,
            scanStatus: a.scanStatus ?? null,
            bountyId: a.bountyId,
            submissionId: a.submissionId,
            createdAt: a.createdAt.toISOString(),
            currentHandlerVersion: "",
            stages,
            sponsorReviewStatus: a.sponsorReviewStatus ?? null,
            sponsorReviewNote: a.sponsorReviewNote ?? null,
            datasetRequestId: a.datasetRequestId,
          });
        }
        if (matched.length >= limit + 1) break;
      }

      if (batch.length < BATCH_SIZE) {
        exhausted = true;
        break;
      }
    }

    const hasMore = matched.length > limit;
    const page = hasMore ? matched.slice(0, limit) : matched;
    // Real, resumable cursor: even when this page under-filled (sparse
    // filter), scanCursor points at the last Artifact row actually scanned,
    // so the next request picks up scanning from there rather than
    // re-scanning or silently truncating the table.
    const nextCursor = hasMore ? page[page.length - 1]!.id : exhausted ? null : scanCursor ?? null;

    return reply.send({ artifacts: page, nextCursor });
  });

  // GET /v1/admin/artifacts/:id/content — operator quarantine-analysis
  // download.
  //
  // Why a separate route: SEC-03 made the generic GET /v1/artifacts/:id/content
  // refuse anything that is not `ready` with a cleared scan verdict, for EVERY
  // caller including platform staff — and that gate must stay closed there.
  // But the admin console's submission-details page fetched exactly that route
  // to let an operator look at a held file, so after SEC-03 a quarantined or
  // still-scanning artifact could no longer be examined at all. The review's
  // guidance was to keep the quarantine-analysis path separate and narrowly
  // authorized, which is what this is.
  //
  // Authorization model — deliberately the narrowest in the file:
  //  - `requireRole(...ADMIN_ONLY)`: the `admin` role only. `member`/`support`
  //    can list artifacts and read the verdicts above, but pulling bytes a
  //    scanner flagged is an admin action.
  //  - Dashboard SESSION only. `requireRole` already refuses any API-key
  //    credential ("Admin operations require a dashboard session") before it
  //    looks at roles, so an `artifact`/`read`-scoped key of an admin user is a
  //    403 here, the same as on every other /v1/admin path.
  //  - No visibility short-circuit: `public_sample` buys nothing here.
  //
  // State model: `quarantined`, `scanning` and `ready` are all servable — the
  // operator's job is precisely to look at held files. `deleted` is a 404
  // (soft-deleted rows do not resurrect through an admin path) and
  // `pending_upload` is a 409 (nothing has been claimed as landed, so there is
  // nothing trustworthy to analyze; the object may be partial).
  //
  // Every response carries the same safe untrusted-file headers as the public
  // route, tightened: ALWAYS `attachment` (never inline, even for a type the
  // public route would preview), `application/octet-stream` for active types,
  // `nosniff`, script-less sandbox CSP, and `no-store` — an operator's browser
  // must never render or cache these bytes. The audit row is written BEFORE the
  // stream starts, so an attempted download is on record even if the transfer
  // fails part-way.
  app.get("/artifacts/:id/content", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const operator = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;

    const artifact = await prisma.artifact.findUnique({ where: { id } });
    if (!artifact || artifact.status === ArtifactStatus.deleted || artifact.deletedAt) {
      return reply.notFound("Artifact not found");
    }
    if (artifact.status === ArtifactStatus.pending_upload) {
      return reply.conflict("This upload has not been completed — there is no stored file to analyze yet.");
    }

    await prisma.$transaction(async (tx) => {
      await writeAuditLog(tx, {
        actorUserId: operator.id,
        action: "admin.artifact.content_downloaded",
        targetType: "Artifact",
        targetId: artifact.id,
        metadata: {
          filename: artifact.filename,
          contentType: artifact.contentType,
          status: artifact.status,
          scanStatus: artifact.scanStatus,
          sizeBytes: artifact.sizeBytes,
          kind: artifact.kind,
          bountyId: artifact.bountyId,
          submissionId: artifact.submissionId,
          purpose: "quarantine_analysis",
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        requestId: req.id,
      });
    });

    let content: Readable;
    try {
      content = await openArtifactStream(artifact.storageKey);
    } catch {
      return reply.notFound("Artifact file content not found in storage");
    }
    const headers = safeArtifactContentHeaders(artifact.filename, artifact.contentType, { forceAttachment: true });
    reply.header("Content-Type", headers.contentType);
    reply.header("Content-Disposition", headers.contentDisposition);
    reply.header("X-Content-Type-Options", headers.xContentTypeOptions);
    reply.header("Content-Security-Policy", headers.contentSecurityPolicy);
    reply.header("X-Download-Options", headers.xDownloadOptions);
    reply.header("Cross-Origin-Resource-Policy", headers.crossOriginResourcePolicy);
    reply.header("Cache-Control", "private, no-store");
    return reply.send(content);
  });
}
