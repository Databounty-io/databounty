// SPDX-License-Identifier: Apache-2.0

/**
 * Public entry point for the execution validation stage. The real logic lives
 * in ./execution-providers/ — a SandboxProvider abstraction (E2B today,
 * swappable) plus language harnesses. This file only re-exports the stable
 * surface callers depend on, so nothing outside execution-providers/ needs to
 * change when the sandbox vendor or the supported languages change.
 *
 * Ported from V1 (databounty-api/src/services/execution.ts).
 */
export { executionContractPassed } from "./execution-providers/contract.js";
export {
  runExecution,
  executionToStageResult,
  type ExecutionOutcome,
  type ExecutionPending,
} from "./execution-providers/service.js";
export { assertConfiguredProvidersBootable } from "./execution-providers/provider-order.js";
export { languageSupportFor, type LanguageSupport } from "./execution-providers/language-support.js";
