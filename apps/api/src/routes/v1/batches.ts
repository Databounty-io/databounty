// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../lib/rbac.js";
import { BountyKind, ContributorBatchStatus, DatasetCategory, Prisma } from "@prisma/client";

function parseCsv(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

export async function batchRoutes(app: FastifyInstance) {
  // GET /v1/batches/count — open task batches on the funded/external
  // ("enterprise") track. This product line (community/apps/api) only ever
  // mints `BountyKind.community` bounties — there is no funded/external
  // bounty type here — so this route is a genuine query that will always
  // return 0 in this deployment. It exists for API-shape parity with the
  // funded API so the shared frontend client can call both endpoints
  // uniformly; the honest answer in a karma-only deployment is zero.
  app.get("/count", { preHandler: [requireAuth] }, async (req, reply) => {
    const query = req.query as { categories?: string; languages?: string };
    const categories = parseCsv(query.categories) as DatasetCategory[];
    const languages = parseCsv(query.languages);

    const where: Prisma.ContributorBatchWhereInput = {
      status: ContributorBatchStatus.available,
      bounty: {
        kind: { not: BountyKind.community },
        ...(languages.length ? { language: { in: languages } } : {}),
      },
      ...(categories.length ? { category: { in: categories } } : {}),
    };

    const total = await prisma.contributorBatch.count({ where });
    return reply.send({ total });
  });
}
