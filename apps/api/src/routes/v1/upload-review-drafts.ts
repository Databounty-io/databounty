// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomBytes, createHash } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireVerifiedEmail, getAuthedUser, type AuthedUser } from "../../lib/rbac.js";
import { createUploadSlot, completeUpload, getArtifactById } from "../../services/artifacts.js";
import { getPoolContractForBounty } from "../../services/bounties.js";
import { enqueueBulkSourceParse } from "../../services/jobs/bulk-source-parse.js";
import { enqueueUploadDraftSubmit } from "../../services/jobs/upload-draft-submit.js";
import { config } from "../../config.js";
import { GenerationMethod, ArtifactKind, BountyKind, type SubmissionUploadDraft } from "@prisma/client";
import {
  createUploadReviewDraft,
  UploadReviewDraftError as CreateDraftError,
} from "../../services/upload-review-drafts.js";

/**
 * Browser-review handoff for MCP/agent-driven bulk uploads. An authenticated
 * agent creates a draft (POST /), hands the person doing the upload a
 * one-time link, and everything past that point happens in a browser tab
 * that frequently has NO dashboard session at all — that friction is exactly
 * what this flow exists to remove.
 *
 * Two distinct credentials are in play and they are never conflated:
 *  1. The one-time handoff token (`POST /redeem`) — the link IS the
 *     credential, single-use, short-lived, no session required.
 *  2. The draft-scoped access token minted at redemption
 *     (`x-upload-draft-token` header) — authorizes every later call on that
 *     ONE draft for the rest of its life, again without a session.
 * An authenticated dashboard session belonging to the draft's owner is
 * always accepted as an alternative to the access token, so the same person
 * signed in on their own device can manage the draft too.
 */

const ACCESS_TOKEN_HEADER = "x-upload-draft-token";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function opaqueToken(): string {
  return randomBytes(32).toString("hex");
}

// Kept as a distinct local class from the shared `CreateDraftError`
// (services/upload-review-drafts.ts): every OTHER route in this file — redeem,
// cancel, submit, attach-source — operates on an EXISTING draft under a
// draft-scoped token or session, a different failure surface than create's
// bounty/artifact validation. `sendDraftError` recognises both.
class UploadReviewDraftError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function sendDraftError(reply: FastifyReply, error: unknown) {
  if (error instanceof UploadReviewDraftError || error instanceof CreateDraftError) {
    return reply.code(error.status).send({ statusCode: error.status, code: error.code, message: error.message });
  }
  throw error;
}

/** Every current registry dataset type is text/JSON-field only (see
 *  services/bounties.ts's getPoolContractForBounty) — there is no
 *  dataset-type-scoped file-upload policy wired up for community pools yet,
 *  so browser file review is honestly reported unavailable rather than
 *  fabricated. Reuses that same function (single source of truth) instead of
 *  duplicating the literal here, so the two surfaces cannot drift apart. */
async function sourceUploadFor(bountyId: string) {
  const contract = await getPoolContractForBounty(bountyId);
  return (
    contract?.sourceUpload ?? {
      profile: "none",
      version: 1,
      extensions: [] as string[],
      mimeTypes: [] as string[],
      accept: "",
      available: false,
      unavailableReason: "This dataset pool is not available for browser upload review.",
    }
  );
}

/**
 * Account-eligibility rule for the draft owner. This is deliberately the
 * SAME predicate the ordinary session path already applies — `status !==
 * "active"` in `lib/session.ts` (`getUserFromSessionToken`) and
 * `lib/rbac.ts` (the API-key branch of `getAuthedUser`). `UserStatus` has
 * exactly two members (`active`, `suspended`), so testing for `active`
 * rather than for `suspended` also fails closed if a third status is ever
 * added. Do not restate this as a suspended-only check: a second, divergent
 * definition of "eligible" is how SEC-09 happened in the first place.
 */
function ownerAccountEligible(owner: { status: string }): boolean {
  return owner.status === "active";
}

