// SPDX-License-Identifier: Apache-2.0

/**
 * Admin benchmark authoring — ported from v1's
 * `src/routes/v1/admin-benchmarks.ts` (routes designated Community in
 * phase0/http-route-disposition.csv rows 19-22).
 *
 * Before this, the Community API had the full `Benchmark*` schema and the
 * public read routes (`routes/v1/benchmarks.ts`) but no way for anything to
 * ever create a benchmark, so the public surface was permanently empty.
 *
 * Deliberate boundary, kept exactly as v1 drew it: this REST surface accepts
 * only *descriptive* input — a benchmark's metadata, and a release manifest
 * that REFERENCES existing accepted submissions. It never accepts raw task
 * material, hidden tests, or private artifacts. Version assembly (resolving
 * candidates to immutable submission revisions, snapshotting payloads,
 * establishing execution/contamination evidence, materialising
 * `BenchmarkTask` rows and the private manifest) is worker-owned and fails
 * closed there. Nothing in this file materialises a task.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BenchmarkVersionStatus, DomainId, type Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { ADMIN_AND_ABOVE_READONLY, ADMIN_ONLY, requireRole, type AuthedUser } from "../../lib/rbac.js";

/**
 * Cross-agent contract: the async build job. The worker side (services/jobs.ts
 * `JobType` union + worker.ts handler) is owned by another workstream, which
 * guarantees this exact type string and this exact payload shape
 * (`{ benchmarkVersionId }`). The row is written through `tx.jobQueue` rather
 * than `dbJobQueue.enqueue` because that helper takes no transaction (see
 * services/jobs.ts) and this handoff must be atomic — see the comment at the
 * enqueue site.
 */
const BENCHMARK_VERSION_BUILD = "benchmark.version_build";

/** Local release-validation error, so a bad request inside the transaction
 * surfaces as a 400 rather than a 500. v1 imported this from
 * services/benchmark-jobs.ts, which this API does not have. */
class BenchmarkReleaseError extends Error {}

const benchmarkId = z.object({ id: z.string().trim().min(1).max(100) }).strict();

const createBenchmark = z
  .object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lower-case kebab-case")
      .max(120),
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().max(10_000).optional(),
    supportedDomains: z.array(z.nativeEnum(DomainId)).min(1).max(5),
    supportedLanguages: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  })
  .strict();

const publicCandidate = z
  .object({
    submissionId: z.string().trim().min(1).max(100),
    split: z.literal("public_sample"),
    taskKey: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/i),
    ordinal: z.number().int().min(0),
    publicMetadata: z.record(z.unknown()).optional(),
  })
  .strict();

const privateCandidate = z
  .object({
    submissionId: z.string().trim().min(1).max(100),
    split: z.literal("private_holdout"),
    taskKey: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/i),
    ordinal: z.number().int().min(0),
  })
  .strict();

const sourceManifest = z
  .object({
    candidates: z.array(z.union([publicCandidate, privateCandidate])).min(1).max(500),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const keys = new Set(value.candidates.map((candidate) => candidate.taskKey));
    const ordinals = new Set(value.candidates.map((candidate) => candidate.ordinal));
    if (keys.size !== value.candidates.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "candidate taskKey values must be unique" });
    }
    if (ordinals.size !== value.candidates.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "candidate ordinal values must be unique" });
    }
    // A benchmark whose every task is a public sample cannot measure anything
    // it has not already given away.
    if (!value.candidates.some((candidate) => candidate.split === "private_holdout")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a benchmark release requires at least one private_holdout candidate",
      });
    }
  });

const createVersion = z
  .object({
    // Contract and candidate manifest are frozen into the release. The worker
    // performs the authoritative candidate/evidence validation before it
    // materializes any BenchmarkTask records.
    contract: z.record(z.unknown()),
    sourceManifest,
  })
  .strict();

