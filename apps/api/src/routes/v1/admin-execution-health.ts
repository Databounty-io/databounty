// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireRole, ADMIN_AND_ABOVE_READONLY } from "../../lib/rbac.js";

/**
 * Execution health backing community/apps/admin's /execution-health page.
 * Every field is a real aggregate over `ValidationResult` rows where
 * `stage = "execution"` — the model's own schema comment says this
 * denormalization (`provider`/`outcome`/`durationMs`/`isolationVerified`)
 * exists specifically "so the admin console can aggregate them (E2B-style
 * health view)". `fallbackRuns` is the one field this route deliberately
 * omits: there is no stored marker for "this run only succeeded after an
 * earlier provider attempt on the same item failed" (detailJson is opaque,
 * unindexed). The frontend already has an honest path for that — `d.fallbackRuns
 * == null` renders "not measured" rather than reading as a false zero — so
 * omitting the key is the correct answer, not a gap to fake.
 */

const OUTCOME_HELD = new Set([
  "runtime_unavailable",
  "all_providers_failed",
  "no_provider_configured",
  "no_executable_harness",
  "not_attempted",
  "execution_held_for_review",
  "execution_unavailable",
  "execution_at_capacity",
  "execution_unverifiable",
]);

const query = z.object({ windowDays: z.coerce.number().int().min(1).max(90).optional() });

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export async function adminExecutionHealthRoutes(app: FastifyInstance) {
  app.get("/execution-health", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const parsed = query.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const windowDays = parsed.data.windowDays ?? 7;
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const rows = await prisma.validationResult.findMany({
      where: { stage: "execution", createdAt: { gte: since } },
      select: { passed: true, provider: true, outcome: true, durationMs: true, isolationVerified: true },
    });

    const totalRuns = rows.length;
    let passed = 0;
    let failed = 0;
    let held = 0;
    let unknown = 0;
    const outcomeCounts = new Map<string, number>();
    let isolationWithPosture = 0;
    let isolationTrue = 0;
    const durations: number[] = [];
    const providerAgg = new Map<string, { total: number; passed: number; failed: number; held: number; durations: number[] }>();

    for (const r of rows) {
      const outcomeKey = r.outcome ?? "unknown";
      outcomeCounts.set(outcomeKey, (outcomeCounts.get(outcomeKey) ?? 0) + 1);

      if (r.outcome === "runner_completed") {
        if (r.passed) passed++;
        else failed++;
      } else if (r.outcome === null) {
        unknown++;
      } else if (OUTCOME_HELD.has(r.outcome)) {
        held++;
      } else {
        // Any future outcome code not yet in OUTCOME_HELD — counted, never
        // silently dropped, but not claimed as judged either.
        held++;
      }

      if (r.isolationVerified !== null) {
        isolationWithPosture++;
        if (r.isolationVerified) isolationTrue++;
      }

      if (r.durationMs !== null) durations.push(r.durationMs);

      if (r.provider !== null) {
        const bucket = providerAgg.get(r.provider) ?? { total: 0, passed: 0, failed: 0, held: 0, durations: [] };
        bucket.total++;
        if (r.outcome === "runner_completed") {
          if (r.passed) bucket.passed++;
          else bucket.failed++;
        } else {
          bucket.held++;
        }
        if (r.durationMs !== null) bucket.durations.push(r.durationMs);
        providerAgg.set(r.provider, bucket);
      }
    }

    durations.sort((a, b) => a - b);

    return reply.send({
      windowDays,
      computedAt: new Date().toISOString(),
      totalRuns,
      passed,
      failed,
      held,
      unknown,
      isolationVerifiedRate: isolationWithPosture > 0 ? isolationTrue / isolationWithPosture : null,
      isolationRunsWithPosture: isolationWithPosture,
      durationMsP50: percentile(durations, 50),
      durationMsP95: percentile(durations, 95),
      durationSampleSize: durations.length,
      byOutcome: [...outcomeCounts.entries()].map(([outcome, count]) => ({ outcome, count })),
      byProvider: [...providerAgg.entries()].map(([provider, agg]) => {
        const sortedDurations = [...agg.durations].sort((a, b) => a - b);
        return {
          provider,
          total: agg.total,
          passed: agg.passed,
          failed: agg.failed,
          held: agg.held,
          p50: percentile(sortedDurations, 50),
        };
      }),
    });
  });
}