/** Reconstruct the AuthedUser the draft's owner would have if they were
 * signed in themselves. Everything done through the draft-scoped access
 * token is attributed to this account — the token confers no identity of
 * its own, only a narrow capability over one draft.
 *
 * SEC-09: this is also where owner account eligibility is enforced, and it
 * is enforced on EVERY capability action rather than only at mint time,
 * because `resolveDraftAccess` calls it on every request that presents the
 * draft-scoped token. Before this check a valid, unexpired capability kept
 * working after the owning account was suspended (read and cancel both
 * returned 200 and the draft was actually cancelled) while the same
 * account's ordinary session was correctly rejected.
 *
 * The suspended case is a 403, not the route's usual privacy-preserving
 * 404: the caller has already proved possession of a capability scoped to
 * this one draft, so there is nothing left to probe, and an honest reason
 * is what lets the browser tab say something true. Copy matches the
 * existing suspended-account rejection in `routes/v1/auth.ts`. */
async function draftOwner(ownerUserId: string): Promise<AuthedUser> {
  const owner = await prisma.user.findUnique({
    where: { id: ownerUserId },
    include: { roles: true },
  });
  if (!owner) throw new UploadReviewDraftError("DRAFT_NOT_FOUND", 404, "Not found.");
  if (!ownerAccountEligible(owner)) {
    throw new UploadReviewDraftError("ACCOUNT_SUSPENDED", 403, "Account is suspended");
  }
  return {
    id: owner.id,
    email: owner.email,
    displayName: owner.displayName,
    roles: owner.roles.map((r) => r.role),
    emailVerifiedAt: owner.emailVerifiedAt,
    credentialKind: "session",
  };
}

/**
 * Resolve a draft from EITHER the session-less draft-scoped access token or
 * an owning dashboard session, and return the actor to attribute the work
 * to.
 *
 * Both paths converge on the same 404 for "not this caller's draft": a
 * revoked/expired/unknown draft and someone else's real draft are
 * deliberately indistinguishable, so neither a guessed token nor a stranger
 * probing draft ids by number can learn whether a given id exists. A missing
 * credential entirely (no token header, no session at all) is the one case
 * that gets a plain 401 — there is nothing to probe there.
 */
async function resolveDraftAccess(req: FastifyRequest): Promise<{ draft: SubmissionUploadDraft; actor: AuthedUser }> {
  const draftId = String((req.params as { id?: string }).id ?? "");
  const now = new Date();
  const rawToken = req.headers[ACCESS_TOKEN_HEADER];

  if (typeof rawToken === "string" && rawToken.length >= 32) {
    const draft = await prisma.submissionUploadDraft.findFirst({
      where: { accessTokenHash: hashToken(rawToken), revokedAt: null },
    });
    // A token is scoped to its own draft. Without this check, a valid token
    // would read/act on any draft id the caller pasted into the path.
    if (!draft || draft.id !== draftId || draft.draftExpiresAt <= now) {
      throw new UploadReviewDraftError("DRAFT_NOT_FOUND", 404, "Not found.");
    }
    return { draft, actor: await draftOwner(draft.ownerUserId) };
  }

  const user = await getAuthedUser(req);
  if (!user) throw new UploadReviewDraftError("NO_CREDENTIAL", 401, "Sign in required, or provide a valid upload link.");
  // API-key credentials never carry the draft-scoped access token; this
  // route is either the owning dashboard session or the handoff token.
  if (user.apiKeyScopes) throw new UploadReviewDraftError("DRAFT_NOT_FOUND", 404, "Not found.");

  const draft = await prisma.submissionUploadDraft.findFirst({
    where: { id: draftId, ownerUserId: user.id, revokedAt: null },
  });
  if (!draft || draft.draftExpiresAt <= now) throw new UploadReviewDraftError("DRAFT_NOT_FOUND", 404, "Not found.");
  return { draft, actor: user };
}

/**
 * Read-only variant of {@link resolveDraftAccess}, for the status route only.
 *
 * The MCP tool that creates a draft (`create_upload_review_link`) hands off
 * to the browser and, before this, had no way back: `resolveDraftAccess`
 * 404s any API-key/MCP-OAuth credential outright, so once the link was
 * opened the calling agent could never learn whether the person closed the
 * tab, cancelled, or actually submitted — it was flying blind on every
 * handoff. This widens ONLY the read path (status + rejected-rows), and only
 * to the OWNER of the draft — matching `getPoolContractForBounty`-style
 * ownership checks used elsewhere, never to another user's draft. It does
 * NOT touch `resolveDraftAccess` itself, so upload/cancel/submit remain
 * exactly as before: browser session or handoff token only. An API key
 * cannot mutate a draft it can now merely read.
 */
