// SPDX-License-Identifier: Apache-2.0

/**
 * LLM layer — public surface. Import from here; internals may move.
 *
 *   import { llm } from "../services/llm/index.js";
 *   const res = await llm.complete({ feature: "suggest", messages, fallback: [...] });
 */
export { llm, LlmService } from "./service.js";
export { LlmProviderError, LlmUnavailableError } from "./types.js";
export type { LlmFeature, LlmMessage, LlmRequest, LlmResult, DataClass, Usage } from "./types.js";
export { setAuditSink, type LlmAuditRecord, type LlmAuditSink } from "./audit.js";
export { prismaAuditSink } from "./audit-prisma.js";
export { checkGovernor, type GovernorDecision } from "./governor.js";
export {
  getGovernanceConfig,
  GOVERNANCE_SETTING_KEYS,
  parseOverride,
  resolveFeaturePlan,
  adminGlobalKey,
  accountKey,
  resolveSystemPrompt,
  parseSystemPrompt,
  systemPromptKey,
  accountSystemPromptKey,
  promptVersion,
  clearLlmConfigCache,
  providerKey,
  type GovernanceConfig,
  type LlmOverride,
  type ResolvedPrompt,
} from "./config.js";
export { resetBreakers } from "./breaker.js";
export { FEATURES, FEATURE_NAMES, featureDef, isLlmFeature, type FeatureDef } from "./features.js";
export { MODEL_REGISTRY, lookupModel, type ModelEntry } from "./registry.js";
export { discoverOpenRouterModels, ProviderCatalogError, type DiscoveredModel } from "./provider-catalog.js";
