// SPDX-License-Identifier: Apache-2.0

import type { ZodType, ZodTypeDef } from "zod";

/**
 * LLM layer — public contracts. Ported from v1's
 * `databounty-api/src/services/llm/types.ts`.
 *
 * Call sites depend ONLY on the types in this file. They name a `feature`
 * (never a provider or model), pass messages + an optional zod schema, and get
 * back validated data plus provenance. Everything else — routing, provider
 * failover, guardrails, cache, audit — is internal to the service.
 *
 * The feature union is deliberately the SAME list `routes/v1/admin-llm.ts`
 * shows on the admin console's /llm page, plus `field_validate` (which v1 has
 * and that registry was missing). `features.ts` is now the single registry
 * both this service and that route read, so the console can no longer
 * describe a feature differently from how it is actually called.
 */
export type LlmFeature =
  | "submission_review"
  | "planner_copy"
  | "planner_answer_extract"
  | "suggest"
  | "suggest_description"
  | "interpret_edit_intent"
  | "dataset_type_draft"
  | "field_validate";

export type LlmProviderName = "anthropic" | "openai" | "openrouter" | "fallback";

/** How sensitive the content in a request is. Routing must not send higher
 * classes to providers/models not cleared for them. */
export type DataClass = "public" | "internal" | "proprietary";

export type Role = "system" | "user" | "assistant";
export interface LlmMessage {
  role: Role;
  content: string;
}

/** Tunable model params. All optional; feature config supplies the defaults. */
export interface ModelParams {
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

/** What a caller sends. `feature` selects routing + guardrails + fallback. */
export interface LlmRequest<T = string> {
  feature: LlmFeature;
  messages: LlmMessage[];
  /** If set, the model is asked for JSON and the result is parsed + validated
   * against this schema; `data` is typed `T`. If absent, `data` is raw text.
   *
   * Input is `unknown` on purpose: what gets validated is JSON parsed out of
   * untrusted model text. That also lets a consumer pass a `z.preprocess(...)`
   * schema to normalise a model's near-miss shape before strict validation. */
  schema?: ZodType<T, ZodTypeDef, unknown>;
  /** Rarely needed — feature config is the source of truth for params. */
  overrides?: Partial<ModelParams>;
  /** Dedupe + cache identical calls; also the audit correlation id. */
  idempotencyKey?: string;
  /** Rate-limit attribution. */
  userId?: string;
  /** Selects the account-level model override; falls back to admin-global. */
  accountId?: string;
  /**
   * The deterministic safe default, owned by the CALLER (only it knows the
   * domain-correct floor). Used when no live model can answer (no key / all
   * providers failed / disabled / over budget). If omitted and the layer must
   * fall back, `complete` throws `LlmUnavailableError` — so high-stakes
   * callers should always supply it.
   */
  fallback?: T | (() => T | Promise<T>);
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost in micro-USD (integer) from the model registry pricing. */
  costMicroUsd: number;
}

/** What a caller gets back. `fallbackUsed` is true when NO live model answered
 * and the deterministic path ran. Consumers MUST report this honestly — a
 * fallback is never presented as an LLM result. */
export interface LlmResult<T = string> {
  data: T;
  provider: LlmProviderName;
  model: string;
  usage: Usage;
  fallbackUsed: boolean;
  /** True when a live model failed and a same-class model answered instead. */
  failoverUsed: boolean;
}

/** The normalized request a provider adapter receives (already routed). */
export interface ProviderRequest {
  model: string;
  messages: LlmMessage[];
  params: ModelParams;
  /** Ask the provider for strict JSON output (mode differs per provider). */
  json: boolean;
}

export interface ProviderResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** One provider contract. Adding a provider = implement this + register it.
 * Adapters do transport only — no routing, no guardrails, no business logic. */
export interface LlmProvider {
  readonly name: LlmProviderName;
  /** True when the provider has the credentials it needs to make a call. */
  isConfigured(): boolean;
  complete(req: ProviderRequest): Promise<ProviderResult>;
}

/** Raised by adapters on a transport/provider failure. The service catches it
 * and moves to the next model in the failover chain (never leaks to callers). */
export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly provider: LlmProviderName,
    readonly retryable = true
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}

/** Thrown by `complete` only when a deterministic fallback was needed but the
 * caller supplied none. Callers avoid this by always passing `fallback`. */
export class LlmUnavailableError extends Error {
  constructor(readonly feature: string, readonly reason: string) {
    super(`no LLM answer for '${feature}' and no fallback supplied (${reason})`);
    this.name = "LlmUnavailableError";
  }
}
