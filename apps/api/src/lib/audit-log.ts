// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function canonicalizeAuditValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalizeAuditValue(item) ?? null);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, canonicalizeAuditValue(item)])
  );
}

export function hashAuditEvidence(evidence: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(evidence)).digest("hex");
}

export async function writeAuditLog(
  tx: Prisma.TransactionClient,
  params: {
    actorUserId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    result?: "success" | "denied" | "failed";
    metadata?: Record<string, unknown>;
    before?: unknown;
    after?: unknown;
    ip?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
  }
): Promise<void> {
  // Serialize writers so the read-then-chain-then-write sequence below is
  // atomic with respect to other concurrent writeAuditLog calls in other
  // transactions. Without this, two concurrent transactions can both read
  // the same "previous" row via findFirst, both compute a new row chained
  // off that same prevHash, and both commit — forking the tamper-evident
  // hash chain this table exists to guarantee (a genuine TOCTOU race,
  // reproduced live under concurrent-agent load). The lock is
  // transaction-scoped (released automatically on commit/rollback) and
  // uses the same fixed key as v1's identical fix
  // (databounty-api/src/lib/audit-log.ts) so it is recognizable as THE
  // audit-chain lock — do not remove this as dead code.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1145132097)`;

  let previous: { rowHash: string | null; createdAt: Date } | null = null;
  try {
    previous = await tx.adminAuditLog.findFirst({
      where: { rowHash: { not: null } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { rowHash: true, createdAt: true },
    });
  } catch {
    // If table doesn't have records or advisory lock failed
  }

  const actor = params.actorUserId
    ? await tx.user.findUnique({
        where: { id: params.actorUserId },
        select: { id: true, email: true, displayName: true, roles: { select: { role: true } } },
      })
    : null;

  const id = randomUUID();
  const wallClock = new Date();
  const createdAt = previous && previous.createdAt >= wallClock
    ? new Date(previous.createdAt.getTime() + 1)
    : wallClock;

  const actorSnapshot = actor
    ? { id: actor.id, email: actor.email, displayName: actor.displayName, roles: actor.roles.map((role) => role.role) }
    : { id: params.actorUserId ?? "system", roles: [] };

  const metadata = canonicalizeAuditValue(params.metadata) as Record<string, unknown> | undefined;
  const before = canonicalizeAuditValue(params.before);
  const after = canonicalizeAuditValue(params.after);

  const evidence = {
    id,
    actorSnapshot,
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId,
    result: params.result ?? "success",
    metadata: metadata ?? null,
    before: before ?? null,
    after: after ?? null,
    ip: params.ip ?? null,
    userAgent: params.userAgent ?? null,
    requestId: params.requestId ?? null,
    prevHash: previous?.rowHash ?? null,
    createdAt: createdAt.toISOString(),
  };

  const rowHash = hashAuditEvidence(evidence);

  await tx.adminAuditLog.create({
    data: {
      id,
      actorUserId: params.actorUserId,
      actorSnapshot: actorSnapshot as Prisma.InputJsonValue,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      result: params.result ?? "success",
      metadata: metadata ? (metadata as Prisma.InputJsonValue) : undefined,
      before: before !== undefined ? (before as Prisma.InputJsonValue) : undefined,
      after: after !== undefined ? (after as Prisma.InputJsonValue) : undefined,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      requestId: params.requestId ?? null,
      prevHash: previous?.rowHash ?? null,
      rowHash,
      createdAt,
    },
  });
}

/**
 * Walks every row in creation order and recomputes each rowHash from its own
 * stored fields (the exact evidence shape writeAuditLog hashed), checking it
 * (a) matches the stored rowHash and (b) chains to the previous row's
 * rowHash via prevHash. A genuine tamper (an edited `after`/`metadata`, a
 * deleted row, a reordered row) breaks the chain at that exact point.
 */
export async function verifyAuditChainIntegrity(): Promise<{ valid: boolean; checked: number; brokenAt?: string | null }> {
  const rows = await prisma.adminAuditLog.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      actorUserId: true,
      actorSnapshot: true,
      action: true,
      targetType: true,
      targetId: true,
      result: true,
      metadata: true,
      before: true,
      after: true,
      ip: true,
      userAgent: true,
      requestId: true,
      prevHash: true,
      rowHash: true,
      createdAt: true,
    },
  });

  let expectedPrevHash: string | null = null;
  for (const row of rows) {
    // Rows written before this table had hashing (rowHash null) don't
    // participate in the chain — skip them but don't count them as broken.
    if (row.rowHash === null) continue;

    if (row.prevHash !== expectedPrevHash) {
      return { valid: false, checked: rows.length, brokenAt: row.id };
    }

    const evidence = {
      id: row.id,
      actorSnapshot: canonicalizeAuditValue(row.actorSnapshot),
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      result: row.result,
      metadata: canonicalizeAuditValue(row.metadata) ?? null,
      before: canonicalizeAuditValue(row.before) ?? null,
      after: canonicalizeAuditValue(row.after) ?? null,
      ip: row.ip ?? null,
      userAgent: row.userAgent ?? null,
      requestId: row.requestId ?? null,
      prevHash: row.prevHash,
      createdAt: row.createdAt.toISOString(),
    };
    const recomputed = hashAuditEvidence(evidence);
    if (recomputed !== row.rowHash) {
      return { valid: false, checked: rows.length, brokenAt: row.id };
    }

    expectedPrevHash = row.rowHash;
  }

  return { valid: true, checked: rows.length, brokenAt: null };
}
