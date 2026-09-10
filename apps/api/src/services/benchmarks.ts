// SPDX-License-Identifier: Apache-2.0

import { BenchmarkStatus, BenchmarkVersionStatus, BenchmarkRunStatus, type Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export async function listPublicBenchmarks() {
  const benchmarks = await prisma.benchmark.findMany({
    where: { status: BenchmarkStatus.published },
    include: {
      versions: {
        where: { status: BenchmarkVersionStatus.published },
        orderBy: { version: "desc" },
        take: 1,
      },
    },
  });

  return benchmarks.map((b) => ({
    id: b.id,
    slug: b.slug,
    title: b.title,
    description: b.description,
    supportedDomains: b.supportedDomains,
    currentVersion: b.versions[0]?.version ?? 1,
    createdAt: b.createdAt,
  }));
}

export async function getBenchmarkBySlug(slug: string) {
  return prisma.benchmark.findUnique({
    where: { slug },
    include: {
      versions: {
        where: { status: BenchmarkVersionStatus.published },
        orderBy: { version: "desc" },
        include: {
          runs: {
            where: { status: BenchmarkRunStatus.completed },
            orderBy: { score: "desc" },
            take: 20,
          },
        },
      },
    },
  });
}

export async function getBenchmarkLeaderboard(slug: string) {
  const benchmark = await prisma.benchmark.findUnique({
    where: { slug },
    include: {
      versions: {
        where: { status: BenchmarkVersionStatus.published },
        orderBy: { version: "desc" },
        take: 1,
      },
    },
  });
  if (!benchmark || !benchmark.versions[0]) return null;

  const runs = await prisma.benchmarkRun.findMany({
    where: {
      benchmarkVersionId: benchmark.versions[0].id,
      status: BenchmarkRunStatus.completed,
    },
    orderBy: { score: "desc" },
    take: 50,
  });

  return runs.map((r, idx) => ({
    rank: idx + 1,
    id: r.id,
    modelName: r.modelName,
    modelProvider: r.modelProvider,
    score: r.score,
    passedTasks: r.passedTaskCount,
    totalTasks: r.evaluatedTaskCount,
    completedAt: r.completedAt,
  }));
}

