// SPDX-License-Identifier: Apache-2.0

import { config } from "../../config.js";
import { discoverOpenRouterModels } from "./provider-catalog.js";
import type { DataClass, LlmProviderName } from "./types.js";

/**
 * Model registry — capabilities + pricing per model. Ported from v1's
 * `services/llm/registry.ts`.
 *
 * Routing never points at a bare string. A feature declares requirements
 * (context window, JSON mode, data class); the router only accepts a model
 * whose registry entry satisfies them, else it fails closed to the next
 * config level (and ultimately to the caller's deterministic fallback).
 *
 * Every bundled entry is an OpenRouter route, because `OPENROUTER_API_KEY` is
 * the only provider credential this deployment wires (`src/config.ts`).
 * Registering an Anthropic-direct or OpenAI-direct model here would let an
 * admin route a feature at a model that can never be reached. The `anthropic`
 * / `openai` provider names still exist in the type union so adding a
 * credential later is an additive change, not a refactor.
 *
 * Model ids are the ones verified live against OpenRouter for this deployment
 * (see `services/llm-client.ts`'s note: the older `claude-3-5-*` slugs the
 * admin console used to advertise are retired and return HTTP 404).
 */
export interface ModelEntry {
  provider: LlmProviderName;
  id: string;
  contextWindow: number;
  maxOutput: number;
  supportsJson: boolean;
  supportsTools: boolean;
  inputPricePerMTok: number; // USD per 1M input tokens
  outputPricePerMTok: number; // USD per 1M output tokens
  /** Highest data class this model/provider is cleared to receive. */
  maxDataClass: DataClass;
  status: "active" | "deprecated";
}

const DATA_ORDER: Record<DataClass, number> = { public: 0, internal: 1, proprietary: 2 };

export function dataClassAllowed(modelMax: DataClass, requestClass: DataClass): boolean {
  return DATA_ORDER[modelMax] >= DATA_ORDER[requestClass];
}

export const MODEL_REGISTRY: Record<string, ModelEntry> = {
  // Higher-reasoning route for evidence-heavy submission review. Cleared for
  // proprietary content (accepted tradeoff: OpenRouter forwards to a
  // third-party model — the same tradeoff v1 documented and accepted).
  "openrouter-sonnet-4": {
    provider: "openrouter", id: "anthropic/claude-sonnet-4",
    contextWindow: 200_000, maxOutput: 64_000,
    supportsJson: true, supportsTools: true,
    inputPricePerMTok: 3, outputPricePerMTok: 15,
    maxDataClass: "proprietary", status: "active",
  },
  // Cheap-but-capable default for every planner helper, and the same-class
  // failover for submission review.
  "openrouter-haiku": {
    provider: "openrouter", id: "anthropic/claude-haiku-4.5",
    contextWindow: 200_000, maxOutput: 8_000,
    supportsJson: true, supportsTools: false,
    inputPricePerMTok: 1, outputPricePerMTok: 5,
    maxDataClass: "proprietary", status: "active",
  },
  // Internal-only contract drafting. Deliberately NOT cleared for proprietary
  // contributor submissions.
  "openrouter-glm-4-7": {
    provider: "openrouter", id: "z-ai/glm-4.7",
    contextWindow: 203_000, maxOutput: 32_000,
    supportsJson: true, supportsTools: true,
    inputPricePerMTok: 0.4, outputPricePerMTok: 1.75,
    maxDataClass: "internal", status: "active",
  },
  "openrouter-deepseek-v4-flash": {
    provider: "openrouter", id: "deepseek/deepseek-v4-flash",
    contextWindow: 1_000_000, maxOutput: 384_000,
    supportsJson: true, supportsTools: true,
    inputPricePerMTok: 0.09, outputPricePerMTok: 0.18,
    maxDataClass: "internal", status: "active",
  },
  // Low-latency structured-output route for requester-facing planner help.
  // Kept separate from a gateway "auto" route so the gateway cannot select a
  // slow reasoning model for an interactive form.
  "openrouter-fast": {
    provider: "openrouter", id: "cohere/command-r7b-12-2024",
    contextWindow: 128_000, maxOutput: 4_000,
    supportsJson: true, supportsTools: false,
    inputPricePerMTok: 0.0375, outputPricePerMTok: 0.15,
    maxDataClass: "public", status: "active",
  },
};

export function lookupModel(idOrKey: string): ModelEntry | undefined {
  if (MODEL_REGISTRY[idOrKey]) return MODEL_REGISTRY[idOrKey];
  return Object.values(MODEL_REGISTRY).find((m) => m.id === idOrKey);
}

/** Resolve a bundled routing model or a live, cached OpenRouter discovery row.
 * Discovered rows are treated as `internal` at most and priced at 0 (we do not
 * know their real rates), so a discovered model can never be routed a
 * proprietary-class payload. */
export async function lookupModelConfigured(idOrKey: string): Promise<ModelEntry | undefined> {
  const bundled = lookupModel(idOrKey);
  if (bundled) return bundled;
  try {
    const catalog = await discoverOpenRouterModels(config.openRouterApiKey ?? "");
    const model = catalog.models.find((candidate) => candidate.id === idOrKey);
    if (!model) return undefined;
    return {
      provider: "openrouter", id: model.id,
      contextWindow: model.contextWindow ?? 8_000, maxOutput: 8_000,
      supportsJson: model.supportsJson, supportsTools: false,
      inputPricePerMTok: 0, outputPricePerMTok: 0,
      maxDataClass: "internal", status: "active",
    };
  } catch {
    return undefined;
  }
}

/** Estimated cost (micro-USD, integer) for a completed call. */
export function estimateCostMicroUsd(model: ModelEntry, inputTokens: number, outputTokens: number): number {
  const inUsd = (inputTokens / 1_000_000) * model.inputPricePerMTok;
  const outUsd = (outputTokens / 1_000_000) * model.outputPricePerMTok;
  return Math.round((inUsd + outUsd) * 1_000_000);
}
