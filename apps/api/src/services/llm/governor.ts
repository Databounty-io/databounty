// SPDX-License-Identifier: Apache-2.0

import { prisma } from "../../lib/prisma.js";
import { getGovernanceConfig, type GovernanceConfig } from "./config.js";
import type { LlmFeature } from "./types.js";

/**
 * Spend + rate governor — the pre-egress check the service runs before it
 * calls any provider.
 *
 * SCOPE, STATED HONESTLY. v1 has a second, stronger mechanism this file
 * deliberately does NOT port: a sharded pre-reservation ledger
 * (`llm_quota_buckets` / `llm_quota_reservations`, both of which exist in this
 * repo's schema) that atomically holds worst-case cost via raw SQL before
 * egress, so concurrent workers cannot collectively overshoot a daily cap.
 * That code is raw SQL with driver-specific bigint casts written against v1's
 * Prisma driver adapter; this app uses `@prisma/adapter-pg` instead, and the
 * reservation path runs on EVERY call including the zero-key fallback path.
 * Shipping it untested in the hot path of an otherwise-safe feature is the
 * wrong trade, so what is here is v1's simpler `checkGovernor`: a POST-HOC
 * check against already-written audit evidence.
 *
 * The consequence, which callers and admins must not be misled about: the
 * daily cap and the per-user rate limit are enforced from settled spend, so a
 * burst of genuinely concurrent calls can overshoot the cap by up to one
 * in-flight batch before the next call is blocked. It is a budget guard, not
 * a hard ceiling. Porting the reservation ledger is the follow-up that turns
 * it into one.
 */
export interface GovernorDecision {
  blocked: boolean;
  reason?: string;
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function checkGovernor(
  _feature: LlmFeature,
  userId?: string,
  passedCfg?: GovernanceConfig
): Promise<GovernorDecision> {
  const cfg = passedCfg ?? (await getGovernanceConfig());
  try {
    if (cfg.perUserPerMin > 0 && userId) {
      const recent = await prisma.llmAuditLog.count({
        where: { userId, createdAt: { gte: new Date(Date.now() - 60_000) }, fallbackUsed: false },
      });
      if (recent >= cfg.perUserPerMin) {
        return { blocked: true, reason: `rate limit: ${cfg.perUserPerMin}/min per user` };
      }
    }
    if (cfg.dailyCapMicroUsd > 0) {
      // Settled spend only (see the file header): reserved-but-unsettled spend
      // has no representation without the reservation ledger.
      const spent = await prisma.llmAuditLog.aggregate({
        _sum: { costMicroUsd: true },
        where: { createdAt: { gte: startOfUtcDay() }, fallbackUsed: false },
      });
      if ((spent._sum.costMicroUsd ?? 0n) >= BigInt(cfg.dailyCapMicroUsd)) {
        return { blocked: true, reason: "daily budget cap reached" };
      }
    }
  } catch {
    // A metering outage must not silently remove the budget guard, but it also
    // must not take the planner down: the caller's response to `blocked` is
    // its own deterministic fallback, which is the safe direction here.
    return { blocked: true, reason: "LLM spend metering is unavailable" };
  }
  return { blocked: false };
}
