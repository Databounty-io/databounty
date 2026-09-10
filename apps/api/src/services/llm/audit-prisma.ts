// SPDX-License-Identifier: Apache-2.0

import { prisma } from "../../lib/prisma.js";
import type { LlmAuditRecord, LlmAuditSink } from "./audit.js";

/**
 * Durable audit sink — writes each call to the existing `llm_audit_log` table
 * (`prisma/schema.prisma` model `LlmAuditLog`; no migration needed). Hashes
 * only, never raw content or keys. This table is also what `governor.ts` sums
 * for spend + rate limits, so the write is awaited (a burst must not race
 * ahead of its own accounting) but wrapped by the service so a failure can
 * never break the call.
 */
export const prismaAuditSink: LlmAuditSink = {
  async record(rec: LlmAuditRecord): Promise<void> {
    await prisma.llmAuditLog.create({
      data: {
        feature: rec.feature,
        provider: rec.provider,
        model: rec.model,
        userId: rec.userId ?? null,
        accountId: rec.accountId ?? null,
        promptHash: rec.promptHash,
        promptVersion: rec.promptVersion,
        outputHash: rec.outputHash,
        inputTokens: rec.inputTokens,
        outputTokens: rec.outputTokens,
        costMicroUsd: BigInt(rec.costMicroUsd),
        fallbackUsed: rec.fallbackUsed,
        failoverUsed: rec.failoverUsed,
        latencyMs: rec.latencyMs,
        ok: rec.ok,
        error: rec.error ?? null,
      },
    });
  },
};