async function resolveDraftReadAccess(req: FastifyRequest): Promise<{ draft: SubmissionUploadDraft; actor: AuthedUser }> {
  const draftId = String((req.params as { id?: string }).id ?? "");
  const now = new Date();
  const rawToken = req.headers[ACCESS_TOKEN_HEADER];

  if (typeof rawToken === "string" && rawToken.length >= 32) {
    const draft = await prisma.submissionUploadDraft.findFirst({
      where: { accessTokenHash: hashToken(rawToken), revokedAt: null },
    });
    if (!draft || draft.id !== draftId || draft.draftExpiresAt <= now) {
      throw new UploadReviewDraftError("DRAFT_NOT_FOUND", 404, "Not found.");
    }
    return { draft, actor: await draftOwner(draft.ownerUserId) };
  }

  const user = await getAuthedUser(req);
  if (!user) throw new UploadReviewDraftError("NO_CREDENTIAL", 401, "Sign in required, or provide a valid upload link.");

  const draft = await prisma.submissionUploadDraft.findFirst({
    where: { id: draftId, ownerUserId: user.id, revokedAt: null },
  });
  if (!draft || draft.draftExpiresAt <= now) throw new UploadReviewDraftError("DRAFT_NOT_FOUND", 404, "Not found.");
  return { draft, actor: user };
}

/** The owner's email-verification gate, enforced here because the token path
 * has no session for `requireVerifiedEmail` to inspect. Checked against the
 * OWNER, so an unverified account cannot use the browser handoff to route
 * around a gate every other submit path applies. */
function requireVerifiedOwner(actor: AuthedUser): void {
  if (!actor.emailVerifiedAt) {
    throw new UploadReviewDraftError(
      "EMAIL_UNVERIFIED",
      403,
      "Verify the account's email address in the dashboard before uploading work."
    );
  }
}

/**
 * Shapes a draft row into what the review page is allowed to see. This is
 * the actual fix for the metadata leak: `sourceArtifactId` alone is
 * returned, never the artifact row it references (filename, storage key,
 * scan verdict) — a caller that needs the artifact goes through
 * GET /v1/artifacts/:id, which applies its own ownership/visibility check.
 * `tokenHash`/`accessTokenHash` are never included either.
 */
async function serializeDraft(draft: SubmissionUploadDraft) {
  const sourceUpload = draft.bountyId
    ? await sourceUploadFor(draft.bountyId)
    : {
        profile: "none",
        version: 1,
        extensions: [] as string[],
        mimeTypes: [] as string[],
        accept: "",
        available: false,
        unavailableReason: "This review has no target bounty.",
      };
  return {
    id: draft.id,
    targetKind: draft.targetKind,
    bountyId: draft.bountyId,
    batchId: draft.contributorBatchId,
    generationMethod: draft.generationMethod,
    expectedItemCount: draft.expectedItemCount,
    sourceDescription: draft.sourceDescription,
    autoSubmitWhenReady: draft.autoSubmitAuthorizedAt !== null,
    status: draft.status,
    sourceArtifactId: draft.sourceArtifactId,
    previewSummary: draft.previewSummary,
    draftExpiresAt: draft.draftExpiresAt,
    submittedAt: draft.submittedAt,
    sourceUpload,
  };
}

/**
 * Owner-scoped draft status, callable directly by the MCP tool
 * (`get_upload_review_status`) the same way `create_upload_review_link`
 * calls `createUploadReviewDraft` directly — no HTTP round-trip through this
 * process's own route needed. Returns `null` rather than throwing when the
 * draft does not exist or belongs to someone else, matching this file's
 * existing "unknown vs. someone else's" non-disclosure — a tool caller gets
 * a clean "not found", never a stack trace or an ownership hint.
 */
export async function getUploadReviewDraftStatusForOwner(ownerUserId: string, draftId: string) {
  const draft = await prisma.submissionUploadDraft.findFirst({
    where: { id: draftId, ownerUserId, revokedAt: null },
  });
  if (!draft) return null;
  return serializeDraft(draft);
}

const createDraftBody = z.object({
  bountyId: z.string().min(1),
  // Optional: a caller (e.g. an MCP agent that already ran
  // prepare_file_upload/complete_file_upload) may hand over a source that is
  // already stored. Omitted, the draft starts `awaiting_upload` and the
  // browser attaches one later via source-slot/source-complete or
  // attach-source.
  sourceArtifactId: z.string().min(1).optional(),
  generationMethod: z.nativeEnum(GenerationMethod).default(GenerationMethod.human),
  expectedItemCount: z.number().int().positive().optional(),
  sourceDescription: z.string().trim().max(500).optional(),
});

