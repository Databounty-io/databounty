// SPDX-License-Identifier: Apache-2.0

import { prisma } from "../lib/prisma.js";

/**
 * Delete the AuditBatch/AuditItem rows belonging to the given bounties, in the
 * order the foreign keys require. Call this in a test's `afterAll` BEFORE
 * deleting the bounties or their submissions.
 *
 * WHY THIS IS NEEDED (and why it is not a defect to "fix" in the schema).
 *
 * `audit_items.submission_id` is ON DELETE RESTRICT — Prisma's default for a
 * required relation, and exactly what v1 declares. Deleting a bounty cascades
 * to its submissions, and a submission that an audit item points at cannot be
 * deleted, so the whole cleanup fails with:
 *
 *   Foreign key constraint violated on the constraint:
 *   `audit_items_submission_id_fkey`
 *
 * That surfaced the moment `pool-lifecycle.ts` started routing sampled items
 * into real audit batches (stage 2 of the validator-flow alignment). It is not
 * a new hazard invented here: RESTRICT is deliberate, it is what stops a
 * submission delete from silently erasing the record of who audited it, and v1
 * carries the identical constraint. The fix belongs in the teardown, not in the
 * constraint.
 *
 * The window's `auditBatchId` link is cleared first (it references the batch),
 * then the batches go and cascade their items.
 */
export async function deleteAuditRowsForBounties(bountyIds: string[]): Promise<void> {
  if (bountyIds.length === 0) return;
  // Two indexed writes, both scoped by bountyId.
  //
  // An earlier version also swept items via `submission: { bountyId: { in } }`
  // as a belt-and-braces second arm. That arm has no index to use and made a
  // teardown take over eight minutes on the verify database, so it is gone:
  // every audit item reaches its bounty through its batch, and deleting the
  // batch cascades its items, so the extra arm could never find anything the
  // batch delete would not.
  await prisma.humanAuditWindow.updateMany({
    where: { bountyId: { in: bountyIds } },
    data: { auditBatchId: null },
  });
  await prisma.auditBatch.deleteMany({ where: { bountyId: { in: bountyIds } } });
}
