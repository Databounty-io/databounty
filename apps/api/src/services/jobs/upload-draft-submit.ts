// SPDX-License-Identifier: Apache-2.0

/**
 * `upload_draft.submit` — turns one already-reviewed `SubmissionUploadDraft`'s
 * usable rows into real `Submission` rows.
 *
 * REPLACES the old synchronous stub in routes/v1/upload-review-drafts.ts,
 * which flipped `SubmissionUploadDraft.status` to `"submitted"` and did
 * nothing else: it never read the parsed rows, never created a single
 * `Submission`, never checked pool capacity. The route now only CAS-claims
 * the draft into `"submitting"` and enqueues this job (see
 * `enqueueUploadDraftSubmit`); everything else happens here, asynchronously,
 * in bounded chunks.
 *
 * We deliberately copied v1's general shape for this kind of resumable bulk
 * ingest (CAS-claim on the parent row, a background worker does the real
 * work) but NOT its crash-recovery bug. v1 commits a chunk's row-insert in
 * one transaction and advances its resume cursor in a SEPARATE, later
 * transaction, so a crash between the two replays the chunk on retry. Here
 * the row-insert AND the cursor-advance for a chunk happen in the SAME
 * `prisma.$transaction` (see the loop body below) — a crash before that
 * transaction commits means literally nothing happened yet (clean retry), a
 * crash after means everything committed atomically (nothing to redo). This
 * is the entire point of doing this differently from v1; do not split it.
 *
 * We also sidestep v1's other bug (an external route re-arming an
 * already-enqueued job under the SAME idempotency key it is racing, with
 * ack()/fail() writing job status unconditionally) by construction: this job
 * type's idempotency key (`upload_draft.submit:${draftId}`) is enqueued
 * EXACTLY ONCE, by the submit route, right after it wins the CAS claim on the
 * draft. Nothing else ever calls `enqueueUploadDraftSubmit` for the same
 * draft, so there is no scenario where two different actors touch the same
 * job row's lifecycle.
 *
 * JUDGMENT CALL (documented per instructions): `submitPoolBatchItems` in
 * services/submissions.ts opens its OWN `prisma.$transaction`, which cannot
 * nest inside the one this job needs for the row-insert + cursor-advance
 * atomicity guarantee above. services/submissions.ts is explicitly off
 * limits to edit in this task (a different agent owns it), so rather than
 * call that function this job copies its per-item ingest logic verbatim
 * (dedupe-key computation, near-dup LSH scoring, submission creation, the
 * same conditional `validation.run` enqueue, and the same same-transaction
 * file-artifact attach) so a single-item submit and a bulk draft submit
 * behave identically. `deriveItemTitle`, the internal near-dup scorer, and
 * the internal LSH-band writer are not exported from that file either, so
 * they are reproduced here byte-for-byte rather than left unusable — again,
 * because editing that file was out of scope for this change.
 */
