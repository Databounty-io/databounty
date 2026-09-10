// SPDX-License-Identifier: Apache-2.0

import { randomBytes, createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { getArtifactById } from "./artifacts.js";
import { config } from "../config.js";
import { GenerationMethod, ArtifactKind, BountyKind, type Prisma } from "@prisma/client";

/**
 * Draft creation, SHARED between the REST route (routes/v1/upload-review-
 * drafts.ts POST /) and the MCP tool `create_upload_review_link`, so the two
 * surfaces create IDENTICAL drafts. Before this existed, the MCP tool inlined
 * its own copy that skipped every check here — no bounty existence/kind/status
 * check, no artifact ownership check, a status ("ready") no other code path
 * recognises, and a hardcoded `generationMethod: "ai_assisted"` that
 * mislabelled every human-authored upload with no way for the contributor to
 * correct it.
 */
export class UploadReviewDraftError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function hashUploadReviewToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function opaqueUploadReviewToken(): string {
  return randomBytes(32).toString("hex");
}

export interface CreateUploadReviewDraftParams {
  ownerUserId: string;
  bountyId: string;
  sourceArtifactId?: string;
  /** Honest default matching every other submission path in this codebase
   *  (createBountyPoolItems's REST caller, the plain submissions route, and
   *  this same route) — never "ai_assisted", which has no precedent anywhere
   *  and mislabels the common case. */
  generationMethod?: GenerationMethod;
  expectedItemCount?: number;
  sourceDescription?: string;
}

export interface CreateUploadReviewDraftResult {
  draftId: string;
  handoffUrl: string;
  openBrowser: true;
  expiresAt: Date;
  message: string;
}

export async function createUploadReviewDraft(
  params: CreateUploadReviewDraftParams
): Promise<CreateUploadReviewDraftResult> {
  const bounty = await prisma.bounty.findUnique({ where: { id: params.bountyId } });
  if (!bounty || bounty.kind !== BountyKind.community || bounty.status !== "active") {
    throw new UploadReviewDraftError("not_found", 404, "Upload target not found.");
  }

  let initialStatus = "awaiting_upload";
  if (params.sourceArtifactId) {
    const artifact = await getArtifactById(params.sourceArtifactId);
    if (
      !artifact ||
      artifact.ownerUserId !== params.ownerUserId ||
      artifact.kind !== ArtifactKind.bulk_submission_source ||
      artifact.bountyId !== bounty.id
    ) {
      throw new UploadReviewDraftError(
        "bad_request",
        400,
        "sourceArtifactId must reference a bulk-source file you uploaded for this bounty."
      );
    }
    initialStatus = "uploading";
  }

  const token = opaqueUploadReviewToken();
  const now = new Date();
  const tokenExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const draftExpiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const draft = await prisma.submissionUploadDraft.create({
    data: {
      ownerUserId: params.ownerUserId,
      targetKind: "community_pool",
      bountyId: bounty.id,
      sourceArtifactId: params.sourceArtifactId ?? null,
      generationMethod: params.generationMethod ?? GenerationMethod.human,
      expectedItemCount: params.expectedItemCount,
      sourceDescription: params.sourceDescription,
      tokenHash: hashUploadReviewToken(token),
      tokenExpiresAt,
      draftExpiresAt,
      status: initialStatus,
    },
  });

  return {
    draftId: draft.id,
    handoffUrl: `${config.appUrl.replace(/\/+$/, "")}/upload/${token}`,
    openBrowser: true,
    expiresAt: draft.tokenExpiresAt,
    message: "The browser can open this link for upload and review. Nothing has been submitted.",
  };
}

/**
 * Upload-review-draft capability revocation (SEC-09 follow-up).
 *
 * `routes/v1/upload-review-drafts.ts` mints two capability tokens per draft
 * while the owner is eligible: the one-time handoff `tokenHash` and the
 * longer-lived `accessTokenHash` created on redemption. Both live for the
 * draft's TTL, and that route filters every lookup on `revokedAt: null`, so
 * setting `revokedAt` is what makes a token stop resolving. Cancel and submit
 * already clear `accessTokenHash` when they end a draft; this does the same so
 * a leaked value can never be replayed.
 *
 * Call it INSIDE the transaction that makes the owner ineligible (an admin
 * flipping `User.status` away from `active`), so there is no window in which
 * the account is suspended but an outstanding capability still works.
 *
 * Scope is the capability only. The draft rows, their items and the uploaded
 * source artifact are NOT cancelled or deleted — the owner's data stays.
 * Already cancelled/submitted drafts burned their own capability and are left
 * alone; everything else (including `submitting`) is still live and is revoked.
 *
 * Re-activation does not un-revoke. A re-activated user mints fresh drafts
 * through the normal path; nothing here (or anywhere) resurrects the old ones.
 */
export const LIVE_DRAFT_TERMINAL_STATUSES = ["cancelled", "submitted"] as const;

export async function revokeLiveUploadReviewDraftCapabilities(
  tx: Prisma.TransactionClient,
  ownerUserId: string,
  now: Date = new Date()
): Promise<number> {
  const revoked = await tx.submissionUploadDraft.updateMany({
    where: { ownerUserId, revokedAt: null, status: { notIn: [...LIVE_DRAFT_TERMINAL_STATUSES] } },
    data: { revokedAt: now, accessTokenHash: null },
  });
  return revoked.count;
}
