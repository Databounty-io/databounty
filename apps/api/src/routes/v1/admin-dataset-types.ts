// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BountyKind, DatasetTypeOrigin, DatasetTypeStatus, DomainId, DatasetCategory, TrustTier, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { requireRole, ADMIN_AND_ABOVE_READONLY, ADMIN_AND_MEMBER, ADMIN_ONLY, type AuthedUser } from "../../lib/rbac.js";
import { enqueueDomainLiveNotificationIfNewlyLive } from "../../services/jobs/waitlist-notify.js";
import { writeAuditLog } from "../../lib/audit-log.js";

/**
 * Admin dataset-type catalog surface backing community/apps/admin's /karma
 * (per-type karma pricing), /open-program (sponsor fork/custom type review
 * queue), and /datasets/new (the interactive type builder) pages.
 *
 * Ported from v1's `routes/v1/admin.ts` dataset-types block onto community's
 * schema (which carries the identical DatasetType/DatasetTypeHarness models).
 * community has no generic LLM-completion abstraction (`services/llm/`) —
 * only a narrow `reviewSubmissionWithLlm` in `services/llm-client.ts` — so
 * `/propose` and `/suggest` below are DETERMINISTIC (no LLM call), always
 * returning `source: "fallback"`. This is an intentional, honest gap: no
 * suggestion is ever dressed up as an LLM one. See CHANGELOG / final report
 * for the owner decision this needs (wire a real LLM client, or keep the
 * deterministic fallback permanently).
 */

/* ------------------------------------------------------------------ */
/* Ported pure helpers (v1's lib/dataset-type-field.ts, lib/difficulty.ts,   */
/* lib/dataset-contract-integrity.ts) — inlined because this route file is   */
/* the only file in scope for this change; no new lib/ module was created.   */
/* ------------------------------------------------------------------ */

export const DATASET_FIELD_ROLES = [
  "instruction",
  "input_context",
  "input_code",
  "solution_code",
  "tests",
  "expected_output",
  "rationale",
  "enum",
  "list",
  "reference",
  "file",
] as const;

/** HTML file-input accept syntax: comma-separated MIME types, type wildcards,
 * or dot-prefixed extensions. Ported verbatim from v1's dataset-type-field.ts. */
function isValidFileAccept(value: string): boolean {
  const tokens = value.split(",").map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 30) return false;
  return tokens.every(
    (token) =>
      /^\.[a-z0-9][a-z0-9.+_-]{0,20}$/i.test(token) ||
      /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/i.test(token)
  );
}

