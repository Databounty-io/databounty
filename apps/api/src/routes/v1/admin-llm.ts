// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireRole, ADMIN_AND_MEMBER, ADMIN_AND_ABOVE_READONLY, type AuthedUser } from "../../lib/rbac.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { openRouterConfigured } from "../../services/llm-client.js";
import { FEATURES as FEATURE_REGISTRY, FEATURE_NAMES, featureDef, isLlmFeature } from "../../services/llm/features.js";
import { resolveSystemPrompt } from "../../services/llm/config.js";
import { lookupModel } from "../../services/llm/registry.js";
import { discoverOpenRouterModels, ProviderCatalogError } from "../../services/llm/provider-catalog.js";
import { config } from "../../config.js";
import type { LlmFeature } from "../../services/llm/types.js";
import type { Prisma } from "@prisma/client";

/**
 * Backs community/apps/admin's /llm page.
 *
 * `submission_review` is now real AND actually configurable from this page:
 * services/llm/consumers/review.ts routes it through the LLM layer, so the
 * override rows written below change the model, prompt and params of the real
 * validation-stage call (services/validation.ts). It was NOT configurable
 * until that move — the call went straight out through a hardcoded
 * services/llm-client.ts fetch, which meant this page rendered controls that
 * changed nothing about the request. Verified live against real
 * anthropic/claude-sonnet-4 + claude-haiku-4.5 responses (the OLDER
 * `claude-3-5-*` slugs this registry used to list are retired on
 * OpenRouter — HTTP 404 "No endpoints found" — corrected in
 * services/llm/registry.ts to the currently-live equivalents).
 * LlmRoutingOverride and LlmChangeEvaluation
 * exist in the schema and are real, queryable tables, so routing-override
 * and evaluation CRUD below is fully real. What is still NOT real, and is
 * reported as such rather than fabricated:
 *  - "features" now reads the ONE shared registry, `services/llm/features.ts`,
 *    which is the same code-default routing level `services/llm/config.ts`
 *    resolves overrides on top of. This route used to carry its own private
 *    copy describing what these call sites "should" be routed as; the two
 *    could (and did) disagree. `dataClass` is now the routing-governing value
 *    (public | internal | proprietary) rather than the older descriptive
 *    labels, because that is the value that actually gates which models a
 *    feature may be routed to.
 *  - Wired consumers: `submission_review`
 *    (services/llm/consumers/review.ts, reached from the validation pipeline
 *    and the sponsor-reference review job), `suggest` (services/planner.ts
 *    `suggestRequestTitles`), `planner_copy`, `dataset_type_draft` and
 *    `field_validate` (services/llm/consumers/*, reached via
 *    POST /v1/planner/assist).
 *    `planner_answer_extract` and `interpret_edit_intent` are registered but
 *    have no consumer yet, and their `summary` says so. (An external-corpus
 *    plagiarism/contamination feature previously listed here was removed per
 *    owner decision: this platform performs no plagiarism screening against
 *    content outside the platform.)
 *  - prompts are resolved through `resolveSystemPrompt`, which layers
 *    admin_settings `llm.<feature>.system_prompt` over the code default, so
 *    `prompt.source` is a real measurement. WRITING one is still not wired:
 *    PUT .../prompts/:feature keeps failing closed with 501 rather than
 *    silently discarding what an admin typed. `parseSystemPrompt` +
 *    `systemPromptKey` make implementing it small; it is deliberately left
 *    for the change that also adds the eval gate for a prompt edit.
 */

const accountScopeQuery = z.object({ accountId: z.string().trim().min(1).optional() });

