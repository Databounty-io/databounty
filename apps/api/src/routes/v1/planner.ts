// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PUBLIC_DATASET_TYPE_SELECT } from "../../lib/public-query.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireVerifiedEmail, type AuthedUser } from "../../lib/rbac.js";
import { openRouterConfigured } from "../../services/llm-client.js";
import { llmValidationEnabled } from "../../services/admin-settings.js";
import { languageSupportFor } from "../../services/execution.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { REQUIRED_SPONSOR_EXAMPLES_DEFAULT } from "../../services/artifacts.js";
import {
  PLANNER_STEPS,
  PLANNER_STEP_KEYS,
  answersSchema,
  canonicalLanguageFor,
  resolveType,
  isLaunchableType,
  validateAnswers,
  buildKarmaPreview,
  normalizeTranscript,
  sponsorTypeFieldSchema,
  guessSponsorFields,
  uniqueDatasetTypeId,
  suggestRequestTitles,
  finalizeIdempotencyKey,
  DatasetTypeOrigin,
  TrustTier,
  type PlannerAnswers,
  type TranscriptMsg,
} from "../../services/planner.js";
// Same `contractIntegrityError` admin-dataset-types.ts uses to gate
// activation — see that file's doc comment for why this is now the one
// canonical check instead of a second, laxer copy that used to live in
// services/planner.ts.
import { contractIntegrityError } from "./admin-dataset-types.js";
import {
  validateSponsorField,
  type PlannerField,
} from "../../services/llm/consumers/validate-field.js";
import { generatePlannerCopy } from "../../services/llm/consumers/planner-copy.js";
import {
  fallbackDescriptions,
  suggestRequestDescriptions,
} from "../../services/llm/consumers/suggest-description.js";
import {
  draftCustomDatasetType,
  fallbackDraft,
  type DatasetTypeDraft,
  type DatasetTypeDraftFork,
} from "../../services/llm/consumers/dataset-type-draft.js";
import { ArtifactStatus, DatasetCategory, DatasetTypeStatus, DomainId, Prisma } from "@prisma/client";

/** The authed user attached by requireAuth/requireVerifiedEmail. */
function authed(req: unknown): AuthedUser {
  return (req as { authedUser: AuthedUser }).authedUser;
}

class SessionFinalizedError extends Error {}
class VersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super("version conflict");
  }
}

/** Community-planner counterpart of databounty-api's routes/v1/planner.ts
 * (13 endpoints there). See services/planner.ts's file header for the full
 * disposition. Ported here, unchanged in spirit: catalog, preview,
 * dataset-type proposals, session CRUD, answers, finalize, and the single
 * `assist` intents. All four v1 `/assist` intents are now implemented —
 * `title`, `validate_field`, `planner_copy` and `draft_type` — plus one v1
 * does not have, `description` (flagged deviation; see
 * services/llm/consumers/suggest-description.ts), backed by the
 * ported LLM layer in services/llm/ (see that directory's service.ts for the
 * no-throw contract and governor.ts for the one v1 capability deliberately
 * left out). NOT ported: `POST`/`GET /funded-interest` (v1's "notify me when
 * funded bounties launch" capture — this deployment has no funded track at
 * all, so there is nothing to be notified about).
 */
