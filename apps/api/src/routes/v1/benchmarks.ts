// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import { listPublicBenchmarks, getBenchmarkBySlug, getBenchmarkLeaderboard } from "../../services/benchmarks.js";
import { prisma } from "../../lib/prisma.js";

export async function benchmarkRoutes(app: FastifyInstance) {
  // List published benchmarks
  app.get("/", async (_req, reply) => {
    const benchmarks = await listPublicBenchmarks();
    return reply.send({ benchmarks });
  });

  // Get benchmark detail
  app.get("/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const benchmark = await getBenchmarkBySlug(slug);
    if (!benchmark) return reply.notFound("Benchmark not found");
    return reply.send({ benchmark });
  });

  // Get benchmark version public sample
  app.get("/:slug/versions/:version/public-sample", async (req, reply) => {
    const { slug, version } = req.params as { slug: string; version: string };
    const benchmark = await prisma.benchmark.findUnique({ where: { slug } });
    if (!benchmark) return reply.notFound("Benchmark not found");

    const benchmarkVersion = await prisma.benchmarkVersion.findUnique({
      where: {
        benchmarkId_version: {
          benchmarkId: benchmark.id,
          version: Number(version),
        },
      },
      include: {
        tasks: {
          where: { split: "public_sample" },
          take: 50,
        },
      },
    });

    if (!benchmarkVersion) return reply.notFound("Benchmark version not found");
    return reply.send({ sampleTasks: benchmarkVersion.tasks });
  });

  // Benchmark leaderboard
  app.get("/:slug/leaderboard", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const leaderboard = await getBenchmarkLeaderboard(slug);
    if (!leaderboard) return reply.notFound("Benchmark not found");
    return reply.send({ leaderboard });
  });
}