export const datasetTypeFieldSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80),
    label: z.string().min(1).max(160),
    role: z.enum(DATASET_FIELD_ROLES),
    required: z.boolean().optional(),
    lang: z.string().max(40).optional(),
    options: z.array(z.string().max(120)).max(100).optional(),
    help: z.string().max(1000).optional(),
    accept: z.string().trim().max(500).refine(isValidFileAccept, "invalid file accept metadata").optional(),
    modality: z.enum(["image", "video", "audio", "document", "archive", "code", "text", "other"]).optional(),
    minCount: z.number().int().min(0).max(50).optional(),
    maxCount: z.number().int().min(1).max(50).optional(),
    maxSizeBytes: z.number().int().min(1).optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.accept && field.role !== "file") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["accept"], message: "accept metadata is only valid for file fields" });
    }
    for (const key of ["modality", "minCount", "maxCount", "maxSizeBytes"] as const) {
      if (field[key] !== undefined && field.role !== "file") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is only valid for file fields` });
      }
    }
    if (field.minCount !== undefined && field.maxCount !== undefined && field.minCount > field.maxCount) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["minCount"], message: "minCount cannot exceed maxCount" });
    }
  });

/** Canonical item-difficulty vocabulary. Ported (simplified — no per-item
 * pricing resolution, just create/patch-time normalization) from v1's
 * lib/difficulty.ts. */
const CANONICAL_DIFFICULTY_LEVELS = ["beginner", "intermediate", "advanced"] as const;
const ITEM_DIFFICULTY_ALIASES: Readonly<Record<string, string>> = { expert: "advanced" };

function normalizeDifficultyLevel(level: string): string {
  const raw = level.trim();
  if (!raw) return raw;
  const normalized = raw.toLowerCase();
  if ((CANONICAL_DIFFICULTY_LEVELS as readonly string[]).includes(normalized)) return normalized;
  if (Object.hasOwn(ITEM_DIFFICULTY_ALIASES, normalized)) return ITEM_DIFFICULTY_ALIASES[normalized]!;
  return raw;
}

function normalizeDifficultyLevels(levels: readonly string[]): string[] {
  const out: string[] = [];
  for (const level of levels) {
    const normalized = normalizeDifficultyLevel(level);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * Structural integrity check for a dataset-type contract (fields +
 * verification pipeline). Ported verbatim from v1's
 * lib/dataset-contract-integrity.ts — pure, no I/O.
 *
 * This is the ONE canonical `contractIntegrityError` in this deployment.
 * `services/planner.ts` used to define its own, laxer, duplicate of this
 * check (no `schema`-then-`dedupe` ordering rule, no `human_audit`-last rule,
 * no "at least one quality/human gate" rule, and a 6-stage allowlist missing
 * `ai_attribution`) for the sponsor-proposed-type path in
 * `routes/v1/planner.ts`. That let a sponsor-proposed type pass planner's
 * check, get written to the DB in `platform_review`, and only fail THIS
 * check later when an admin tried to activate it — a real inconsistency, not
 * a hypothetical one. `routes/v1/planner.ts` now imports and calls this
 * exact function instead of a second copy, so both entry points agree from
 * proposal time onward. Exported for that reason.
 */
export function contractIntegrityError(fieldsValue: unknown, verificationValue: unknown): string | null {
  const fields = Array.isArray(fieldsValue) ? fieldsValue : [];
  const keys = fields
    .filter((field): field is { key?: unknown } => Boolean(field) && typeof field === "object")
    .map((field) => field.key)
    .filter((key): key is string => typeof key === "string");
  if (new Set(keys).size !== keys.length) return "dataset field keys must be unique";

  const verification =
    verificationValue && typeof verificationValue === "object"
      ? (verificationValue as { pipeline?: unknown; dedupeFields?: unknown })
      : {};
  const pipeline = Array.isArray(verification.pipeline)
    ? verification.pipeline.filter((stage): stage is string => typeof stage === "string")
    : [];
  // "contamination" is deliberately NOT in this allowlist — the owner
  // decided to remove plagiarism/contamination screening from the community
  // pipeline entirely (no versioned benchmark corpus is wired up in this
  // environment, and `services/validation.ts` never runs such a stage
  // regardless of what a type declares). A dataset type naming it here is
  // now a hard proposal-time and activation-time rejection, not a silently
  // ignored no-op.
  // "ai_attribution" is ALSO deliberately NOT in this allowlist, but for the
  // opposite reason from "contamination": it is a real, always-on stage now
  // (`services/ai-attribution.ts`, ported from V1 — a cheap, deterministic,
  // dependency-free text scan for explicit AI-disclosure phrases; no LLM
  // call, no API key). `services/validation.ts` runs it unconditionally on
  // every submission and always writes a real `ValidationResult` row for it.
  // It is excluded from this allowlist precisely BECAUSE it is unconditional
  // — a sponsor/admin must not be able to opt a dataset type in or out of it
  // via `verification.pipeline`, so naming it here is a hard proposal-time
  // and activation-time rejection rather than a configurable no-op.
  const allowedStages = new Set(["schema", "dedupe", "execution", "llm", "human_audit"]);
  if (new Set(pipeline).size !== pipeline.length || pipeline.some((stage) => !allowedStages.has(stage))) {
    return "verification pipeline contains a duplicate or unsupported stage";
  }
  if (!pipeline.includes("schema") || !pipeline.includes("dedupe")) {
    return "verification pipeline must include schema and dedupe";
  }
  if (pipeline[0] !== "schema" || pipeline[1] !== "dedupe") {
    return "verification pipeline must start with schema then dedupe";
  }
  if (pipeline.includes("human_audit") && pipeline.at(-1) !== "human_audit") {
    return "human_audit must be the final pipeline stage";
  }
  if (!pipeline.some((stage) => ["execution", "llm", "human_audit"].includes(stage))) {
    return "verification pipeline must enable at least one quality or human-review gate";
  }
  const dedupeFields = Array.isArray(verification.dedupeFields)
    ? verification.dedupeFields.filter((field): field is string => typeof field === "string")
    : [];
  if (dedupeFields.length === 0) {
    return "verification dedupeFields must declare at least one field when the dedupe stage is enabled";
  }
  if (new Set(dedupeFields).size !== dedupeFields.length || dedupeFields.some((field) => !keys.includes(field))) {
    return "verification dedupeFields must be unique and reference declared fields";
  }
  const fileKeys = new Set(
    fields
      .filter((field): field is { key?: unknown; role?: unknown } => Boolean(field) && typeof field === "object")
      .filter((field) => field.role === "file")
      .map((field) => field.key)
      .filter((key): key is string => typeof key === "string")
  );
  const dedupeOnFile = dedupeFields.filter((field) => fileKeys.has(field));
  if (dedupeOnFile.length > 0) {
    return `verification dedupeFields cannot reference file fields (${dedupeOnFile.join(", ")}) — a file field holds a per-upload artifact id, so dedupe could never match; use the accompanying text field instead`;
  }
  return null;
}

/**
 * Pricing gate ("active ⇒ priced" invariant). Simplified port of v1's
 * lib/dataset-activation.ts `pricingActivationError` + `verificationUnitsError`.
 * Deliberately DOES NOT port v1's `executionActivationError` (sandbox/harness
 * capability check) — that depends on v1-only modules
 * (services/execution-providers/registry-loader.ts,
 * lib/dataset-profile-registry.ts) that do not exist in community and are
 * out of scope to create here. See final report: activation in community is
 * therefore gated on contract integrity + karma pricing only, NOT on whether
 * a harness/sandbox actually exists for the `execution` stage. That gap
 * pre-dates this change (the prior PATCH had no activation gate at all).
 */
function isComplexityScore(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4;
}

const MACHINE_VERIFYING_STAGES = ["execution", "llm"] as const;

function pricingActivationError(contract: { complexityScore?: number | null; verificationUnits?: number | null }): string | null {
  if (!isComplexityScore(contract.complexityScore) || contract.verificationUnits === null || contract.verificationUnits === undefined) {
    return "dataset type isn't priced for karma yet — set its complexity score (1–4) and verification units before activating it";
  }
  return null;
}

function verificationUnitsError(contract: {
  verificationUnits?: number | null;
  verification?: unknown;
  fields?: unknown;
}): string | null {
  const units = contract.verificationUnits;
  if (units === null || units === undefined) return null;
  const verification =
    contract.verification && typeof contract.verification === "object"
      ? (contract.verification as { pipeline?: unknown })
      : {};
  const pipeline = Array.isArray(verification.pipeline)
    ? verification.pipeline.filter((stage): stage is string => typeof stage === "string")
    : [];
  const machineVerifies = MACHINE_VERIFYING_STAGES.some((stage) => pipeline.includes(stage));
  if (units > 0 && !machineVerifies) {
    return `verification units must be 0 when the pipeline machine-verifies nothing (declared ${units}; pipeline has neither execution nor llm)`;
  }
  const fieldCount = Array.isArray(contract.fields) ? contract.fields.length : 0;
  if (units > fieldCount) {
    return `verification units (${units}) cannot exceed the ${fieldCount} declared field(s)`;
  }
  return null;
}

function datasetActivationError(contract: {
  complexityScore?: number | null;
  verificationUnits?: number | null;
  verification?: unknown;
  fields?: unknown;
}): string | null {
  return pricingActivationError(contract) ?? verificationUnitsError(contract);
}

/* ------------------------------------------------------------------ */
/* Request schemas                                                     */
/* ------------------------------------------------------------------ */

const verificationConfig = z
  .object({
    pipeline: z.array(z.string().min(1)).min(2).max(10),
    executionEnv: z.string().max(160).optional(),
    dedupeFields: z.array(z.string().min(1)).min(1).max(50),
    auditOptions: z.array(z.number().int().min(0).max(100)).min(1).max(4),
    formatProfile: z.string().regex(/^[a-z0-9-]+-v\d+$/).max(120).optional(),
    validationProfile: z.string().regex(/^[a-z0-9-]+-v\d+$/).max(120).optional(),
    normalizationProfile: z.string().regex(/^[a-z0-9-]+-v\d+$/).max(120).optional(),
    similarityProfile: z.string().regex(/^[a-z0-9-]+-v\d+$/).max(160).optional(),
    previewProfile: z.string().regex(/^[a-z0-9-]+-v\d+$/).max(120).optional(),
    sandboxProfile: z.string().regex(/^[a-z0-9-]+-v\d+$/).max(120).optional(),
    allowedGenerationMethods: z.array(z.enum(["human", "ai_assisted", "ai_generated"])).min(1).max(3).optional(),
    prohibitAiGenerated: z.boolean().optional(),
  })
  .strict();

const sampleAssetSchema = z
  .object({
    fields: z.record(z.string().min(1).max(80), z.string().max(2000)).optional(),
    media: z
      .array(
        z.object({
          key: z.string().min(1).max(80),
          url: z.string().url().max(2000),
          kind: z.enum(["image", "audio", "video", "file"]),
          alt: z.string().max(300).optional(),
        })
      )
      .max(10)
      .optional(),
    caption: z.string().max(500).optional(),
  })
  .strict();

const datasetTypeBody = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80),
    version: z.number().int().positive().optional(),
    domain: z.nativeEnum(DomainId),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(2000),
    status: z.nativeEnum(DatasetTypeStatus).optional(),
    origin: z.nativeEnum(DatasetTypeOrigin).optional(),
    category: z.nativeEnum(DatasetCategory),
    trustTier: z.nativeEnum(TrustTier),
    fields: z.array(datasetTypeFieldSchema).min(2).max(100),
    verification: verificationConfig,
    difficultyLevels: z.array(z.string().min(1).max(40)).min(1).max(5).transform(normalizeDifficultyLevels),
    complexityScore: z.number().int().min(1).max(4).nullable().optional(),
    verificationUnits: z.number().int().min(0).max(1_000).nullable().optional(),
    reviewNote: z.string().trim().min(1).max(2000).nullable().optional(),
    sampleAssets: z.array(sampleAssetSchema).max(5).nullable().optional(),
  })
  .strict();

const listQuery = z.object({
  origin: z.nativeEnum(DatasetTypeOrigin).optional(),
  status: z.nativeEnum(DatasetTypeStatus).optional(),
  domain: z.nativeEnum(DomainId).optional(),
  trustTier: z.nativeEnum(TrustTier).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  // The console's shared pager sends `skip`; `offset` is the original param
  // name and stays supported for MCP/scripts. Accepting only `offset` meant
  // the console's `skip` was silently dropped by this non-strict schema and
  // the Dataset types pager never advanced past page 1. Same dual-accept the
  // /users route already does.
  offset: z.coerce.number().int().min(0).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

const CONTRACT_LOCK_KEYS = ["fields", "verification", "trustTier", "category"] as const;

export async function adminDatasetTypeRoutes(app: FastifyInstance) {
  /**
   * Live catalog for the admin console (/karma pricing, /open-program review
   * queue). Every status — not just `active`, which is all the public
   * `/v1/community/catalog` route returns.
   */
  app.get("/dataset-types", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const { origin, status, domain, trustTier, search } = parsed.data;
    const take = parsed.data.limit ?? 50;
    const skip = parsed.data.skip ?? parsed.data.offset ?? 0;

    const where: Prisma.DatasetTypeWhereInput = {
      ...(origin ? { origin } : {}),
      ...(status ? { status } : {}),
      ...(domain ? { domain } : {}),
      ...(trustTier ? { trustTier } : {}),
      ...(search
        ? {
            OR: [
              { id: { contains: search, mode: "insensitive" } },
              { name: { contains: search, mode: "insensitive" } },
              { description: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [datasetTypes, total] = await Promise.all([
      prisma.datasetType.findMany({ where, orderBy: [{ updatedAt: "desc" }], take, skip }),
      prisma.datasetType.count({ where }),
    ]);

    return reply.send({ datasetTypes, total, limit: take, offset: skip });
  });

  const proposalRequest = z
    .object({
      brief: z.string().trim().min(20).max(12_000),
      domain: z.nativeEnum(DomainId).optional(),
    })
    .strict();

  /**
   * Full-contract draft proposal. community has no generic LLM abstraction
   * (v1's `services/llm/` `.complete()` with schema+fallback), so this is
   * deterministic: it always returns the honest fallback shape v1's route
   * returns when its LLM call fails, never a fabricated draft. Flagged for
   * owner decision — see file header.
   */
  app.post("/dataset-types/propose", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const input = proposalRequest.safeParse(req.body);
    if (!input.success) return reply.badRequest("brief must be between 20 and 12,000 characters");
    const proposal = {
      name: "Untitled dataset type",
      description: "Admin review required before this draft can be saved.",
      domain: input.data.domain ?? DomainId.coding,
      category: DatasetCategory.implementation,
      trustTier: TrustTier.llm_verified,
      fields: [
        { key: "instruction", label: "Instruction", role: "instruction" as const, required: true },
        { key: "response", label: "Response", role: "rationale" as const, required: true },
      ],
      pipeline: ["schema", "dedupe", "llm", "human_audit"] as Array<
        "schema" | "dedupe" | "execution" | "llm" | "human_audit"
      >,
      dedupeFields: ["instruction"],
      auditOptions: [25, 100],
      difficultyLevels: ["beginner", "intermediate", "advanced"],
      risks: ["No LLM-drafting client is wired in community yet; complete this draft manually."],
      missingCapabilities: ["Select registered format, validation, normalization, similarity, preview, and sandbox profiles before activation."],
    };
    return reply.send({ proposal, source: "fallback" as const, requiresAdminReview: true, activationBlockedUntilProfilesConfigured: true });
  });

  /**
   * Name + description only suggestion, for the interactive builder's
   * `requestProposal()` call. Deterministic (see file header) — always
   * `suggestion: null, source: "fallback"`, matching the shape the builder
   * already handles for an LLM failure (it shows no chip at all rather than
   * a fabricated suggestion).
   */
  app.post("/dataset-types/suggest", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const input = z
      .object({ domain: z.nativeEnum(DomainId), brief: z.string().trim().max(2_000).optional() })
      .strict()
      .safeParse(req.body);
    if (!input.success) return reply.badRequest("domain is required");
    return reply.send({ suggestion: null, source: "fallback" as const });
  });

  /** Mirrors the admin builder's `slug()` — the id is derived from the name. */
  const datasetTypeSlug = (name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "custom_type";

  /**
   * Live name availability for the builder — MUST be registered before
   * `GET /dataset-types/:id` so Fastify's router matches this literal path
   * ahead of the `:id` param route. This is the exact bug this change
   * fixes: the prior version of this file had only `:id`, so an
   * `availability` request against it would 404 as a phantom id lookup.
   */
  app.get("/dataset-types/availability", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const query = z.object({ name: z.string().trim().min(1).max(160) }).safeParse(req.query);
    if (!query.success) return reply.badRequest("name is required");
    const id = datasetTypeSlug(query.data.name);
    const candidates = [id, ...Array.from({ length: 8 }, (_, i) => `${id}_v${i + 2}`)];
    const taken = new Set(
      (await prisma.datasetType.findMany({ where: { id: { in: candidates } }, select: { id: true } })).map((t) => t.id)
    );
    if (!taken.has(id)) return reply.send({ id, available: true, suggestions: [] });
    return reply.send({
      id,
      available: false,
      reason: `A dataset type with the id "${id}" already exists.`,
      suggestions: candidates.filter((c) => c !== id && !taken.has(c)).slice(0, 3),
    });
  });

  app.get("/dataset-types/:id", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const datasetType = await prisma.datasetType.findUnique({
      where: { id },
      include: { harnesses: { orderBy: { version: "desc" } }, author: { select: { id: true, displayName: true, handle: true } } },
    });
    if (!datasetType) return reply.notFound("Dataset type not found");
    // `kind: BountyKind.community` explicit for the same reason as
    // admin.ts's /overview counts — this codebase's only kind today, stated
    // rather than assumed.
    const usageCount = await prisma.bounty.count({ where: { datasetTypeId: id, kind: BountyKind.community } });
    return reply.send({ datasetType: { ...datasetType, usageCount } });
  });

  app.post("/dataset-types", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const parsed = datasetTypeBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const integrityError = contractIntegrityError(parsed.data.fields, parsed.data.verification);
    if (integrityError) return reply.badRequest(integrityError);
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    if (parsed.data.status === DatasetTypeStatus.active && !user.roles.includes("admin")) {
      return reply.forbidden("only an admin can activate a dataset type");
    }
    if (parsed.data.status === DatasetTypeStatus.active) {
      const activationError = datasetActivationError(parsed.data);
      if (activationError) return reply.conflict(activationError);
    }
    const exists = await prisma.datasetType.findUnique({ where: { id: parsed.data.id }, select: { id: true } });
    if (exists) return reply.conflict("dataset type id already exists");

    const created = await prisma.$transaction(async (tx) => {
      // "This domain just went live" hook (v1 routes/v1/admin.ts): counted
      // INSIDE the transaction, BEFORE the write, so the fact cannot race the
      // activation it reacts to. The waitlist launch email is keyed on the
      // domain alone, so it goes out once per domain, never once per
      // activation.
      const domainHadNoActiveTypesBefore =
        parsed.data.status === DatasetTypeStatus.active
          ? (await tx.datasetType.count({
              where: { domain: parsed.data.domain, status: DatasetTypeStatus.active },
            })) === 0
          : false;
      const { sampleAssets, ...createFields } = parsed.data;
      const row = await tx.datasetType.create({
        data: {
          ...createFields,
          familyId: parsed.data.id,
          status: parsed.data.status ?? DatasetTypeStatus.draft,
          origin: parsed.data.origin ?? DatasetTypeOrigin.platform,
          version: parsed.data.version ?? 1,
          fields: parsed.data.fields as Prisma.InputJsonValue,
          verification: parsed.data.verification as Prisma.InputJsonValue,
          authorUserId: user.id,
          ...(sampleAssets !== undefined
            ? { sampleAssets: (sampleAssets === null ? Prisma.JsonNull : sampleAssets) as Prisma.InputJsonValue }
            : {}),
        },
      });
      await enqueueDomainLiveNotificationIfNewlyLive(row.domain, domainHadNoActiveTypesBefore, tx);
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.dataset_type.created",
        targetType: "DatasetType",
        targetId: row.id,
        after: row,
        ip: req.ip,
      });
      return row;
    });

    return reply.code(201).send({ datasetType: created });
  });

  /**
   * Active contracts are immutable — an existing bounty must keep the exact
   * pipeline it launched with. An admin edit of a live type starts from a
   * cloned draft version instead.
   */
  app.post("/dataset-types/:id/versions", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const created = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM dataset_types WHERE id = ${id} FOR UPDATE`);
      const current = await tx.datasetType.findUnique({ where: { id } });
      if (!current) return null;
      const latest = await tx.datasetType.aggregate({ where: { familyId: current.familyId }, _max: { version: true } });
      const version = (latest._max.version ?? current.version) + 1;
      const suffix = `__v${version}`;
      const rawId = `${current.familyId}${suffix}`;
      const nextId =
        rawId.length <= 80
          ? rawId
          : `${current.familyId.slice(0, 65)}_${Buffer.from(current.familyId).toString("hex").slice(0, 8)}${suffix}`;
      const row = await tx.datasetType.create({
        data: {
          id: nextId,
          familyId: current.familyId,
          supersedesId: current.id,
          version,
          domain: current.domain,
          name: current.name,
          description: current.description,
          status: DatasetTypeStatus.draft,
          origin: current.origin,
          category: current.category,
          trustTier: current.trustTier,
          fields: current.fields as Prisma.InputJsonValue,
          verification: current.verification as Prisma.InputJsonValue,
          difficultyLevels: current.difficultyLevels,
          authorUserId: current.authorUserId,
        },
      });
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.dataset_type.version_created",
        targetType: "DatasetType",
        targetId: row.id,
        before: current,
        after: row,
        ip: req.ip,
      });
      return row;
    });
    if (!created) return reply.notFound("dataset type not found");
    return reply.code(201).send({ datasetType: created });
  });

  /**
   * Widened PATCH: name, description, fields, verification, sampleAssets,
   * status, difficultyLevels, complexityScore, verificationUnits, reviewNote
   * (was: complexityScore/verificationUnits only).
   *
   * Active-contract lock: ported from v1 — `fields`, `verification`,
   * `trustTier`, `category` are locked once `status === "active"`, because a
   * live bounty must keep the exact contract it launched with. community's
   * DatasetType has no direct "has live submissions" column, but v1's own
   * gate does NOT check submissions either — it checks `status === "active"`
   * plus (for a status change away from active) `usageCount > 0`, where
   * `usageCount` is a denormalized bounty-launch counter already on this
   * model. That is the same signal community has, so the same rule applies
   * unchanged; no new query needed.
   */
  app.patch("/dataset-types/:id", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = datasetTypeBody.partial().omit({ id: true }).safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const current = await prisma.datasetType.findUnique({ where: { id } });
    if (!current) return reply.notFound("Dataset type not found");

    if (parsed.data.status === DatasetTypeStatus.active && !user.roles.includes("admin")) {
      return reply.forbidden("only an admin can activate a dataset type");
    }
    if (
      current.status === DatasetTypeStatus.active &&
      parsed.data.status &&
      parsed.data.status !== DatasetTypeStatus.active &&
      current.usageCount > 0
    ) {
      return reply.conflict("an active type used by bounties cannot be retired directly; create and activate a new version");
    }
    const changesContract = CONTRACT_LOCK_KEYS.some((key) => key in parsed.data);
    if (changesContract && !user.roles.includes("admin")) {
      return reply.forbidden("only an admin can change a dataset contract or validation pipeline");
    }
    if (current.status === DatasetTypeStatus.active && changesContract) {
      return reply.conflict("active dataset contracts are immutable; create and activate a new version instead");
    }
    if ((current.status === DatasetTypeStatus.active || parsed.data.status === DatasetTypeStatus.active) && !user.roles.includes("admin")) {
      return reply.forbidden("only an admin can change an active dataset type");
    }

    // "active ⇒ priced" invariant: clearing a live type's complexity score
    // would leave open bounties on that type awarding on an undefined/flat
    // fallback mid-flight. Kept as its own check (not folded into
    // datasetActivationError below) because it must also fire on a bare
    // pricing edit that never touches `status`.
    if (
      current.status === DatasetTypeStatus.active &&
      parsed.data.complexityScore === null &&
      (current.complexityScore !== null || parsed.data.complexityScore !== undefined)
    ) {
      return reply.conflict("This type is active — clear its complexity score by moving it off active first, not by unsetting the price.");
    }

    if (
      current.status === DatasetTypeStatus.platform_review &&
      parsed.data.status &&
      parsed.data.status !== DatasetTypeStatus.active &&
      !parsed.data.reviewNote?.trim()
    ) {
      return reply.badRequest("a review note is required when declining a sponsor-submitted type");
    }

    const integrityError = contractIntegrityError(parsed.data.fields ?? current.fields, parsed.data.verification ?? current.verification);
    if (integrityError) return reply.badRequest(integrityError);

    if (parsed.data.status === DatasetTypeStatus.active) {
      const effective = {
        complexityScore: parsed.data.complexityScore !== undefined ? parsed.data.complexityScore : current.complexityScore,
        verificationUnits: parsed.data.verificationUnits !== undefined ? parsed.data.verificationUnits : current.verificationUnits,
        verification: parsed.data.verification ?? current.verification,
        fields: parsed.data.fields ?? current.fields,
      };
      const activationError = datasetActivationError(effective);
      if (activationError) return reply.conflict(activationError);
    }

    const datasetType = await prisma.$transaction(async (tx) => {
      // Same pre-write count as the create path above. `id: { not: id }`
      // excludes this row so re-saving an already-active type does not read as
      // a fresh domain launch.
      const domainHadNoActiveTypesBefore =
        parsed.data.status === DatasetTypeStatus.active
          ? (await tx.datasetType.count({
              where: { domain: current.domain, status: DatasetTypeStatus.active, id: { not: id } },
            })) === 0
          : false;
      if (parsed.data.status === DatasetTypeStatus.active) {
        await tx.datasetType.updateMany({
          where: { familyId: current.familyId, status: DatasetTypeStatus.active, id: { not: id } },
          data: { status: DatasetTypeStatus.draft },
        });
      }
      const { fields, verification, sampleAssets, ...rest } = parsed.data;
      const data: Prisma.DatasetTypeUpdateInput = { ...rest };
      if (fields) data.fields = fields as Prisma.InputJsonValue;
      if (verification) data.verification = verification as Prisma.InputJsonValue;
      if (sampleAssets !== undefined) data.sampleAssets = (sampleAssets === null ? Prisma.JsonNull : sampleAssets) as Prisma.InputJsonValue;

      const row = await tx.datasetType.update({ where: { id }, data });
      await enqueueDomainLiveNotificationIfNewlyLive(row.domain, domainHadNoActiveTypesBefore, tx);
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.dataset_type.updated",
        targetType: "DatasetType",
        targetId: id,
        before: current,
        after: row,
        ip: req.ip,
      });
      return row;
    });

    return reply.send({ datasetType });
  });
}