export async function plannerRoutes(app: FastifyInstance) {
  // GET /v1/planner/catalog — thin-wraps the SAME query GET /v1/community/
  // catalog runs (routes/v1/community.ts) — identical `status: "active"`
  // filter and `orderBy: { usageCount: "desc" }` — so the two endpoints can
  // never disagree about which types are offered. That route's query is an
  // inline handler body, not an exported service function, and
  // routes/v1/community.ts is outside this change's scope (owned by other
  // concurrent work), so it is reproduced here rather than imported; a
  // follow-up should extract one shared `listActiveDatasetTypes()` helper.
  // Adds the planner-specific envelope (deadlineSettings/llmValidationEnabled/
  // sampleGate) the web client's `hydratePlannerCatalog` destructures
  // (community/apps/web/lib/store.tsx) — this is the fix for the reported
  // defect: before this route existed, that call 404'd and the sponsor UI
  // silently fell back to a hardcoded catalog where 3 of 5 offered types
  // don't exist in the real DB, 500ing on submit.
  app.get("/catalog", async (req, reply) => {
    const query = req.query as { domain?: DomainId; category?: DatasetCategory };
    const where: Prisma.DatasetTypeWhereInput = {
      status: DatasetTypeStatus.active,
      ...(query.domain ? { domain: query.domain } : {}),
      ...(query.category ? { category: query.category } : {}),
    };
    // Unauthenticated route (the sponsor planner loads it before sign-in), so
    // it takes the same public allowlist as the community catalog rather than
    // returning every column of the row.
    const types = await prisma.datasetType.findMany({
      where,
      select: PUBLIC_DATASET_TYPE_SELECT,
      orderBy: { usageCount: "desc" },
    });
    // The flag and the provider are two different facts and are reported as
    // two fields. This line used to be `openRouterConfigured()` alone, i.e.
    // it answered "is a provider wired up" under the NAME of the admin
    // switch — so with the switch off and a key present the planner told the
    // sponsor LLM review was enabled, and with the switch on and no key it
    // said it was off. Both directions were wrong.
    const llmEnabled = await llmValidationEnabled();
    const llmProviderConfigured = openRouterConfigured();

    return reply.send({
      steps: PLANNER_STEPS,
      // This deployment has no admin-configurable `planner.deadline.*`
      // setting (community pools are open-ended — Bounty.deadline exists on
      // the schema but is not wired for community requests). Returned as a
      // static value only so a client written against v1's contract gets a
      // present, sane field instead of `undefined` — it carries no live
      // configuration and no route in this deployment reads it back.
      deadlineSettings: { presetDays: [30, 60, 90], maxDays: 365, extensionPct: 75 },
      // No admin-configurable `planner.sample_gate.*` setting exists, so both
      // ends come from REQUIRED_SPONSOR_EXAMPLES_DEFAULT
      // (services/artifacts.ts) — the same constant the request's own
      // mint-readiness gate counts against.
      //
      // `min` was hardcoded to 2 while that gate requires 3 APPROVED samples,
      // so a sponsor who attached exactly the 2 the planner asked for could
      // never satisfy the gate. Harmless only while samples never reached the
      // request at all; now that finalize carries them forward, asking for
      // fewer than the gate requires is a guaranteed dead end.
      sampleGate: { min: REQUIRED_SPONSOR_EXAMPLES_DEFAULT, max: REQUIRED_SPONSOR_EXAMPLES_DEFAULT },
      llmValidationEnabled: llmEnabled,
      llmProviderConfigured,
      datasetTypes: types.map((t) => ({
        id: t.id,
        version: t.version,
        name: t.name,
        description: t.description,
        domain: t.domain,
        category: t.category,
        status: t.status,
        origin: t.origin,
        trustTier: t.trustTier,
        difficultyLevels: t.difficultyLevels,
        auditOptions: auditOptionsFor(t.verification),
        // Which languages this template's own harness can actually verify,
        // computed from the contract and the sandbox image (services/
        // execution-providers/language-support.ts — three inputs intersected:
        // what the type DECLARES, what the harness CAN RUN, and what the
        // configured sandbox chain has INSTALLED). Served because the planner's
        // language step would otherwise render a hardcoded list that says
        // nothing about execution: against the live catalog such a list offers
        // Java on types that only accept Python, offers SQL when no active type
        // accepts it, and offers nothing valid at all for the C, bash, regex and
        // GraphQL templates — while `assist:validate_field` DOES receive the
        // dataset type and rejects the answer one call later.
        // `mode: "fixed"` means the contract permits exactly one answer and the
        // step must state it rather than ask; `none` means the type has no
        // executable fields and the step is skipped; `unverifiable` entries are
        // still offered but must be labelled, never presented as
        // execution-verified.
        languageSupport: languageSupportFor(t),
        fields: t.fields,
        verification: t.verification,
        sampleAssets: t.sampleAssets,
        usageCount: t.usageCount,
      })),
    });
  });

  // POST /v1/planner/preview — real, live-computed karma-pricing preview for
  // a not-yet-created request (community's replacement for v1's $-budget
  // preview — see services/planner.ts buildKarmaPreview doc comment for why
  // the underlying math had to change, not just be relabeled).
  app.post("/preview", { preHandler: [requireAuth, requireVerifiedEmail] }, async (req, reply) => {
    const body = z
      .object({
        category: z.string().min(1),
        targetItems: z.number().int().min(10).max(100_000),
        difficultyMix: z.enum(["mostly_beginner", "balanced", "mostly_advanced"]).optional(),
        auditCoveragePct: z.number().int().min(0).max(100).optional(),
      })
      .parse(req.body);

    const type = await resolveType(body.category);
    if (!type) return reply.badRequest("unknown dataset type");
    if (!isLaunchableType(type)) return reply.badRequest("dataset type is not available for new requests");

    const preview = await buildKarmaPreview(type, body);
    return { preview };
  });

  // POST /v1/planner/dataset-types/requests — sponsor-proposed NEW dataset
  // type (distinct from a DatasetRequest, which asks for an instance of an
  // EXISTING type). Ported from v1's routes/v1/planner.ts equivalent; see
  // services/planner.ts's file header for what's carried over vs. adapted
  // (no LLM-drafting helpers exist here, so the fields fallback is
  // deterministic-only — same failure-open guarantee, less machinery).
  app.post("/dataset-types/requests", { preHandler: [requireAuth, requireVerifiedEmail] }, async (req, reply) => {
    const body = z
      .object({
        name: z.string().trim().min(3).max(160),
        description: z.string().trim().min(3).max(2000),
        fields: z.array(sponsorTypeFieldSchema).min(2).max(100).optional(),
        pipeline: z.array(z.string()).min(2).max(7).optional(),
        dedupeFields: z.array(z.string().trim().min(1).max(80)).min(1).max(10).optional(),
        auditOptions: z.array(z.number().int().min(0).max(100)).min(1).max(4).optional(),
        forkedFromTypeId: z.string().trim().min(1).max(120).optional(),
        // Plain-text request for sandboxed execution verification — see the
        // `DatasetType.sponsorHarnessNote` doc comment (schema.prisma) for
        // why this is informational-only and never executable. Harness
        // AUTHORING stays admin-only (admin-harness.ts); this field cannot
        // create, bind, or run anything.
        harnessNote: z.string().trim().min(1).max(2000).optional(),
      })
      .parse(req.body);
    const user = authed(req);

    let source: Awaited<ReturnType<typeof prisma.datasetType.findUnique>> = null;
    if (body.forkedFromTypeId) {
      source = await prisma.datasetType.findUnique({ where: { id: body.forkedFromTypeId } });
      if (!source) return reply.badRequest("Unknown source dataset type to fork.");
    }

    const fields = body.fields?.length
      ? body.fields
      : source && Array.isArray(source.fields)
        ? (source.fields as unknown as z.infer<typeof sponsorTypeFieldSchema>[])
        : guessSponsorFields(body.description);
    const dedupeField = (fields.find((f) => f.role !== "file") ?? fields[0])?.key ?? "instruction";
    const id = await uniqueDatasetTypeId(body.name);
    const defaultPipeline = ["schema", "dedupe", "human_audit"];
    const reviewed =
      body.pipeline || body.dedupeFields || body.auditOptions
        ? {
            pipeline: body.pipeline ?? defaultPipeline,
            dedupeFields: body.dedupeFields ?? [dedupeField],
            auditOptions: body.auditOptions ?? [10, 25, 50],
          }
        : null;
    const verification =
      reviewed ??
      (source && source.verification && typeof source.verification === "object"
        ? (source.verification as object)
        : { pipeline: defaultPipeline, dedupeFields: [dedupeField], auditOptions: [10, 25, 50] });

    const verificationForCheck = verification as { pipeline?: unknown; dedupeFields?: unknown };
    const integrityError = contractIntegrityError(fields, {
      pipeline: verificationForCheck.pipeline as string[] | undefined,
      dedupeFields: verificationForCheck.dedupeFields as string[] | undefined,
    });
    if (integrityError) {
      return reply.badRequest(`This dataset type cannot be reviewed as written: ${integrityError}`);
    }

    const created = await prisma.datasetType.create({
      data: {
        id,
        version: 1,
        domain: source?.domain ?? DomainId.coding,
        name: body.name,
        description: body.description,
        status: DatasetTypeStatus.platform_review,
        origin: DatasetTypeOrigin.sponsor,
        category: source?.category ?? DatasetCategory.implementation,
        trustTier: TrustTier.llm_verified,
        fields,
        verification,
        difficultyLevels: source?.difficultyLevels?.length ? source.difficultyLevels : ["beginner", "intermediate", "advanced"],
        forkedFromId: source?.id ?? null,
        authorUserId: user.id,
        sponsorHarnessNote: body.harnessNote ?? null,
      },
    });

    await prisma.$transaction((tx) =>
      writeAuditLog(tx, {
        actorUserId: user.id,
        action: "dataset_type.sponsor_proposed",
        targetType: "DatasetType",
        targetId: created.id,
        after: { name: created.name, forkedFromTypeId: body.forkedFromTypeId ?? null, harnessRequested: body.harnessNote != null },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        requestId: req.id,
      })
    );

    return reply.code(201).send({ datasetType: created, forkedFrom: source ? { id: source.id, name: source.name } : null });
  });

  // POST /v1/planner/assist — the single LLM/deterministic assist surface for
  // the planner. One typed endpoint with an `intent` discriminator, matching
  // v1's request shapes. Each intent dispatches to its dedicated consumer;
  // every consumer ships a deterministic fallback, so the planner is never
  // blocked without an LLM key. An unknown intent is a clean 400 from the
  // discriminated union, never a fabricated 200.
  //
  // FIVE intents: v1's four (`title`, `planner_copy`, `draft_type`,
  // `validate_field`) plus `description`, which v1 does NOT have — v1's
  // description step is deterministic client-side copy with no model behind
  // it. That one is a flagged deviation pending an owner decision; see
  // services/llm/consumers/suggest-description.ts.
  //
  // NO INTENT MUTATES STATE. These are advisory suggestions and a
  // not-yet-persisted draft only: nothing here writes a PlannerSession, a
  // DatasetType, a DatasetRequest, karma, or audit coverage. `draft_type`
  // writes exactly one audit-log row recording that a draft was generated.
  const assistBody = z.discriminatedUnion("intent", [
    // Working-title suggestions for an existing/launchable type.
    z.object({
      intent: z.literal("title"),
      datasetTypeId: z.string().min(1),
      brief: z.string().trim().min(2).max(180).optional(),
    }),
    // Starter descriptions for the free-text description step. NOT a v1 intent
    // — v1 serves this step from a deterministic client-side helper and has no
    // description consumer (see services/llm/consumers/suggest-description.ts
    // for the parity note). `title` is optional context only: it grounds the
    // copy in what the requester already named the dataset, and its 120-char
    // cap is the same bound `answersSchema.title` enforces so a value that
    // could not be saved cannot be used as context either.
    z.object({
      intent: z.literal("description"),
      datasetTypeId: z.string().min(1),
      title: z.string().trim().min(3).max(120).optional(),
    }),
    // Bounded funnel copy for a launchable type. Chip VALUES are server-owned;
    // see services/llm/consumers/planner-copy.ts for what a model may touch.
    z.object({
      intent: z.literal("planner_copy"),
      datasetTypeId: z.string().min(1),
      items: z.number().int().positive().optional(),
      difficulty: z.enum(["mostly_beginner", "balanced", "mostly_advanced"]).optional(),
      audit: z.number().int().min(0).max(100).optional(),
      license: z.string().trim().min(2).max(100).optional(),
    }),
    // Draft a whole custom (or forked) dataset-type contract from free text.
    z.object({
      intent: z.literal("draft_type"),
      brief: z.string().trim().min(12).max(4_000),
      forkedFromTypeId: z.string().trim().min(1).max(120).optional(),
    }),
    // Sanity-check a single free-text field the requester typed. Advisory:
    // returns a verdict the planner uses to re-ask; never rewrites the value,
    // and FAILS CLOSED (ok:false) when AI review is unavailable.
    z.object({
      intent: z.literal("validate_field"),
      field: z.enum(["title", "description", "language", "brief"]),
      value: z.string().trim().min(1).max(4_000),
      datasetTypeId: z.string().trim().min(1).max(120).optional(),
    }),
  ]);
  app.post("/assist", { preHandler: [requireAuth, requireVerifiedEmail] }, async (req, reply) => {
    // safeParse, not parse: a bare `.parse` throws a ZodError that the global
    // handler turns into a 500, so an unknown intent or a malformed body was
    // reported as a server fault. The discriminated union is the contract, so
    // a violation of it is a 400.
    const parsed = assistBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.issues[0]?.message ?? "invalid assist request");
    const body = parsed.data;
    const user = authed(req);

    if (body.intent === "title") {
      const type = await resolveType(body.datasetTypeId);
      // V1 PARITY, DELIBERATE: a custom/forked type sits in `platform_review`
      // and gets NO model-generated title ideas until an admin approves it.
      // This is the original application's own rule, not an accident of this
      // port — the original application refuses the same call server-side and
      // its planner renders an explicit note in its place client-side:
      // "Custom/forked type under review — no AI ideas by design. / Type your
      // own title below — AI ideas open once this template is approved."
      // Loosening it would spend model calls naming a contract no contributor
      // can be offered yet, and would treat an unreviewed, model-drafted type
      // name as trustworthy grounding. This deployment's planner already shows
      // the same note, so the 400 is never reached from the UI.
      if (!isLaunchableType(type)) return reply.badRequest("dataset type is not available for new requests");
      // `userId` restored to v1's call (`suggestBountyTitles(type, { userId:
      // user.id, brief })`, v1 routes/v1/planner.ts:441). Omitting it made
      // this the ONE assist intent the governor could not attribute: with no
      // userId, `checkGovernor` skips the per-user-per-minute rate limit
      // entirely (services/llm/governor.ts), so title assists were the only
      // un-rate-limited egress path in the planner, and their audit rows
      // carried no user.
      const { titles, source } = await suggestRequestTitles(type, { userId: user.id, brief: body.brief });
      return { titles, source };
    }

    if (body.intent === "description") {
      const type = await resolveType(body.datasetTypeId);
      if (!type) return reply.badRequest("unknown dataset type");
      // Same approval gate as `title` for the MODEL, but not for the step: v1
      // renders deterministic, template-derived starters for every type
      // including one still in `platform_review`, so refusing outright here
      // would be a REGRESSION against v1 rather than parity with it. A
      // non-launchable type therefore gets the deterministic starters with no
      // egress at all, honestly labelled `source: "fallback"`.
      if (!isLaunchableType(type)) {
        return { descriptions: fallbackDescriptions(type, body.title), source: "fallback" as const };
      }
      const { descriptions, source } = await suggestRequestDescriptions(type, {
        title: body.title,
        userId: user.id,
      });
      return { descriptions, source };
    }

    if (body.intent === "validate_field") {
      // Optional dataset-type context sharpens the model's on-topic judgement
      // but is never required — the guard also runs on custom/forked drafts
      // that have no persisted type yet. A bad typeId must not fail the check
      // OPEN, so an unresolvable id simply drops the context.
      let typeName: string | undefined;
      let typeDescription: string | undefined;
      if (body.datasetTypeId) {
        const t = await prisma.datasetType.findUnique({ where: { id: body.datasetTypeId } });
        if (t) {
          typeName = t.name;
          typeDescription = t.description ?? undefined;
        }
      }
      const result = await validateSponsorField(body.field as PlannerField, body.value, {
        userId: user.id,
        typeName,
        typeDescription,
      });
      return result; // { ok, reason, source }
    }

    if (body.intent === "planner_copy") {
      const type = await resolveType(body.datasetTypeId);
      if (!isLaunchableType(type)) return reply.badRequest("dataset type is not available for new requests");
      // Requester-facing presets, not calculated promises. These mirror the
      // static `deadlineSettings.presetDays` GET /catalog already returns —
      // this deployment has no admin-configurable planner deadline setting
      // (community pools are open-ended), so the delivery-window step is
      // offered as guidance and a model may only re-suggest the three day
      // counts within this same [30, 90] envelope.
      const deadlineChoices = [30, 60, 90].map((days, index) => ({
        days,
        label: `${index === 0 ? "Fastest" : index === 1 ? "Recommended" : "Comfortable"} — ${days} days`,
        hint: index === 0 ? "shortest preset" : index === 1 ? "balanced preset" : "extra schedule buffer",
      }));
      const deadlineContext = [
        body.items ? `${body.items} requested items` : null,
        body.difficulty ? `difficulty mix: ${body.difficulty}` : null,
        body.audit != null ? `validator audit coverage: ${body.audit}%` : null,
        body.license ? `license: ${body.license}` : null,
      ]
        .filter(Boolean)
        .join("; ");
      const { titles, steps, source } = await generatePlannerCopy(type, {
        userId: user.id,
        deadlineChoices,
        // Only bounded deadline suggestions are accepted. The model cannot
        // modify any planner choice, karma rate, or state transition.
        deadlineContext: deadlineContext || undefined,
      });
      return { titles, steps, source };
    }

    // intent === "draft_type": draft a full custom/forked contract to review.
    let fork: DatasetTypeDraftFork | undefined;
    if (body.forkedFromTypeId) {
      const src = await prisma.datasetType.findUnique({ where: { id: body.forkedFromTypeId } });
      if (!src) return reply.badRequest("Unknown source dataset type to fork.");
      fork = {
        name: src.name,
        fields: Array.isArray(src.fields) ? (src.fields as DatasetTypeDraft["fields"]) : [],
      };
    }
    const drafted = await draftCustomDatasetType(body.brief, { userId: user.id, fork });
    let { draft, source } = drafted;
    // Validate the drafted contract the same way the admin propose/activate
    // flow does, so a malformed draft can never reach the review step.
    const integrityOf = (candidate: DatasetTypeDraft) =>
      contractIntegrityError(candidate.fields, {
        pipeline: candidate.pipeline,
        dedupeFields: candidate.dedupeFields,
        auditOptions: candidate.auditOptions,
      });
    const integrityError = integrityOf(draft);
    if (integrityError) {
      // A draft that fails integrity must NOT 400 the requester out of the
      // flow: this endpoint's contract is that drafting always yields
      // something editable. Fall back to the deterministic draft, which is
      // integrity-checked in turn; only a broken fallback is a real bug.
      req.log.warn(
        { integrityError, source, forkedFromTypeId: body.forkedFromTypeId ?? null },
        "drafted dataset-type contract failed integrity; using deterministic fallback"
      );
      const safe = fallbackDraft(body.brief, fork);
      const safeError = integrityOf(safe);
      if (safeError) return reply.badRequest(`Drafted contract did not satisfy the dataset contract: ${safeError}`);
      draft = safe;
      source = "fallback";
    }
    await prisma.$transaction((tx) =>
      writeAuditLog(tx, {
        actorUserId: user.id,
        action: "dataset_type.draft_generated",
        targetType: "dataset_type_draft",
        targetId: createHash("sha256").update(`${user.id}:${body.brief}`).digest("hex").slice(0, 32),
        after: { source, forkedFromTypeId: body.forkedFromTypeId ?? null },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        requestId: req.id,
      })
    );
    // `requiresPlatformReview` is not decoration: a drafted contract is
    // untrusted model output and cannot back a live pool until a human
    // reviews it via the dataset-type proposal flow.
    return { draft, source, requiresPlatformReview: true };
  });

  // POST /v1/planner/sessions — start a session, reusing an existing
  // in-progress draft rather than minting a new row every time the sponsor
  // opens the planner (mirrors v1's single-active-draft-per-user rule).
  app.post("/sessions", { preHandler: [requireAuth, requireVerifiedEmail] }, async (req) => {
    const user = authed(req);
    const existing = await prisma.plannerSession.findFirst({
      where: { userId: user.id, completed: false },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return { session: existing, prefilled: existing.answersJson, reused: true };

    const session = await prisma.plannerSession.create({
      data: { userId: user.id, answersJson: {} as object, transcript: [] as object },
    });
    return { session, prefilled: {}, reused: false };
  });

  // GET /v1/planner/sessions/active
  app.get("/sessions/active", { preHandler: requireAuth }, async (req) => {
    const user = authed(req);
    const session = await prisma.plannerSession.findFirst({
      where: { userId: user.id, completed: false },
      orderBy: { createdAt: "desc" },
    });
    return { session };
  });

  // DELETE /v1/planner/sessions/:id — abandon a draft. No sponsor-reference
  // sample release step here (unlike v1's `releaseDraftSamples`): no route in
  // this deployment lets a requester attach reference samples pre-mint yet
  // (see routes/v1/admin-community.ts `buildSampleGate` comment — same gap,
  // documented there), so there is nothing to release.
  app.delete("/sessions/:id", { preHandler: [requireAuth, requireVerifiedEmail] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await prisma.plannerSession.findUnique({ where: { id } });
    if (!session || session.userId !== authed(req).id) return reply.notFound("session not found");
    if (session.completed) return reply.conflict("cannot delete completed session");
    await prisma.plannerSession.delete({ where: { id } });
    return { success: true };
  });

  // GET /v1/planner/sessions/:id
  app.get("/sessions/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await prisma.plannerSession.findUnique({ where: { id } });
    if (!session || session.userId !== authed(req).id) return reply.notFound("session not found");
    return { session };
  });

  // POST /v1/planner/sessions/:id/answers — merge answers + optional
  // transcript turn, with the same row-lock + optimistic-concurrency guard
  // v1 uses (routes/v1/planner.ts), for the same reason: per-turn autosaves
  // fire without awaiting their response, so concurrent writes for one
  // session are the norm.
  app.post("/sessions/:id/answers", { preHandler: [requireAuth, requireVerifiedEmail] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // safeParse, not parse: a bare `.parse` throws, and the global error
    // handler turns that into a 500 for what is a plain client validation
    // error (an answer below `answersSchema`'s minimum, say). The sibling
    // PATCH /answers/:step below already does this correctly. It matters more
    // now that the web planner autosaves on every turn — a mis-shaped answer
    // must tell the caller what is wrong, not read as a server fault.
    const parsedBody = z
      .object({
        answers: answersSchema,
        replace: z.boolean().optional(),
        transcript: z.array(z.object({ role: z.enum(["a", "u"]), text: z.string() })).optional(),
        expectedVersion: z.number().int().nonnegative().optional(),
      })
      .safeParse(req.body);
    if (!parsedBody.success) {
      return reply.badRequest(parsedBody.error.issues[0]?.message ?? "invalid answers payload");
    }
    const body = parsedBody.data;

    const owner = await prisma.plannerSession.findUnique({ where: { id }, select: { userId: true } });
    if (!owner || owner.userId !== authed(req).id) return reply.notFound("session not found");

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM planner_sessions WHERE id = ${id} FOR UPDATE`;
      const session = await tx.plannerSession.findUniqueOrThrow({ where: { id } });
      if (session.completed) throw new SessionFinalizedError();

      if (body.expectedVersion !== undefined && body.expectedVersion !== session.version) {
        throw new VersionConflictError(session.version);
      }

      const merged = body.replace
        ? body.answers
        : { ...(session.answersJson as PlannerAnswers), ...body.answers };
      const transcript = normalizeTranscript([
        ...((session.transcript as TranscriptMsg[]) ?? []),
        ...(body.transcript ?? []),
      ]);
      return tx.plannerSession.update({
        where: { id },
        data: { answersJson: merged as object, transcript: transcript as object, version: { increment: 1 } },
      });
    }).catch((e) => {
      if (e instanceof SessionFinalizedError) return "finalized" as const;
      if (e instanceof VersionConflictError) return { conflict: e.currentVersion };
      throw e;
    });
    if (result === "finalized") return reply.conflict("session already finalized");
    if (result && "conflict" in result) {
      return reply.code(409).send({ message: "This draft was changed elsewhere. Reload to continue.", currentVersion: result.conflict });
    }
    return { session: result };
  });

  // PATCH /v1/planner/sessions/:id/answers/:step — edit a single answer.
  app.patch("/sessions/:id/answers/:step", { preHandler: [requireAuth, requireVerifiedEmail] }, async (req, reply) => {
    const { id, step } = req.params as { id: string; step: string };
    if (!PLANNER_STEP_KEYS.includes(step)) return reply.badRequest("unknown step");
    const body = z.object({ value: z.unknown() }).parse(req.body);

    const session = await prisma.plannerSession.findUnique({ where: { id } });
    if (!session || session.userId !== authed(req).id) return reply.notFound("session not found");
    if (session.completed) return reply.conflict("session already finalized");

    const merged = { ...(session.answersJson as Record<string, unknown>), [step]: body.value };
    const parsed = answersSchema.safeParse(merged);
    if (!parsed.success) return reply.badRequest(parsed.error.issues[0]?.message ?? "invalid answer");

    const updated = await prisma.plannerSession.update({ where: { id }, data: { answersJson: parsed.data as object } });
    return { session: updated };
  });

  // POST /v1/planner/sessions/:id/finalize — turns the session's answers
  // into a real DatasetRequest via the same creation logic as
  // `POST /v1/community/requests` (services/planner.ts
  // createDatasetRequestFromAnswers — see its doc comment for why this
  // reproduces rather than imports that route's inline handler). Idempotent
  // via PlannerSession.completed/createdBounty (the column name is a v1
  // leftover — this deployment stores the created DatasetRequest's id there,
  // not a Bounty id; see the "no schema change" note in services/planner.ts).
  app.post("/sessions/:id/finalize", { preHandler: [requireAuth, requireVerifiedEmail] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = authed(req);

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM planner_sessions WHERE id = ${id} FOR UPDATE`;
      const session = await tx.plannerSession.findUnique({ where: { id } });
      if (!session || session.userId !== user.id) throw new SessionFinalizedError("not found");

      // Idempotency guard — finalizing twice must not create two requests.
      if (session.createdBounty) {
        const existingRequest = await tx.datasetRequest.findUnique({ where: { id: session.createdBounty } });
        if (existingRequest) return { request: existingRequest, alreadyFinalized: true };
      }

      const answers = session.answersJson as PlannerAnswers;
      const type = await resolveType(answers.category ?? answers.datasetTypeId);
      const problems = validateAnswers(type, answers);
      if (problems.length) throw new FinalizeValidationError(problems.join("; "));

      const request = await tx.datasetRequest.create({
        data: {
          requesterUserId: user.id,
          title: answers.title!.trim(),
          description: answers.description!.trim(),
          datasetTypeId: type!.id,
          domain: type!.domain,
          proposedLicense: answers.proposedLicense?.trim() || "CC-BY-4.0",
          // Folded onto the template's own spelling before storing, the same
          // way `POST /v1/community/requests` does it — see
          // `canonicalLanguageFor`. This is the planner's door onto a column
          // that is served to anonymous callers and GROUPED in listings, and a
          // draft's `answers.language` is whatever the client last autosaved,
          // so `typescript` here became a second listing row for TypeScript.
          // `type` is non-null past `validateAnswers` (it reports "Pick a
          // dataset type first" and throws above), which has also already
          // established via `coherenceProblems` that the template permits this
          // language — only its casing is being corrected.
          language: canonicalLanguageFor(type!, answers.language),
          framework: answers.framework,
          targetItems: answers.targetItems,
          difficultyMix: answers.difficultyMix,
          auditCoveragePct: answers.auditCoveragePct ?? 10,
          idempotencyKey: finalizeIdempotencyKey(id),
        },
      });

      await tx.datasetType.update({ where: { id: type!.id }, data: { usageCount: { increment: 1 } } });

      // Carry the draft's reference samples forward onto the request.
      //
      // Without this the samples stayed pinned to the PlannerSession, so the
      // request an admin actually reviews reported `samples: 0` and a
      // sampleGate of "needs N more" no matter how many the sponsor attached —
      // and the sponsor had no way to see why their request could not be
      // minted. This is the `plannerSession -> datasetRequest -> bounty`
      // hand-off the artifact contract already documents; only the first hop
      // was missing.
      //
      // `plannerSessionId` is cleared as `datasetRequestId` is set, because
      // schema.prisma requires exactly ONE of
      // plannerSessionId/datasetRequestId/bountyId. Clearing it also detaches
      // the files from the session's `onDelete: Cascade`, so they survive the
      // draft rather than being deleted with it.
      await tx.artifact.updateMany({
        where: { plannerSessionId: id, status: { not: ArtifactStatus.deleted } },
        data: { plannerSessionId: null, datasetRequestId: request.id },
      });

      await tx.plannerSession.update({ where: { id }, data: { completed: true, createdBounty: request.id } });

      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "planner_session.finalized",
        targetType: "DatasetRequest",
        targetId: request.id,
        after: { plannerSessionId: id },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        requestId: req.id,
      });

      return { request, alreadyFinalized: false };
    }).catch((err) => {
      if (err instanceof SessionFinalizedError) return null;
      if (err instanceof FinalizeValidationError) return err;
      throw err;
    });

    if (!result) return reply.notFound("session not found");
    if (result instanceof FinalizeValidationError) return reply.badRequest(result.message);

    return reply.code(201).send({
      request: result.request,
      redirectTo: `/community/requests/${result.request.id}`,
    });
  });
}

class FinalizeValidationError extends Error {}

/** Read `auditOptions` off a type's stored `verification` blob (`{ pipeline,
 * executionEnv, dedupeFields, auditOptions }` — see DatasetType.verification
 * schema comment) when present, otherwise fall back to the same coverage
 * presets `requestDatasetBody`'s own default (10) sits inside of
 * (routes/v1/community.ts). No per-type override info beyond what's already
 * stored on the row — there is no separate `auditOptionsFor()` helper
 * service in this deployment (v1's lives in lib/planner.ts, which has no
 * counterpart here). */
function auditOptionsFor(verification: unknown): number[] {
  if (verification && typeof verification === "object" && !Array.isArray(verification)) {
    const opts = (verification as { auditOptions?: unknown }).auditOptions;
    if (Array.isArray(opts) && opts.every((n) => typeof n === "number")) return opts as number[];
  }
  return [10, 25, 50, 100];
}
