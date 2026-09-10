// SPDX-License-Identifier: Apache-2.0

import type { Prisma } from "@prisma/client";

/**
 * Acquire a per-bounty, per-namespace Postgres transaction-scoped advisory
 * lock on an ALREADY-OPEN transaction client. Released automatically when
 * that transaction commits or rolls back — never call this outside an open
 * transaction.
 *
 * The namespace keeps unrelated critical sections for the same bounty from
 * contending with each other (e.g. the near-dup decision and the audit-batch
 * assignment shouldn't queue behind one another just because they touch the
 * same bounty) while still serializing same-namespace callers against each
 * other, which is the actual race each caller needs closed.
 *
 * Ported from v1 `src/lib/bounty-lock.ts`, unchanged — the mechanism has no
 * paid/community dimension.
 */
export async function acquireBountyLock(
  tx: Prisma.TransactionClient,
  bountyId: string,
  namespace: string
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${namespace}:${bountyId}`}))`;
}
