// SPDX-License-Identifier: Apache-2.0

import { Prisma } from "@prisma/client";

/**
 * Bind uploaded files to the submission rows that reference them.
 *
 * PARITY: this is a faithful port of v1's `attachFileArtifacts`
 * (databounty-api/src/services/submission-row-insert.ts:324-370), which v1
 * calls from its one shared row-insert path (`:213`) used by BOTH the paid
 * batch flow (services/batch-submission.ts:159) and the community open-pool
 * flow (services/pool-submission.ts:187). This deployment has no paid/batch
 * submit surface (D18), so only the open-pool callers exist — but the helper
 * stays path-agnostic exactly as v1's is, taking the contributor batch id as
 * a nullable value rather than assuming the pool case.
 *
 * WHY IT MATTERS: an `Artifact` row is created at upload time owned by the
 * uploader and pointed at the bounty, with `submissionId` still NULL. Nothing
 * else ever sets that column. Without this step every uploaded file is
 * orphaned, and the two consumers that already read `artifact.submissionId` —
 * `services/sponsor-evidence.ts` (the sponsor's per-submission evidence view)
 * and `services/audits.ts` (the validator's attachments/logs lists) — return
 * empty for every item, so a file dataset is unreviewable and unauditable.
 */

/** Thrown (as v1 does, by exact message) when any referenced artifact fails a
 * guard. The submit is aborted whole rather than silently dropping an
 * attachment: a half-attached item would show a sponsor and a validator
 * different files from the ones the contributor submitted. */
export const INVALID_FILE_ARTIFACT_REFERENCE = "INVALID_FILE_ARTIFACT_REFERENCE";

/** The subset of a `DatasetType.fields` entry this module needs. Kept
 * structural (not a named contract type) so it accepts the raw JSON column
 * without a cast, the same way `collectSubmissionAttachments` in
 * services/community-publish.ts already reads it. */
export interface ContractFieldLike {
  key?: unknown;
  role?: unknown;
}

/**
 * File fields are stored as either one artifact id or, for a contract with
 * maxCount > 1, the JSON array emitted by the shared web editor. Normalize
 * both representations before attaching or validating ownership.
 *
 * Byte-for-byte the same normalization as v1's
 * `fileArtifactIdsFromPayload` (submission-row-insert.ts:23-37).
 */
export function fileArtifactIdsFromPayload(
  fields: ContractFieldLike[],
  payload: Record<string, unknown>
): string[] {
  return fields.flatMap((field) => {
    if (!field || typeof field !== "object") return [];
    if (field.role !== "file" || typeof field.key !== "string" || !field.key) return [];
    const value = payload[field.key];
    if (Array.isArray(value)) return value.filter((id): id is string => typeof id === "string" && id.trim() !== "");
    if (typeof value !== "string" || !value.trim()) return [];
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string" && id.trim() !== "")) return parsed;
    } catch {
      // A single artifact id is not JSON; it remains the supported scalar form.
    }
    return [value];
  });
}

/** One inserted row and the payload it was inserted from. */
export interface AttachRow {
  id: string;
  payload: Record<string, unknown>;
}

/**
 * Attach every referenced file artifact in ONE statement.
 *
 * The six ownership guards are byte-for-byte v1's (submission-row-insert.ts
 * :359-367): same bounty, same contributor batch (`IS NOT DISTINCT FROM`, so
 * the pool case's NULL matches NULL rather than failing every comparison),
 * owned by the caller, not already attached, kind `submission_attachment`,
 * status `ready`. The all-or-nothing count check is preserved too.
 *
 * MUST be called inside the same transaction as the submission insert, so a
 * rejected reference rolls the rows back instead of leaving accepted items
 * whose files never bound.
 *
 * Returns the number of artifacts attached (0 when the contract declares no
 * file field, which is the common case and costs no statement).
 */
export async function attachFileArtifacts(
  tx: Prisma.TransactionClient,
  args: {
    rows: AttachRow[];
    fields: ContractFieldLike[];
    bountyId: string;
    contributorBatchId: string | null;
    userId: string;
  }
): Promise<number> {
  const { rows, fields, bountyId, contributorBatchId, userId } = args;
  if (fields.length === 0 || rows.length === 0) return 0;

  const pairs: { artifactId: string; submissionId: string }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const artifactId of new Set(fileArtifactIdsFromPayload(fields, row.payload))) {
      // The same artifact referenced by two items in one submit could only
      // ever attach to one of them; the count check below would then fail the
      // submit anyway, so reject it here with the same loud outcome.
      if (seen.has(artifactId)) throw new Error(INVALID_FILE_ARTIFACT_REFERENCE);
      seen.add(artifactId);
      pairs.push({ artifactId, submissionId: row.id });
    }
  }
  if (pairs.length === 0) return 0;

  // Every parameter is cast explicitly: inside a VALUES list Postgres cannot
  // infer a bind parameter's type from context, and `contributor_batch_id` is
  // compared against a value that is legitimately NULL for pool submissions.
  const values = Prisma.join(
    pairs.map((pair) => Prisma.sql`(${pair.artifactId}::text, ${pair.submissionId}::text)`),
    ", "
  );
  const attached = await tx.$executeRaw`
    UPDATE artifacts AS a
       SET submission_id = v.submission_id
      FROM (VALUES ${values}) AS v(artifact_id, submission_id)
     WHERE a.id = v.artifact_id
       AND a.bounty_id = ${bountyId}::text
       AND a.contributor_batch_id IS NOT DISTINCT FROM ${contributorBatchId}::text
       AND a.owner_user_id = ${userId}::text
       AND a.submission_id IS NULL
       AND a.kind = 'submission_attachment'
       AND a.status = 'ready'
  `;
  if (attached !== pairs.length) throw new Error(INVALID_FILE_ARTIFACT_REFERENCE);
  return attached;
}

/**
 * The `role: "file"` fields of the dataset type a bounty was minted from.
 * Returns `[]` when the bounty declares no dataset type or the type has no
 * file field — the common case, and the reason the attach step usually costs
 * nothing.
 */
export async function fileFieldsForBounty(
  tx: Prisma.TransactionClient,
  bountyId: string
): Promise<ContractFieldLike[]> {
  const bounty = await tx.bounty.findUnique({
    where: { id: bountyId },
    select: { datasetType: { select: { fields: true } } },
  });
  const raw = bounty?.datasetType?.fields;
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter(
    (f): f is ContractFieldLike =>
      Boolean(f) && typeof f === "object" && (f as ContractFieldLike).role === "file"
  );
}