/** Key-order-independent JSON, so `sourceManifestSha256` identifies the
 * manifest's content and not the order a client happened to serialise it in. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function actorOf(req: unknown): AuthedUser {
  return (req as { authedUser: AuthedUser }).authedUser;
}

export async function adminBenchmarkRoutes(app: FastifyInstance) {
  // Reads: admin + the read-only console roles, matching every other admin
  // read route in this API (ADMIN_AND_ABOVE_READONLY = admin/member/support).
  app.get("/benchmarks", { preHandler: requireRole(...ADMIN_AND_ABOVE_READONLY) }, async (_req, reply) => {
    const benchmarks = await prisma.benchmark.findMany({
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        supportedDomains: true,
        supportedLanguages: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: {
            id: true,
            version: true,
            status: true,
            taskCount: true,
            publicTaskCount: true,
            privateTaskCount: true,
            createdAt: true,
            publishedAt: true,
          },
        },
      },
    });
    return reply.send({ benchmarks });
  });

  app.get("/benchmarks/:id", { preHandler: requireRole(...ADMIN_AND_ABOVE_READONLY) }, async (req, reply) => {
    const parsed = benchmarkId.safeParse(req.params);
    if (!parsed.success) return reply.notFound("Benchmark not found.");
    const benchmark = await prisma.benchmark.findUnique({
      where: { id: parsed.data.id },
      include: {
        versions: {
          orderBy: { version: "desc" },
          include: {
            runs: {
              orderBy: { createdAt: "desc" },
              take: 25,
              select: {
                id: true,
                status: true,
                modelProvider: true,
                modelName: true,
                modelVersion: true,
                score: true,
                passedTaskCount: true,
                evaluatedTaskCount: true,
                createdAt: true,
                completedAt: true,
                failureEvidence: true,
              },
            },
          },
        },
      },
    });
    if (!benchmark) return reply.notFound("Benchmark not found.");
    // Admins may see operational evidence, but the private holdout manifest
    // reference/digest never leaves the worker boundary through a general
    // console route — a leaked private manifest invalidates the benchmark.
    const { versions, ...safeBenchmark } = benchmark;
    return reply.send({
      benchmark: {
        ...safeBenchmark,
        versions: versions.map(
          ({
            privateManifestArtifactId: _privateManifestArtifactId,
            privateManifestSha256: _privateManifestSha256,
            ...version
          }) => version
        ),
      },
    });
  });

  // Writes: admin only. Never widened to the read-only console roles.
  app.post("/benchmarks", { preHandler: requireRole(...ADMIN_ONLY) }, async (req, reply) => {
    const parsed = createBenchmark.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.issues[0]?.message ?? "Invalid benchmark.");
    const actor = actorOf(req);
    try {
      const benchmark = await prisma.$transaction(async (tx) => {
        const created = await tx.benchmark.create({ data: { ...parsed.data, createdByUserId: actor.id } });
        await writeAuditLog(tx, {
          actorUserId: actor.id,
          action: "benchmark.created",
          targetType: "benchmark",
          targetId: created.id,
          after: {
            slug: created.slug,
            status: created.status,
            supportedDomains: created.supportedDomains,
            supportedLanguages: created.supportedLanguages,
          },
          ip: req.ip,
          userAgent: req.headers["user-agent"],
          requestId: req.id,
        });
        return created;
      });
      return reply.code(201).send({ benchmark });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        return reply.conflict("A benchmark with this slug already exists.");
      }
      throw error;
    }
  });

  /**
   * Cut a release. Accepts only a manifest referencing existing submissions —
   * it cannot accept raw hidden tests or artifacts. The version is created in
   * `building` and the worker moves it on (or to `failed`, with evidence).
   */
  app.post("/benchmarks/:id/versions", { preHandler: requireRole(...ADMIN_ONLY) }, async (req, reply) => {
    const params = benchmarkId.safeParse(req.params);
    const input = createVersion.safeParse(req.body);
    if (!params.success) return reply.notFound("Benchmark not found.");
    if (!input.success) return reply.badRequest(input.error.issues[0]?.message ?? "Invalid benchmark version.");
    const actor = actorOf(req);
    const sourceManifestSha256 = sha256(input.data.sourceManifest);
    try {
      const version = await prisma.$transaction(async (tx) => {
        const benchmark = await tx.benchmark.findUnique({
          where: { id: params.data.id },
          select: { id: true, status: true },
        });
        if (!benchmark) throw new BenchmarkReleaseError("benchmark not found");
        if (benchmark.status === "archived") {
          throw new BenchmarkReleaseError("cannot add a version to an archived benchmark");
        }
        // Serialize version numbering per benchmark. The
        // @@unique([benchmarkId, version]) constraint remains the final
        // invariant if another writer races this transaction.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${benchmark.id}))`;
        const latest = await tx.benchmarkVersion.findFirst({
          where: { benchmarkId: benchmark.id },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const created = await tx.benchmarkVersion.create({
          data: {
            benchmarkId: benchmark.id,
            version: (latest?.version ?? 0) + 1,
            status: BenchmarkVersionStatus.building,
            contract: input.data.contract as Prisma.InputJsonValue,
            sourceManifest: input.data.sourceManifest as unknown as Prisma.InputJsonValue,
            sourceManifestSha256,
            createdByUserId: actor.id,
          },
        });
        await writeAuditLog(tx, {
          actorUserId: actor.id,
          action: "benchmark.version_created",
          targetType: "benchmark_version",
          targetId: created.id,
          after: {
            benchmarkId: benchmark.id,
            version: created.version,
            status: created.status,
            sourceManifestSha256,
          },
          ip: req.ip,
          userAgent: req.headers["user-agent"],
          requestId: req.id,
        });
        // Atomic outbox-style handoff (v1's behaviour): a committed release
        // never exists without its durable build job, and a rolled-back
        // release cannot leave a job pointing at nothing. Written through
        // `tx.jobQueue` because `dbJobQueue.enqueue` always runs on the
        // top-level client and would break that atomicity — the row shape and
        // the `idempotencyKey`-unique re-arm semantics are identical.
        await tx.jobQueue.upsert({
          where: { idempotencyKey: `${BENCHMARK_VERSION_BUILD}:${created.id}` },
          create: {
            type: BENCHMARK_VERSION_BUILD,
            idempotencyKey: `${BENCHMARK_VERSION_BUILD}:${created.id}`,
            payload: { benchmarkVersionId: created.id } as Prisma.InputJsonValue,
          },
          update: { status: "pending", payload: { benchmarkVersionId: created.id } as Prisma.InputJsonValue },
        });
        return created;
      });
      return reply.code(202).send({
        version: {
          id: version.id,
          benchmarkId: version.benchmarkId,
          version: version.version,
          status: version.status,
          sourceManifestSha256,
        },
      });
    } catch (error) {
      if (error instanceof BenchmarkReleaseError) return reply.badRequest(error.message);
      if ((error as { code?: string }).code === "P2002") {
        return reply.conflict("A conflicting benchmark version already exists; retry the request.");
      }
      throw error;
    }
  });
}