export async function adminLlmRoutes(app: FastifyInstance) {
  // GET /llm/settings?accountId= — every feature's live config: code defaults
  // plus any real global/account-scoped LlmRoutingOverride row, plus real
  // LlmChangeEvaluation rows.
  app.get("/llm/settings", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const parsed = accountScopeQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const accountId = parsed.data.accountId ?? null;

    const [globalOverrides, accountOverrides, evaluations] = await Promise.all([
      prisma.llmRoutingOverride.findMany({ where: { feature: { in: FEATURE_NAMES as string[] }, accountId: null } }),
      accountId
        ? prisma.llmRoutingOverride.findMany({ where: { feature: { in: FEATURE_NAMES as string[] }, accountId } })
        : Promise.resolve([]),
      prisma.llmChangeEvaluation.findMany({ where: { feature: { in: FEATURE_NAMES as string[] } }, orderBy: { createdAt: "desc" }, take: 200 }),
    ]);
    const globalByFeature = new Map(globalOverrides.map((o) => [o.feature, o]));
    const accountByFeature = new Map(accountOverrides.map((o) => [o.feature, o]));

    const features = await Promise.all(FEATURE_NAMES.map(async (feature) => {
      const reg = featureDef(feature);
      // Real resolution: account override -> admin_settings global -> code
      // default. `source` is measured, not asserted.
      const prompt = await resolveSystemPrompt(feature, accountId ?? undefined);
      return {
        feature,
        summary: reg.summary,
        highStakes: reg.highStakes,
        dataClass: reg.dataClass,
        // Two different things, both needed by the console and previously
        // conflated: `defaultModels` are the REGISTRY KEYS routing tries in
        // order (and the currency PUT /llm/routing/:feature's `modelKey`
        // expects), while `defaultModelIds` are the native provider model ids
        // those keys resolve to — what actually appears in a provider bill and
        // in `llm_audit_log.model`.
        defaultModels: reg.models,
        defaultModelIds: reg.models.map((key) => lookupModel(key)?.id ?? key),
        params: reg.params,
        prompt: { text: prompt.text, source: prompt.source, version: prompt.version },
        globalOverride: globalByFeature.get(feature) ?? null,
        accountOverride: accountByFeature.get(feature) ?? null,
      };
    }));

    return reply.send({ features, evaluations, accountId });
  });

  const accountsQuery = z.object({
    search: z.string().trim().max(200).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  });

  // GET /llm/accounts — search source for the account-scope picker.
  app.get("/llm/accounts", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const parsed = accountsQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const { search, cursor } = parsed.data;
    const limit = parsed.data.limit ?? 20;

    const where: Prisma.UserWhereInput = search
      ? {
          OR: [
            { displayName: { contains: search, mode: "insensitive" } },
            { handle: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
            { id: search },
          ],
        }
      : {};

    const rows = await prisma.user.findMany({
      where,
      select: { id: true, displayName: true, email: true, handle: true, status: true },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return reply.send({
      accounts: page.map((u) => ({ id: u.id, name: u.displayName, email: u.email, handle: u.handle, status: u.status })),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    });
  });

  const routingBody = z.object({
    accountId: z.string().trim().min(1).nullable().optional(),
    modelKey: z.string().trim().min(1).nullable().optional(),
    maxTokens: z.number().int().min(1).max(200_000).nullable().optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
    timeoutMs: z.number().int().min(1000).max(300_000).nullable().optional(),
    enabled: z.boolean().nullable().optional(),
    evaluationId: z.string().trim().min(1).optional(),
  });

  // PUT /llm/routing/:feature — real upsert into LlmRoutingOverride
  // (unique on [feature, accountId]; accountId null = global default).
  app.put("/llm/routing/:feature", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { feature } = req.params as { feature: string };
    if (!isLlmFeature(feature)) return reply.badRequest(`Unknown feature "${feature}".`);
    const parsed = routingBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const reg = FEATURE_REGISTRY[feature as LlmFeature];
    if (reg.highStakes && !parsed.data.evaluationId) {
      return reply.badRequest("This is a high-stakes feature — select an approved evaluation before saving a routing change.");
    }
    if (parsed.data.evaluationId) {
      const evaluation = await prisma.llmChangeEvaluation.findUnique({ where: { id: parsed.data.evaluationId } });
      if (!evaluation || evaluation.feature !== feature || evaluation.status !== "approved") {
        return reply.badRequest("The selected evaluation is not an approved evaluation for this feature.");
      }
    }

    const accountId = parsed.data.accountId ?? null;
    const data = {
      modelKey: parsed.data.modelKey ?? null,
      maxTokens: parsed.data.maxTokens ?? null,
      temperature: parsed.data.temperature ?? null,
      timeoutMs: parsed.data.timeoutMs ?? null,
      enabled: parsed.data.enabled ?? null,
      evalId: parsed.data.evaluationId ?? null,
      updatedBy: user.id,
    };

    // Prisma's compound-unique shorthand (`feature_accountId`) requires every
    // member to be a real value — passing `null` for accountId (the global-
    // scope case) throws "Argument accountId must not be null" at the query
    // engine, it does not silently match NULL rows the way a plain `where`
    // filter does. Confirmed live: saving any global-scope (no accountId)
    // override 500'd before this fix. Global scope has to be looked up with a
    // plain filter instead of the compound-unique input.
    const override = await prisma.$transaction(async (tx) => {
      const before =
        accountId === null
          ? await tx.llmRoutingOverride.findFirst({ where: { feature, accountId: null } })
          : await tx.llmRoutingOverride.findUnique({ where: { feature_accountId: { feature, accountId } } });
      const row = before
        ? await tx.llmRoutingOverride.update({ where: { id: before.id }, data })
        : await tx.llmRoutingOverride.create({ data: { feature, accountId, ...data } });
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.llm_routing.updated",
        targetType: "LlmRoutingOverride",
        targetId: row.id,
        before: before ? { modelKey: before.modelKey, enabled: before.enabled } : null,
        after: { modelKey: row.modelKey, enabled: row.enabled, accountId },
        ip: req.ip,
      });
      return row;
    });

    return reply.send({ override });
  });

  // PUT /llm/prompts/:feature — no live prompt-override storage exists (see
  // file header). Fails closed rather than accepting a write it cannot
  // persist and silently discarding it.
  app.put("/llm/prompts/:feature", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const { feature } = req.params as { feature: string };
    if (!isLlmFeature(feature)) return reply.badRequest(`Unknown feature "${feature}".`);
    return reply.status(501).send({
      message:
        "Prompt overrides are not implemented yet — this deployment has no persistent prompt-override table (only " +
        "LlmChangeEvaluation.candidatePrompt, which stores an evaluation proposal, not a live override). Create an " +
        "evaluation to record this prompt candidate for review instead.",
    });
  });

  const createEvalBody = z.object({
    feature: z.string().trim().min(1),
    accountId: z.string().trim().min(1).nullable().optional(),
    target: z.enum(["prompt", "routing", "prompt_and_routing"]),
    candidatePrompt: z.string().trim().min(1).nullable().optional(),
    candidateConfig: z.record(z.string(), z.unknown()).nullable().optional(),
    status: z.enum(["draft", "eval_passed", "canary", "approved", "rejected"]).default("draft"),
    sampleCount: z.number().int().min(0).max(1_000_000).default(0),
    passRate: z.number().min(0).max(1).nullable().optional(),
    regressionRate: z.number().min(0).max(1).nullable().optional(),
    canaryPercent: z.number().int().min(0).max(100).default(0),
    notes: z.string().trim().max(4000).nullable().optional(),
  });

  // POST /llm/evaluations — real create into LlmChangeEvaluation. configHash
  // is computed server-side from the candidate payload so it cannot be
  // spoofed by the client and so two identical candidates hash identically.
  app.post("/llm/evaluations", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = createEvalBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    if (!isLlmFeature(parsed.data.feature)) return reply.badRequest(`Unknown feature "${parsed.data.feature}".`);

    const { createHash } = await import("node:crypto");
    const configHash = createHash("sha256")
      .update(JSON.stringify({ prompt: parsed.data.candidatePrompt ?? null, config: parsed.data.candidateConfig ?? null }))
      .digest("hex");

    const evaluation = await prisma.$transaction(async (tx) => {
      const row = await tx.llmChangeEvaluation.create({
        data: {
          feature: parsed.data.feature,
          accountId: parsed.data.accountId ?? null,
          target: parsed.data.target,
          status: parsed.data.status,
          configHash,
          candidatePrompt: parsed.data.candidatePrompt ?? null,
          candidateConfig: (parsed.data.candidateConfig ?? undefined) as Prisma.InputJsonValue | undefined,
          sampleCount: parsed.data.sampleCount,
          passRate: parsed.data.passRate ?? null,
          regressionRate: parsed.data.regressionRate ?? null,
          canaryPercent: parsed.data.canaryPercent,
          notes: parsed.data.notes ?? null,
          createdBy: user.id,
        },
      });
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.llm_evaluation.created",
        targetType: "LlmChangeEvaluation",
        targetId: row.id,
        after: { feature: row.feature, target: row.target, status: row.status },
        ip: req.ip,
      });
      return row;
    });

    return reply.status(201).send({ evaluation });
  });

  const patchEvalBody = z.object({ status: z.enum(["draft", "eval_passed", "canary", "approved", "rejected"]) });

  // PATCH /llm/evaluations/:id — status transition (approve/reject a
  // proposed prompt/routing change). Only "approved" is enforced elsewhere
  // (routing PUT above requires an approved evaluation for high-stakes
  // features); other status values are accepted as an honest record of where
  // the evaluation stands.
  app.patch("/llm/evaluations/:id", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = patchEvalBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const existing = await prisma.llmChangeEvaluation.findUnique({ where: { id } });
    if (!existing) return reply.notFound("Evaluation not found");

    const evaluation = await prisma.$transaction(async (tx) => {
      const row = await tx.llmChangeEvaluation.update({
        where: { id },
        data: {
          status: parsed.data.status,
          ...(parsed.data.status === "approved" ? { approvedBy: user.id, approvedAt: new Date() } : {}),
        },
      });
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.llm_evaluation.status_changed",
        targetType: "LlmChangeEvaluation",
        targetId: id,
        before: { status: existing.status },
        after: { status: row.status },
        ip: req.ip,
      });
      return row;
    });

    return reply.send({ evaluation });
  });

  const openRouterQuery = z.object({ refresh: z.coerce.boolean().optional() });

  // GET /llm/openrouter/models — live catalog discovery via
  // services/llm/provider-catalog.ts. Configuration is read through
  // `openRouterConfigured()` so this route and the review path can never
  // disagree about whether the provider is set up; when it is unset the
  // response is an explicit "not configured", not an empty list that reads
  // like "OpenRouter has no models".
  app.get("/llm/openrouter/models", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const parsed = openRouterQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const configured = openRouterConfigured();
    if (!configured) {
      return reply.send({
        models: [],
        fetchedAt: null,
        cacheHit: false,
        message: "OpenRouter is not configured on this deployment (OPENROUTER_API_KEY is unset) — no live model catalog is available.",
      });
    }
    // Real discovery against OpenRouter's `/models` endpoint
    // (services/llm/provider-catalog.ts, 5-minute in-process cache). Discovery
    // data never changes routing on its own — an admin still has to select a
    // model through PUT /llm/routing/:feature.
    try {
      const snapshot = await discoverOpenRouterModels(config.openRouterApiKey ?? "", {
        force: parsed.data.refresh === true,
      });
      return reply.send({ models: snapshot.models, fetchedAt: snapshot.fetchedAt, cacheHit: snapshot.cacheHit });
    } catch (err) {
      // An upstream outage is reported as an outage, not as an empty catalog
      // that looks like "OpenRouter has no models".
      return reply.send({
        models: [],
        fetchedAt: null,
        cacheHit: false,
        message:
          err instanceof ProviderCatalogError
            ? err.message
            : "OpenRouter model discovery failed unexpectedly.",
      });
    }
  });
}
