// SPDX-License-Identifier: Apache-2.0

/**
 * Complexity score and verification units for the 33 registry categories.
 *
 * Transcribed from `DataBounty_Karma_Trust_System_Redesign.pdf` §4 (restated in
 * `databounty-docs/engineering/KARMA_PRICING_MATRIX_PLAN.md` §10). These are the
 * SEED values: `DatasetType.complexityScore` / `verificationUnits` are the live,
 * admin-editable source of truth once a row exists, and this table only supplies
 * the initial value for a category that has never been scored.
 *
 * Keyed on the registry harness directory / `datasetType` id, so a typo is caught
 * by the seed's coverage check rather than silently leaving a category unpriced.
 *
 * Types NOT in this table — legacy catalog rows, the non-coding domains, and every
 * sponsor fork/custom template — are deliberately absent, not defaulted. An
 * unscored type is *unpriced*, and unpriced must fail closed at mint rather than
 * quietly price at a middle score (plan G-9 / OD-6).
 *
 * Dependency-free leaf module: shared by the seed script, the API read paths, and
 * the admin surface with no import cycle.
 */

export interface CategoryPricingSeed {
  /** 1–4, "what it takes to verify an item is correct". */
  complexityScore: number;
  /** Template fields that undergo automated, machine-run verification. */
  verificationUnits: number;
}

export const CATEGORY_PRICING_SEED: Readonly<Record<string, CategoryPricingSeed>> = {
  debugging: { complexityScore: 1, verificationUnits: 2 },
  code_translation: { complexityScore: 2, verificationUnits: 2 },
  implementation: { complexityScore: 1, verificationUnits: 1 },
  fail_to_pass: { complexityScore: 2, verificationUnits: 2 },
  unit_test_gen: { complexityScore: 2, verificationUnits: 2 },
  terminal_cli: { complexityScore: 3, verificationUnits: 1 },
  competitive_programming: { complexityScore: 4, verificationUnits: 1 },
  data_transformation: { complexityScore: 1, verificationUnits: 1 },
  refactoring: { complexityScore: 1, verificationUnits: 2 },
  git_merge_resolution: { complexityScore: 2, verificationUnits: 1 },
  api_function_calling: { complexityScore: 2, verificationUnits: 1 },
  execution_trace: { complexityScore: 1, verificationUnits: 1 },
  regex_generation: { complexityScore: 2, verificationUnits: 3 },
  vulnerability: { complexityScore: 4, verificationUnits: 2 },
  build_dependency_resolution: { complexityScore: 3, verificationUnits: 1 },
  performance: { complexityScore: 4, verificationUnits: 4 },
  static_compilation: { complexityScore: 4, verificationUnits: 1 },
  notebook_pipeline: { complexityScore: 3, verificationUnits: 2 },
  web_scraping: { complexityScore: 3, verificationUnits: 1 },
  cryptographic_implementation: { complexityScore: 4, verificationUnits: 1 },
  package_publishing: { complexityScore: 3, verificationUnits: 3 },
  memory_safety: { complexityScore: 4, verificationUnits: 1 },
  serialization: { complexityScore: 2, verificationUnits: 2 },
  graphql_resolver: { complexityScore: 1, verificationUnits: 1 },
  log_parsing: { complexityScore: 1, verificationUnits: 1 },
  network_protocol_fsm: { complexityScore: 4, verificationUnits: 1 },
  dependency_vuln_audit: { complexityScore: 4, verificationUnits: 1 },
  shell_idempotency: { complexityScore: 3, verificationUnits: 2 },
  websocket_realtime: { complexityScore: 3, verificationUnits: 2 },
  i18n: { complexityScore: 1, verificationUnits: 2 },
  auth_flow: { complexityScore: 3, verificationUnits: 3 },
  compression: { complexityScore: 2, verificationUnits: 2 },
  feature_flag: { complexityScore: 3, verificationUnits: 1 },
  sql_query_correctness: { complexityScore: 2, verificationUnits: 2 },
  database_migration_correctness: { complexityScore: 3, verificationUnits: 2 },
  redis_data_structure_semantics: { complexityScore: 4, verificationUnits: 2 },
  concurrency_race_detection: { complexityScore: 4, verificationUnits: 2 },
  property_based_testing: { complexityScore: 3, verificationUnits: 1 },
  schema_conformance_validation: { complexityScore: 3, verificationUnits: 1 },
  diff_patch_application: { complexityScore: 2, verificationUnits: 1 },
  algorithmic_complexity_verification: { complexityScore: 4, verificationUnits: 2 },
  http_api_contract_testing: { complexityScore: 3, verificationUnits: 2 },
  static_lint_rule_fix_verification: { complexityScore: 2, verificationUnits: 1 },
  rate_limiting_policy_simulation: { complexityScore: 3, verificationUnits: 2 },
  caching_strategy: { complexityScore: 3, verificationUnits: 2 },
  numerical_precision: { complexityScore: 2, verificationUnits: 1 },
  retry_backoff_resilience: { complexityScore: 4, verificationUnits: 3 },
  ast_codemod_transformation: { complexityScore: 3, verificationUnits: 2 },
  cli_argument_parsing: { complexityScore: 3, verificationUnits: 2 },
  algorithmic_trading_backtest: { complexityScore: 4, verificationUnits: 3 },
};

/** The number of categories the source document scores. A count, so a dropped or
 * duplicated row during an edit is a test failure rather than a quiet gap. */
export const SCORED_CATEGORY_COUNT = 50;

export function categoryPricingSeed(datasetTypeId: string): CategoryPricingSeed | null {
  return Object.hasOwn(CATEGORY_PRICING_SEED, datasetTypeId) ? CATEGORY_PRICING_SEED[datasetTypeId]! : null;
}