const RedeemBody = z.object({ token: z.string().min(32).max(256) });
const AttachSourceBody = z.object({ artifactId: z.string().min(1) });
const SourceSlotBody = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive().optional(),
  // Required only when the active storage driver supports direct upload
  // (createUploadSlot enforces this itself, with the driver-aware message —
  // same pattern as routes/v1/artifacts.ts's own upload-slot schema). This
  // field was missing here entirely: the web client (lib/api-artifacts.ts's
  // uploadDraftSource) has always computed and sent checksumSha256, but Zod
  // silently drops unknown keys on a non-strict schema, so createUploadSlot
  // never received it and every source-slot call failed outright on any
  // S3-backed (direct-upload-capable) deployment — this route's file-upload
  // step could never have worked in dev or staging, only ever tested
  // successfully against a local-disk-driver deployment where the checksum
  // isn't required at all.
  checksumSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, "checksumSha256 must be a hex SHA-256 digest")
    .optional(),
});

export async function uploadReviewDraftRoutes(app: FastifyInstance) {
  // Create Draft from Upload. Session-only, by design — there is no draft
  // yet for a handoff token to be scoped to.
  app.post(
    "/",
    { preHandler: [requireAuth, requireVerifiedEmail], config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
      const parsed = createDraftBody.safeParse(req.body);
      if (!parsed.success) return reply.badRequest(parsed.error.message);

      try {
        const result = await createUploadReviewDraft({
          ownerUserId: user.id,
          bountyId: parsed.data.bountyId,
          sourceArtifactId: parsed.data.sourceArtifactId,
          generationMethod: parsed.data.generationMethod,
          expectedItemCount: parsed.data.expectedItemCount,
          sourceDescription: parsed.data.sourceDescription,
        });
        return reply.status(201).send(result);
      } catch (error) {
        return sendDraftError(reply, error);
      }
    }
  );

  // Redeem the one-time handoff link. NO SESSION REQUIRED — the link itself
  // is the credential (see module docstring). Single-use: a guarded update
  // consumes it atomically and mints the draft-scoped access token the
  // browser presents on every later call.
  app.post("/redeem", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    const parsed = RedeemBody.safeParse(req.body);
    if (!parsed.success) return reply.notFound();

    const now = new Date();
    const draft = await prisma.submissionUploadDraft.findUnique({ where: { tokenHash: hashToken(parsed.data.token) } });
    // Every failure mode (unknown token, already redeemed, revoked, expired
    // link, expired draft) collapses to the same 404 — no target metadata.
    if (!draft || draft.redeemedAt || draft.revokedAt || draft.tokenExpiresAt <= now || draft.draftExpiresAt <= now) {
      return reply.notFound();
    }

    // SEC-09: owner account eligibility at redemption too, not only on the
    // later capability actions — a suspended owner's handoff link must not
    // be exchangeable for a fresh draft-scoped token. Unlike the action
    // paths this stays a bare 404: the handoff link is a one-time credential
    // that may be held by whoever is doing the upload, and every other
    // failure mode here deliberately collapses to the same 404 so no target
    // metadata (including "this account exists but is suspended") leaks.
    const owner = await prisma.user.findUnique({ where: { id: draft.ownerUserId }, select: { status: true } });
    if (!owner || !ownerAccountEligible(owner)) return reply.notFound();

    const accessToken = opaqueToken();
    const redeemed = await prisma.submissionUploadDraft.updateMany({
      where: {
        id: draft.id,
        redeemedAt: null,
        revokedAt: null,
        tokenExpiresAt: { gt: now },
        draftExpiresAt: { gt: now },
      },
      data: { redeemedAt: now, accessTokenHash: hashToken(accessToken) },
    });
    if (redeemed.count !== 1) return reply.notFound();

    return reply.send({
      draftId: draft.id,
      accessToken,
      accessTokenExpiresAt: draft.draftExpiresAt,
      redirectPath: `/upload-review/${draft.id}`,
    });
  });

  // Get Draft by ID. Was completely unauthenticated and returned the full
  // `sourceArtifact` relation (filename, storage key, scan verdict) for any
  // id. Now requires either the draft-scoped access token or the owning
  // session, and never serializes the artifact row (see serializeDraft).
  app.get("/:id", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const { draft } = await resolveDraftReadAccess(req);
      return reply.send({ draft: await serializeDraft(draft) });
    } catch (error) {
      return sendDraftError(reply, error);
    }
  });

  // Rejected-row report. Generated from immutable draft rows and requires
  // either the draft capability or the owning session — never a public
  // object-store URL.
  app.get("/:id/rejected-rows", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    try {
      const { draft } = await resolveDraftAccess(req);
      const rows = await prisma.submissionUploadDraftItem.findMany({
        where: { draftId: draft.id, errorCode: { not: null } },
        select: { rowNumber: true, errorCode: true, errorMessage: true },
        orderBy: { rowNumber: "asc" },
      });
      reply.header("Cache-Control", "no-store");
      reply.header("Content-Disposition", `attachment; filename=upload-review-${draft.id}-rejected-rows.json`);
      return reply.type("application/json").send({ draftId: draft.id, generatedAt: new Date().toISOString(), rejectedRows: rows });
    } catch (error) {
      return sendDraftError(reply, error);
    }
  });

  // Cancel. Owner (session or draft-scoped token) only.
  app.post("/:id/cancel", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    try {
      const { draft, actor } = await resolveDraftAccess(req);
      if (draft.status === "submitted") return reply.conflict("A submitted review cannot be cancelled.");

      const now = new Date();
      // A `submitting` draft normally means another request is mid-submit,
      // so cancel is refused. But if that process crashed between creating
      // submissions and marking the draft `submitted`, the row would
      // otherwise stay `submitting` until the draft TTL — unrecoverable.
      // Permit cancel of a `submitting` draft only once it is demonstrably
      // stale, so a genuinely in-flight submit is never cut off.
      const staleSubmittingCutoff = new Date(now.getTime() - 10 * 60 * 1000);
      const cancelled = await prisma.submissionUploadDraft.updateMany({
        where: {
          id: draft.id,
          ownerUserId: actor.id,
          revokedAt: null,
          OR: [{ status: { not: "submitting" } }, { status: "submitting", updatedAt: { lt: staleSubmittingCutoff } }],
        },
        data: { revokedAt: now, status: "cancelled" },
      });
      if (cancelled.count !== 1) return reply.conflict("This review is being submitted. Wait for it to finish before retrying.");

      // Cancellation is terminal — burn the access-token capability with it.
      await prisma.submissionUploadDraft.updateMany({ where: { id: draft.id }, data: { accessTokenHash: null } });
      return reply.send({ cancelled: true, draftId: draft.id });
    } catch (error) {
      return sendDraftError(reply, error);
    }
  });

  /**
   * Draft-scoped upload slot for the source file. The session-less browser
   * cannot call POST /v1/artifacts/upload-slot directly — that route
   * requires an `artifact`/`contribute`-scoped credential — so this issues
   * one on the draft owner's behalf via the same
   * services/artifacts.ts#createUploadSlot the generic route uses. The
   * returned upload target carries its own capability token
   * (see services/artifacts.ts#verifyUploadToken), so the browser can PUT the
   * bytes to POST /v1/artifacts/:id/content with no credential at all —
   * identical to how a regular dashboard upload works.
   */
  app.post("/:id/source-slot", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = SourceSlotBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.issues[0]?.message ?? "invalid upload slot request");
    try {
      const { draft, actor } = await resolveDraftAccess(req);
      requireVerifiedOwner(actor);
      if (draft.sourceArtifactId || draft.status !== "awaiting_upload") return reply.conflict("This review already has a source file.");
      if (!draft.bountyId) return reply.conflict("This review has no target bounty.");

      const sourceUpload = await sourceUploadFor(draft.bountyId);
      if (!sourceUpload.available) {
        return reply.conflict(sourceUpload.unavailableReason ?? "This dataset source format is not available for browser review.");
      }
      const filename = parsed.data.filename.toLowerCase();
      if (!sourceUpload.extensions.some((ext: string) => filename.endsWith(ext.toLowerCase()))) {
        return reply.badRequest(`This file's type is not accepted for this dataset. Allowed: ${sourceUpload.extensions.join(", ")}.`);
      }

      const slot = await createUploadSlot({
        ownerUserId: actor.id,
        kind: ArtifactKind.bulk_submission_source,
        filename: parsed.data.filename,
        contentType: parsed.data.contentType,
        declaredSizeBytes: parsed.data.sizeBytes,
        checksumSha256: parsed.data.checksumSha256,
        bountyId: draft.bountyId,
      });

      return reply.code(201).send({
        artifactId: slot.artifactId,
        // `slot.upload` is relative ONLY on the local-driver token fallback
        // (see createUploadSlot) — a real direct-upload target is already
        // absolute. The browser resolves a relative `url` against its own
        // origin, not this API's, so the fallback case must be absolutized.
        upload: slot.upload.url.startsWith("/")
          ? { ...slot.upload, url: `${req.protocol}://${req.headers.host}${slot.upload.url}` }
          : slot.upload,
      });
    } catch (error) {
      return sendDraftError(reply, error);
    }
  });

  /** Completion half of the draft-scoped upload: hands off to
   * services/artifacts.ts#completeUpload (ownership check + real
   * `artifact.scan` job enqueue, exactly like the generic route), then
   * attaches the artifact to this draft in one guarded call so the browser
   * can never end up with a completed artifact and no draft to show for it. */
  app.post("/:id/source-complete", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = AttachSourceBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest("artifactId required");
    try {
      const { draft, actor } = await resolveDraftAccess(req);
      requireVerifiedOwner(actor);
      if (draft.sourceArtifactId || draft.status !== "awaiting_upload") return reply.conflict("This review already has a source file.");

      let completed;
      try {
        completed = await completeUpload(parsed.data.artifactId, actor.id);
      } catch (err) {
        return reply.badRequest(err instanceof Error ? err.message : "Could not complete this upload.");
      }
      if (completed.bountyId !== draft.bountyId) return reply.notFound("Not found.");

      const attached = await prisma.submissionUploadDraft.updateMany({
        where: { id: draft.id, sourceArtifactId: null, status: "awaiting_upload" },
        data: { sourceArtifactId: completed.id, status: "uploading" },
      });
      if (attached.count !== 1) return reply.conflict("This review already has a source file.");

      // The source is now owned by a draft, so the parser has somewhere
      // honest to put its rows. Enqueue here as well as from the scan handler
      // (services/artifacts.ts) because the two orders race: the scan can
      // finish before this attach commits, and it refuses to parse a source
      // with no draft. Same idempotency key, so at most one job exists either
      // way, and the persisted `bulkParseCursor` makes a re-arm resume.
      await enqueueBulkSourceParse(parsed.data.artifactId);

      const updated = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draft.id } });
      return reply.send({ draft: await serializeDraft(updated) });
    } catch (error) {
      return sendDraftError(reply, error);
    }
  });

  /** Attach an already-uploaded, already-completed artifact (e.g. one an MCP
   * agent prepared via prepare_file_upload/complete_file_upload before
   * creating the draft) instead of going through source-slot/source-complete. */
  app.post("/:id/attach-source", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = AttachSourceBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest("artifactId required");
    try {
      const { draft, actor } = await resolveDraftAccess(req);
      requireVerifiedOwner(actor);
      if (draft.sourceArtifactId || draft.status !== "awaiting_upload") return reply.conflict("This review already has a source file.");
      if (!draft.bountyId) return reply.conflict("This review has no target bounty.");

      const sourceUpload = await sourceUploadFor(draft.bountyId);
      if (!sourceUpload.available) {
        return reply.conflict(sourceUpload.unavailableReason ?? "This dataset source format is not available for browser review.");
      }

      const artifact = await prisma.artifact.findFirst({
        where: { id: parsed.data.artifactId, ownerUserId: actor.id, kind: ArtifactKind.bulk_submission_source, status: { not: "deleted" } },
      });
      if (!artifact || artifact.bountyId !== draft.bountyId) return reply.notFound("Not found.");

      // Fail closed on the source format at the boundary (Universal
      // Modality Invariant): validate extension and declared/detected MIME
      // against the dataset's allowlist before it can ever be treated as
      // this draft's source.
      const filename = artifact.filename.toLowerCase();
      const extensionOk = sourceUpload.extensions.some((ext: string) => filename.endsWith(ext.toLowerCase()));
      const declaredMime = (artifact.detectedMimeType ?? artifact.contentType ?? "").toLowerCase();
      const allowedMimes = sourceUpload.mimeTypes.map((m: string) => m.toLowerCase());
      const mimeOk = declaredMime.length === 0 || allowedMimes.length === 0 || allowedMimes.includes(declaredMime);
      if (!extensionOk || !mimeOk) {
        return reply.badRequest(`This file's type is not accepted for this dataset. Allowed: ${sourceUpload.extensions.join(", ")}.`);
      }

      // Claim the attachment atomically — a pre-read alone would let two
      // concurrent calls race the unique sourceArtifactId constraint into a
      // 500 instead of an honest 409.
      const attached = await prisma.submissionUploadDraft.updateMany({
        where: { id: draft.id, ownerUserId: actor.id, sourceArtifactId: null, status: "awaiting_upload" },
        data: { sourceArtifactId: artifact.id, status: "uploading" },
      });
      if (attached.count !== 1) return reply.conflict("This review already has a source file.");

      // The source is now owned by a draft, so the parser has somewhere
      // honest to put its rows. Enqueue here as well as from the scan handler
      // (services/artifacts.ts) because the two orders race: the scan can
      // finish before this attach commits, and it refuses to parse a source
      // with no draft. Same idempotency key, so at most one job exists either
      // way, and the persisted `bulkParseCursor` makes a re-arm resume.
      await enqueueBulkSourceParse(parsed.data.artifactId);

      const updated = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draft.id } });
      return reply.send({ draft: await serializeDraft(updated) });
    } catch (error) {
      return sendDraftError(reply, error);
    }
  });

  // Submit Draft items into the pool. Accepts either the owning session or
  // the draft-scoped access token — the browser-review page carries no
  // session, so gating this on requireAuth alone (as before) meant a
  // redeemed draft could never actually be submitted.
  //
  // This used to be a synchronous no-op: it flipped `status` to "submitted"
  // and returned 200, never reading a single parsed row and never creating a
  // Submission. It is now a real async ingest: this handler only CAS-claims
  // the draft into "submitting" and enqueues `upload_draft.submit`
  // (services/jobs/upload-draft-submit.ts) to do the actual work in bounded,
  // crash-safe chunks, then returns 202. The one exception is the already-
  // `submitted` case below, which stays a synchronous 200 for idempotent
  // replay of a finished submit.
  app.post("/:id/submit", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    try {
      const { draft, actor } = await resolveDraftAccess(req);
      requireVerifiedOwner(actor);
      if (draft.status === "submitted") return reply.send({ ok: true, draftId: draft.id, alreadySubmitted: true });
      if (draft.status === "submitting") return reply.conflict("This review is already being submitted.");

      // The bulk-source parse job (services/jobs/bulk-source-parse.ts, owned
      // by a different agent working concurrently in this session) writes
      // status: "review_ready" when parsing finishes cleanly — confirmed by
      // re-reading that file just before writing this route. "review" is
      // kept accepted here too as a defensive fallback in case an
      // in-flight draft was parsed by an older worker process before that
      // rename landed; it costs nothing to accept both.
      const REVIEW_READY_STATUSES = new Set(["review", "review_ready"]);
      if (!REVIEW_READY_STATUSES.has(draft.status)) {
        return reply.conflict("This upload has not finished being reviewed yet.");
      }

      const usableRowCount = await prisma.submissionUploadDraftItem.count({
        where: { draftId: draft.id, errorCode: null },
      });
      if (usableRowCount === 0) {
        return reply.badRequest("No valid rows are available to submit.");
      }

      // CAS claim: only one caller can move this draft from its review-ready
      // status into "submitting". A concurrent second call loses the race
      // and gets an honest 409 rather than either double-enqueuing the job
      // or silently no-op'ing.
      const claimed = await prisma.submissionUploadDraft.updateMany({
        where: { id: draft.id, status: draft.status },
        data: { status: "submitting" },
      });
      if (claimed.count !== 1) {
        return reply.conflict("This review is already being submitted.");
      }

      // Enqueued exactly once, right after winning the claim above — never
      // re-armed by anything else (see upload-draft-submit.ts module
      // docstring for why that matters).
      await enqueueUploadDraftSubmit(draft.id);

      return reply.code(202).send({
        submitted: false,
        submitting: true,
        draftId: draft.id,
        count: usableRowCount,
      });
    } catch (error) {
      return sendDraftError(reply, error);
    }
  });
}