import { GenerationMethod, Prisma, SubmissionStatus, type BountyStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { enqueueJob, dbJobQueue } from "../jobs.js";
import { bandsFromSignature, computeMinHashSignature, LSH_CONFIG } from "../dedup-lsh.js";
import { computeDedupeKey } from "../submissions.js";
import { attachFileArtifacts, fileFieldsForBounty, type AttachRow } from "../artifact-attach.js";

/** Rows processed per transaction — matches the sibling `bulk_source.parse`
 * job's `CHUNK_SIZE` convention (src/services/jobs/bulk-source-parse.ts),
 * kept local because that file is off limits to edit/export from here. */
const CHUNK_SIZE = 200;

/** How long one chunk's ingest transaction (dedupe reads + N submission
 * creates + file-attach + cursor advance) may hold its connection. Matches
 * `submitPoolBatchItems`'s own `INTAKE_TRANSACTION_TIMEOUT_MS` (60s), which
 * this job's per-item logic is a byte-for-byte copy of. */
const CHUNK_TRANSACTION_TIMEOUT_MS = 60_000;

/** Honest stop reasons recorded on `SubmissionUploadDraft.submitError` when a
 * run stops before every usable row has become a Submission. `null` means a
 * clean, full ingest. */
type StopReason = "pool_full" | "pool_closed" | "no_target_pool" | null;

/** Thrown INSIDE a chunk transaction to force a real rollback when the
 * revoked-draft guard fails. Returning a boolean instead (without throwing)
 * would let the transaction commit the submissions/attachments/cursor-advance
 * it already built even though the guarded `updateMany` matched zero rows —
 * exactly the half-committed state this job's atomicity guarantee exists to
 * prevent. Caught by the caller to distinguish "revoked mid-run" from a real
 * failure. */
class DraftRevokedMidRunError extends Error {}

/** Best-effort human-readable title for a raw dataset-field payload. Copied
 * byte-for-byte from the unexported `deriveItemTitle` in
 * services/submissions.ts (see module docstring for why it is copied rather
 * than imported) so bulk-drafted rows get the same titles a single-item or
 * REST-bulk submit would produce for the same payload. */
function deriveItemTitle(payload: Record<string, unknown>, index: number): string {
  for (const key of ["title", "prompt", "name", "question", "task"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  }
  const firstString = Object.values(payload).find((v) => typeof v === "string" && v.trim()) as string | undefined;
  if (firstString) return firstString.trim().slice(0, 120);
  return `Community submission ${index + 1}`;
}

/** Persists a newly-created submission's own LSH bands. Copied from the
 * unexported `writeLshBands` in services/submissions.ts — same reasoning as
 * `deriveItemTitle` above. */
async function writeLshBands(
  submissionId: string,
  bands: { bandIndex: number; bandHash: string }[],
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (bands.length === 0) return;
  await tx.submissionLshBand.createMany({
    data: bands.map((b) => ({ submissionId, bandIndex: b.bandIndex, bandHash: b.bandHash })),
    skipDuplicates: true,
  });
}

/** Near-duplicate scoring on top of exact-hash dedup. Copied from the
 * unexported `computeNearDupScore` in services/submissions.ts — same
 * reasoning as `deriveItemTitle` above; kept algorithmically identical
 * (same LSH-band intersection → similarity estimate) so this job's dedupe
 * behavior cannot drift from the REST submit paths it mirrors. */
async function computeNearDupScore(
  bountyId: string,
  bands: { bandIndex: number; bandHash: string }[],
  tx: Prisma.TransactionClient,
): Promise<number> {
  if (bands.length === 0) return 0;
  const matches = await tx.submissionLshBand.findMany({
    where: {
      OR: bands.map((b) => ({ bandIndex: b.bandIndex, bandHash: b.bandHash })),
      // V1 parity (contamination.ts ~line 520) and matching the fix in the
      // services/submissions.ts original of this function: a rejected
      // submission's bands must never count as a near-dup candidate.
      submission: { bountyId, status: { not: SubmissionStatus.rejected } },
    },
    select: { submissionId: true },
  });
  if (matches.length === 0) return 0;

  const sharedBandsBySubmission = new Map<string, number>();
  for (const m of matches) {
    sharedBandsBySubmission.set(m.submissionId, (sharedBandsBySubmission.get(m.submissionId) ?? 0) + 1);
  }
  let maxShared = 0;
  for (const count of sharedBandsBySubmission.values()) {
    if (count > maxShared) maxShared = count;
  }
  if (maxShared === 0) return 0;

  const fraction = maxShared / LSH_CONFIG.numBands;
  return Math.pow(fraction, 1 / LSH_CONFIG.rowsPerBand);
}

/**
 * Producer. Enqueued exactly once — by `POST /v1/upload-review-drafts/:id/submit`
 * right after it CAS-claims the draft into `"submitting"` — and never re-armed
 * by anything else, so this job's idempotency key is never shared with
 * another actor's lifecycle writes (see module docstring).
 */
export async function enqueueUploadDraftSubmit(
  draftId: string,
  opts: { tx?: Prisma.TransactionClient } = {},
): Promise<void> {
  await enqueueJob(
    "upload_draft.submit",
    { draftId },
    {
      idempotencyKey: `upload_draft.submit:${draftId}`,
      maxAttempts: 5,
      tx: opts.tx,
    },
  );
}

/** Draft-terminal write, guarded so a revoked (cancelled) or already-finalized
 * draft can never be overwritten by a stray/duplicate job execution. Merges
 * onto whatever `previewSummary` shape currently exists rather than assuming
 * one, since the sibling parse job (owned by another agent) may rename its
 * fields concurrently. */
async function finalizeDraft(draftId: string, stopReason: StopReason, submittedRows: number): Promise<void> {
  const current = await prisma.submissionUploadDraft.findUnique({
    where: { id: draftId },
    select: { previewSummary: true },
  });
  const prevSummary =
    current?.previewSummary && typeof current.previewSummary === "object" && !Array.isArray(current.previewSummary)
      ? (current.previewSummary as Record<string, unknown>)
      : {};

  await prisma.submissionUploadDraft.updateMany({
    where: { id: draftId, status: "submitting", revokedAt: null },
    data: {
      status: "submitted",
      submittedAt: new Date(),
      // Submission is terminal — burn the access-token capability with it,
      // same convention as cancel and the old synchronous submit.
      accessTokenHash: null,
      submitError: stopReason,
      previewSummary: {
        ...prevSummary,
        submittedRows,
        stoppedEarly: stopReason !== null,
        ...(stopReason ? { stopReason } : {}),
      } as Prisma.InputJsonValue,
    },
  });
}

/**
 * `upload_draft.submit` handler.
 *
 * Defensive by construction: this job should only ever run against a draft
 * the submit route just CAS-claimed into `"submitting"`. If the draft is not
 * found, or its status has moved on for any reason, there is nothing for
 * this invocation to do — including a stray duplicate execution, which is
 * therefore always a safe no-op.
 */
export async function runUploadDraftSubmitJob(draftId: string): Promise<void> {
  const draft = await prisma.submissionUploadDraft.findUnique({ where: { id: draftId } });
  if (!draft) {
    console.error(`[upload_draft.submit] draft ${draftId} not found; nothing to do.`);
    return;
  }
  if (draft.status !== "submitting") return;

  if (!draft.bountyId) {
    // Nothing to ingest into — finalize honestly rather than loop forever.
    await finalizeDraft(draftId, "no_target_pool", 0);
    return;
  }
  const bountyId = draft.bountyId;

  let cursor = draft.submitCursorRowNumber ?? 0;
  let totalCreated = 0;
  let stopReason: StopReason = null;

  for (;;) {
    const rows = await prisma.submissionUploadDraftItem.findMany({
      where: { draftId, errorCode: null, submissionId: null, rowNumber: { gt: cursor } },
      orderBy: { rowNumber: "asc" },
      take: CHUNK_SIZE,
    });
    if (rows.length === 0) break; // natural completion — nothing left to submit

    const bounty = await prisma.bounty.findUnique({
      where: { id: bountyId },
      select: { status: true, targetItems: true, acceptedItems: true },
    });
    if (!bounty || (bounty.status as BountyStatus) !== "active") {
      stopReason = "pool_closed";
      break;
    }

    const target = Number(bounty.targetItems);
    const remaining = target > 0 ? Math.max(0, target - Number(bounty.acceptedItems)) : Number.POSITIVE_INFINITY;
    if (remaining === 0) {
      stopReason = "pool_full";
      break;
    }

    let chunk = rows;
    let chunkExhaustsPool = false;
    if (remaining < chunk.length) {
      chunk = chunk.slice(0, remaining);
      chunkExhaustsPool = true;
    }

    const lastRowNumber = chunk[chunk.length - 1]!.rowNumber;

    // THE CRITICAL PART: row-insert(s) for this chunk AND the cursor advance
    // happen in ONE transaction — the entire crash-safety argument this job
    // exists to fix relative to v1 (see module docstring). If the guarded
    // cursor-advance update matches zero rows (the draft was revoked mid-run
    // by the cancel route), `DraftRevokedMidRunError` is thrown so the WHOLE
    // transaction — including every submission/attachment already built in
    // this chunk — rolls back rather than half-committing.
    let revokedMidRun = false;
    try {
      await prisma.$transaction(async (tx) => {
        const fileFields = await fileFieldsForBounty(tx, bountyId);
        const attachRows: AttachRow[] = [];

        for (const item of chunk) {
          const payload = (item.payload ?? {}) as Record<string, unknown>;
          const title = deriveItemTitle(payload, item.rowNumber - 1);
          const dedupeKey = computeDedupeKey(payload);
          const existingDup = await tx.submission.findFirst({
            where: { bountyId, dedupeKey, status: { not: SubmissionStatus.rejected } },
            select: { id: true },
          });
          const lshBands = bandsFromSignature(computeMinHashSignature(payload));
          const nearDupScore = existingDup ? 1.0 : await computeNearDupScore(bountyId, lshBands, tx);

          const sub = await tx.submission.create({
            data: {
              bountyId,
              contributorUserId: draft.ownerUserId,
              title,
              payloadJson: payload as Prisma.InputJsonValue,
              generationMethod: draft.generationMethod ?? GenerationMethod.human,
              dedupeKey,
              status: existingDup ? SubmissionStatus.rejected : SubmissionStatus.submitted,
              duplicateScore: nearDupScore,
              duplicateOfSubmissionId: existingDup?.id,
            },
          });
          await writeLshBands(sub.id, lshBands, tx);

          if (!existingDup) {
            await dbJobQueue.enqueue(
              {
                type: "validation.run",
                idempotencyKey: `val:${sub.id}:0`,
                payload: { submissionId: sub.id, validationAttempt: 0 },
              },
              tx,
            );
          }

          await tx.submissionUploadDraftItem.update({
            where: { id: item.id },
            data: { submissionId: sub.id },
          });
          attachRows.push({ id: sub.id, payload });
        }

        // Same-transaction file binding, same convention as
        // submitPoolBatchItems/createBountyPoolItems.
        await attachFileArtifacts(tx, {
          rows: attachRows,
          fields: fileFields,
          bountyId,
          contributorBatchId: null,
          userId: draft.ownerUserId,
        });

        // Cursor advances in the SAME transaction as the rows it accounts
        // for. Guarded on `revokedAt: null` so a draft cancelled mid-run is
        // never overwritten by a job that started before the cancel landed —
        // and, critically, a failed guard here throws to roll back
        // everything else this chunk just wrote (see comment above).
        const advanced = await tx.submissionUploadDraft.updateMany({
          where: { id: draftId, revokedAt: null },
          data: { submitCursorRowNumber: lastRowNumber },
        });
        if (advanced.count !== 1) throw new DraftRevokedMidRunError();
      }, { timeout: CHUNK_TRANSACTION_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof DraftRevokedMidRunError) {
        revokedMidRun = true;
      } else {
        throw error;
      }
    }

    if (revokedMidRun) {
      // The draft was revoked (cancelled) by someone else mid-run, and the
      // whole chunk transaction rolled back with it — nothing partially
      // committed. Stop gracefully with no further writes, including no
      // finalize: a cancelled draft's terminal state is owned by the cancel
      // route, not this job.
      return;
    }

    cursor = lastRowNumber;
    totalCreated += chunk.length;

    if (chunkExhaustsPool) {
      stopReason = "pool_full";
      break;
    }
  }

  await finalizeDraft(draftId, stopReason, totalCreated);
}
