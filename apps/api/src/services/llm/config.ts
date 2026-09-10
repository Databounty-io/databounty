// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { config } from "../../config.js";
import { featureDef } from "./features.js";
import { dataClassAllowed, lookupModelConfigured, type ModelEntry } from "./registry.js";
import type { DataClass, LlmFeature, ModelParams } from "./types.js";

/**
 * Layered routing resolution. Ported from v1's `services/llm/config.ts`.
 *
 *   code default (features.ts)
 *     -> admin-global override   llm_routing_overrides(feature, accountId=null)
 *                             or admin_settings["llm.<feature>"]
 *       -> account override      llm_routing_overrides(feature, accountId)
 *                             or admin_settings["llm.account.<id>.<feature>"]
 *
 * Most specific wins; unset fields inherit. Both the dedicated
 * `llm_routing_overrides` table and the generic `admin_settings` key/Json
 * table already exist in this schema, so all of this is DB-backed and
 * admin-editable with zero deploy and NO migration.
 */

/** A partial override — only the fields an admin/account chose to change. */
const overrideSchema = z
  .object({
    model: z.string().min(1).optional(), // registry key or native id -> head of chain
    maxTokens: z.number().int().positive().max(200_000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type LlmOverride = z.infer<typeof overrideSchema>;

export function adminGlobalKey(feature: LlmFeature): string {
  return `llm.${feature}`;
}
export function accountKey(accountId: string, feature: LlmFeature): string {
  return `llm.account.${accountId}.${feature}`;
}

/** Validate an override payload before it's written to admin_settings. */
export function parseOverride(value: unknown): { ok: true; value: LlmOverride } | { ok: false; message: string } {
  const parsed = overrideSchema.safeParse(value);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "invalid llm override" };
  return { ok: true, value: parsed.data };
}

/**
 * Short-TTL cache for the raw admin_settings JSON values that back routing +
 * prompt resolution. `complete()` reads up to 4 keys per call; on a hot path
 * that is needless DB load. TTL is small so admin edits propagate quickly, and
 * admin writes call `clearLlmConfigCache()` to apply immediately. A
 * settings-store outage caches `null` (code defaults).
 */
const CONFIG_TTL_MS = 5_000;
const configCache = new Map<string, { value: unknown; exp: number }>();

/** Drop cached config so the next resolve re-reads. Call after any llm.* write. */
export function clearLlmConfigCache(): void {
  configCache.clear();
}

async function readSettingCached(key: string): Promise<unknown> {
  const hit = configCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  let value: unknown = null;
  try {
    const row = await prisma.adminSetting.findUnique({ where: { key } });
    value = row ? row.value : null;
  } catch {
    value = null; // outage -> degrade to code defaults
  }
  configCache.set(key, { value, exp: Date.now() + CONFIG_TTL_MS });
  return value;
}

async function readOverride(key: string): Promise<LlmOverride | null> {
  const parsed = overrideSchema.safeParse(await readSettingCached(key));
  return parsed.success ? parsed.data : null; // ignore malformed rows, fail to inherit
}

async function readDbOverride(feature: LlmFeature, accountId?: string): Promise<LlmOverride | null> {
  try {
    const row = await prisma.llmRoutingOverride.findFirst({
      where: { feature, accountId: accountId ?? null },
      orderBy: { updatedAt: "desc" },
    });
    if (!row) return null;
    return {
      ...(row.modelKey ? { model: row.modelKey } : {}),
      ...(row.maxTokens ? { maxTokens: row.maxTokens } : {}),
      ...(row.temperature != null ? { temperature: row.temperature } : {}),
      ...(row.timeoutMs ? { timeoutMs: row.timeoutMs } : {}),
      ...(row.enabled != null ? { enabled: row.enabled } : {}),
    };
  } catch {
    return null;
  }
}

/** A single routing candidate: a concrete model + the params to call it with. */
export interface Candidate {
  modelKey: string;
  model: ModelEntry;
  params: ModelParams;
}

export interface FeaturePlan {
  feature: LlmFeature;
  enabled: boolean;
  json: boolean;
  highStakes: boolean;
  redactContent: boolean;
  /** The feature's declared content sensitivity. Carried on the plan (not just
   * consulted while filtering candidates) because the service also needs it to
   * decide whether a call may be served from the dedupe cache — see
   * `service.ts`. */
  dataClass: DataClass;
  /** Ordered, capability-and-dataclass-validated models to try (failover chain).
   * Empty => nothing safe to route to => caller uses the deterministic fallback. */
  candidates: Candidate[];
}

/**
 * Resolve the effective plan for a feature, applying admin-global then account
 * overrides on top of the code default, and dropping any model that fails the
 * feature's capability / data-class requirements (fail closed).
 */
export async function resolveFeaturePlan(feature: LlmFeature, accountId?: string): Promise<FeaturePlan> {
  const def = featureDef(feature);

  const [settingsGlobal, settingsAccount, dbGlobal, dbAccount] = await Promise.all([
    readOverride(adminGlobalKey(feature)),
    accountId ? readOverride(accountKey(accountId, feature)) : Promise.resolve(null),
    readDbOverride(feature),
    accountId ? readDbOverride(feature, accountId) : Promise.resolve(null),
  ]);
  const global = dbGlobal ?? settingsGlobal;
  const account = dbAccount ?? settingsAccount;

  const enabled = account?.enabled ?? global?.enabled ?? true;

  // Merge params: default <- global <- account (only set fields override).
  const params: ModelParams = {
    maxTokens: account?.maxTokens ?? global?.maxTokens ?? def.params.maxTokens,
    temperature: account?.temperature ?? global?.temperature ?? def.params.temperature,
    timeoutMs: account?.timeoutMs ?? global?.timeoutMs ?? def.params.timeoutMs,
  };

  // Build the candidate chain: an override `model` becomes the new head, then
  // the feature's declared failover chain (deduped).
  const overrideModel = account?.model ?? global?.model;
  const chain = overrideModel ? [overrideModel, ...def.models] : [...def.models];
  const seen = new Set<string>();

  const candidates: Candidate[] = [];
  for (const key of chain) {
    if (seen.has(key)) continue;
    seen.add(key);
    const model = await lookupModelConfigured(key);
    if (!model || model.status !== "active") continue; // unknown/deprecated -> skip
    if (model.contextWindow < def.minContextWindow) continue; // too small -> skip
    if (def.json && !model.supportsJson) continue; // can't do the job -> skip
    if (!dataClassAllowed(model.maxDataClass, def.dataClass)) continue; // data governance
    candidates.push({ modelKey: key, model, params });
  }

  return {
    feature,
    enabled,
    json: def.json,
    highStakes: def.highStakes,
    redactContent: def.redactContent,
    dataClass: def.dataClass,
    candidates,
  };
}

/* ------------------------------------------------------------------ */
/* Admin-editable system prompts. Same layered model as routing:      */
/* code default -> admin-global -> account override, all in           */
/* admin_settings, zero deploy.                                       */
/* ------------------------------------------------------------------ */

const promptSchema = z.string().trim().min(10).max(8_000);

export function systemPromptKey(feature: LlmFeature): string {
  return `llm.${feature}.system_prompt`;
}
export function accountSystemPromptKey(accountId: string, feature: LlmFeature): string {
  return `llm.account.${accountId}.${feature}.system_prompt`;
}

/** Validate a prompt payload before it's written to admin_settings. */
export function parseSystemPrompt(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const parsed = promptSchema.safeParse(value);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "invalid prompt" };
  return { ok: true, value: parsed.data };
}

async function readPrompt(key: string): Promise<string | null> {
  const parsed = promptSchema.safeParse(await readSettingCached(key));
  return parsed.success ? parsed.data : null; // malformed/absent -> inherit next level
}

/** A short, stable id for a prompt body — recorded in the audit log so any call
 * is reproducible to the exact prompt version that produced it. */
export function promptVersion(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export interface ResolvedPrompt {
  text: string;
  source: "default" | "admin" | "account";
  version: string;
}

/** Resolve the effective system prompt for a feature (account -> admin -> code). */
export async function resolveSystemPrompt(feature: LlmFeature, accountId?: string): Promise<ResolvedPrompt> {
  const def = featureDef(feature);
  const [global, account] = await Promise.all([
    readPrompt(systemPromptKey(feature)),
    accountId ? readPrompt(accountSystemPromptKey(accountId, feature)) : Promise.resolve(null),
  ]);
  const text = account ?? global ?? def.systemPrompt;
  const source: ResolvedPrompt["source"] = account ? "account" : global ? "admin" : "default";
  return { text, source, version: promptVersion(text) };
}

/* ------------------------------------------------------------------ */
/* Governance config (budget / rate-limit / cache / breaker).          */
/* Admin-tunable via admin_settings; safe code defaults; short-cached. */
/* ------------------------------------------------------------------ */

async function readNumber(key: string, fallback: number): Promise<number> {
  const v = await readSettingCached(key);
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

export interface GovernanceConfig {
  dailyCapMicroUsd: number; // platform-wide daily spend cap; 0 = unlimited
  perUserPerMin: number; // per-user calls/minute; 0 = unlimited
  cacheTtlMs: number; // dedupe cache TTL; 0 = caching off
  breakerThreshold: number; // consecutive provider failures before opening
  breakerCooldownMs: number; // how long a provider stays open
}

/** Keys read from `admin_settings`. None of them are seeded rows today, so
 * every value below is the code default until an admin writes one; that is why
 * they are absent from `services/admin-settings.ts`'s seeded catalog rather
 * than being an unimplemented promise. */
export const GOVERNANCE_SETTING_KEYS = [
  "llm.budget.daily_usd_cap",
  "llm.ratelimit.per_user_per_min",
  "llm.cache.ttl_seconds",
  "llm.breaker.failure_threshold",
  "llm.breaker.cooldown_seconds",
] as const;

export async function getGovernanceConfig(): Promise<GovernanceConfig> {
  const [dailyUsd, perUserPerMin, cacheTtlSec, breakerThreshold, breakerCooldownSec] = await Promise.all([
    readNumber("llm.budget.daily_usd_cap", 50),
    readNumber("llm.ratelimit.per_user_per_min", 20),
    readNumber("llm.cache.ttl_seconds", 900),
    readNumber("llm.breaker.failure_threshold", 5),
    readNumber("llm.breaker.cooldown_seconds", 30),
  ]);
  return {
    dailyCapMicroUsd: Math.round(dailyUsd * 1_000_000),
    perUserPerMin,
    cacheTtlMs: cacheTtlSec * 1_000,
    breakerThreshold,
    breakerCooldownMs: breakerCooldownSec * 1_000,
  };
}

/** Provider API keys — server-side only, never returned to clients. Only
 * `openrouter` is wired for this deployment (`src/config.ts`); the other two
 * read straight from env so adding a credential is additive. */
export function providerKey(provider: string): string | undefined {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY || undefined;
    case "openai":
      return process.env.OPENAI_API_KEY || undefined;
    case "openrouter":
      return config.openRouterApiKey || undefined;
    default:
      return undefined;
  }
}
