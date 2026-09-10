// SPDX-License-Identifier: Apache-2.0

import type { DatasetCategory } from "./types";

/* ------------------------------------------------------------------ */
/* Dataset Types — first-class, versioned templates.                   */
/* A type's schema fields carry SEMANTIC ROLES; the three surfaces     */
/* (sponsor spec, contributor form, validator review) render from the  */
/* roles automatically — no per-type screen design.                    */
/* ------------------------------------------------------------------ */

export type DomainId = "coding" | "legal" | "healthcare" | "finance" | "science";

export interface Domain {
  id: DomainId;
  name: string;
  status: "live" | "coming_soon";
  tagline: string;
  /** who we want on the expert waitlist */
  expertPitch: string;
  waitlistCount: number;
}

export const DOMAINS: Domain[] = [
  {
    id: "coding",
    name: "Coding",
    status: "live",
    tagline: "Debugging, implementation, tests, SQL, regex — execution-verified where possible.",
    expertPitch: "Software engineers earn per accepted item across 11 dataset types.",
    waitlistCount: 0,
  },
  {
    id: "legal",
    name: "Legal",
    status: "coming_soon",
    tagline: "Contract clauses, jurisdictional reasoning, case analysis — expert-audited.",
    expertPitch: "Licensed attorneys review and author verified legal reasoning data.",
    waitlistCount: 214,
  },
  {
    id: "healthcare",
    name: "Healthcare",
    status: "coming_soon",
    tagline: "Anonymized diagnostic reasoning and clinical pathways — expert-audited.",
    expertPitch: "Verified medical professionals audit every accepted item.",
    waitlistCount: 168,
  },
  {
    id: "finance",
    name: "Finance",
    status: "coming_soon",
    tagline: "Quant strategies, statement analysis, compliance flags — expert-audited.",
    expertPitch: "Quants and CPAs validate strategy logic and accounting references.",
    waitlistCount: 121,
  },
  {
    id: "science",
    name: "Math & Science",
    status: "coming_soon",
    tagline: "Step-by-step proofs and derivations — symbolically checked where possible.",
    expertPitch: "Advanced-degree mathematicians and physicists verify reasoning chains.",
    waitlistCount: 97,
  },
];

/* ---------- fields & roles ---------- */

export type FieldRole =
  | "instruction" // natural-language prompt / requirement
  | "input_context" // schema, spec, logs, docs the item is grounded in
  | "input_code" // code given to the contributor (broken/starter/source)
  | "solution_code" // code the contributor produces
  | "tests" // test code
  | "expected_output" // exact expected result (JSON/shape/matches)
  | "rationale" // explanation / reasoning text
  | "enum" // pick-one metadata (e.g. bug_type)
  | "list" // array of short strings (e.g. edge cases, negative matches)
  | "reference" // optional citation / link (e.g. CVE, standard)
  | "file"; // uploaded source artifact, constrained by `accept`

export interface TypeField {
  key: string;
  label: string;
  role: FieldRole;
  lang?: string; // for code roles: ts, py, sql, sh, regex…
  options?: string[]; // for enum
  required?: boolean;
  help?: string;
  /** Browser accept metadata. The server remains authoritative for file validation. */
  accept?: string;
}

export type VerificationCheck =
  | "dedupe"
  | "ai_attribution"
  | "execution"
  | "llm"
  | "human_audit";

export type TrustTier = "execution_verified" | "llm_verified" | "expert_audited";

export const TRUST_TIER_LABELS: Record<TrustTier, string> = {
  execution_verified: "Execution-verified",
  llm_verified: "LLM-verified",
  expert_audited: "Expert-audited",
};

export type TypeStatus = "active" | "draft" | "coming_soon" | "platform_review";

export interface DatasetType {
  id: string;
  familyId?: string;
  supersedesId?: string | null;
  version: number;
  domain: DomainId;
  name: string;
  description: string;
  status: TypeStatus;
  origin: "platform" | "sponsor";
  /** nearest legacy category — keeps bounty filters/labels working */
  category: DatasetCategory;
  fields: TypeField[];
  verification: {
    pipeline: VerificationCheck[];
    executionEnv?: string; // node:20 | python:3.11 | sqlite | regex-engine | none
    dedupeFields: string[];
    auditOptions: number[]; // human audit coverage % choices
    formatProfile?: string;
    validationProfile?: string;
    normalizationProfile?: string;
    similarityProfile?: string;
    previewProfile?: string;
    sandboxProfile?: string;
  };
  trustTier: TrustTier;
  difficultyLevels: string[];
  usageCount: number; // bounties launched with this type (mock)
  /** Karma rate axes (KARMA_PRICING_MATRIX_PLAN.md §5.1). Null means
   * no karma rate — activation is blocked server-side until both are set. */
  complexityScore?: number | null;
  verificationUnits?: number | null;
  /** The admin's note from the most recent platform-review decision. */
  reviewNote?: string | null;
  /** The SPONSOR's own plain-text request for sandboxed execution
   * verification, written at fork/custom creation time. Never executable —
   * harness authorship stays admin-only (see HarnessPanel). Null means the
   * sponsor did not request one. */
  sponsorHarnessNote?: string | null;
  /** Curated example item(s) shown on the template card, HuggingFace-style.
   * Null/empty when the platform hasn't added a licence-cleared sample yet —
   * the card then renders an explicit "no sample" state, never a fake row. */
  sampleAssets?: DatasetTypeSample[] | null;
}

/** One curated example item for a dataset type. `fields` holds text values
 * keyed by the type's field keys; `media` holds hosted preview URLs for
 * image/audio/video/file fields. Both are optional so a text-only or a
 * media-only template can each carry a meaningful sample. */
export interface DatasetTypeSample {
  fields?: Record<string, string>;
  media?: { key: string; url: string; kind: "image" | "audio" | "video" | "file"; alt?: string }[];
  caption?: string;
}

const DIFF3 = ["beginner", "intermediate", "expert"];

/* ------------------------------------------------------------------ */
/* The catalog. Coding is extensive: the 5 originals, the taxonomy     */
/* doc's additions, and platform picks. Non-coding types seed the      */
/* coming-soon domain teasers.                                         */
/* ------------------------------------------------------------------ */

export const DATASET_TYPE_CATALOG: DatasetType[] = [
  /* ---------- coding · the original five ---------- */
  {
    id: "debugging",
    version: 3,
    domain: "coding",
    name: "Debugging / Bug Fix",
    description:
      "Broken code paired with its corrected version, driven by failing tests. The flagship execution-verified type.",
    status: "active",
    origin: "platform",
    category: "debugging",
    fields: [
      { key: "prompt", label: "Bug description", role: "instruction", required: true },
      { key: "broken_code", label: "Broken code", role: "input_code", lang: "ts", required: true },
      { key: "fixed_code", label: "Fixed code", role: "solution_code", lang: "ts", required: true },
      { key: "tests", label: "Tests", role: "tests", lang: "ts", required: true, help: "Broken code must FAIL these; fixed code must PASS." },
      { key: "explanation", label: "Explanation", role: "rationale", required: true },
      { key: "bug_type", label: "Bug type", role: "enum", options: ["logic", "state", "async", "types", "perf", "memory"] },
    ],
    verification: {
      pipeline: ["dedupe", "execution", "llm", "human_audit"],
      executionEnv: "node:20 / python:3.11",
      dedupeFields: ["prompt", "broken_code"],
      auditOptions: [0, 25, 100],
    },
    trustTier: "execution_verified",
    difficultyLevels: DIFF3,
    usageCount: 6,
  },
  {
    id: "implementation",
    version: 2,
    domain: "coding",
    name: "Function / Feature Implementation",
    description:
      "A working, tested implementation generated from a natural-language requirement or starter code.",
    status: "active",
    origin: "platform",
    category: "implementation",
    fields: [
      { key: "prompt", label: "Requirement", role: "instruction", required: true },
      { key: "starter_code", label: "Starter code", role: "input_code", lang: "ts" },
      { key: "solution_code", label: "Solution", role: "solution_code", lang: "ts", required: true },
      { key: "tests", label: "Tests", role: "tests", lang: "ts", required: true, help: "Solution must PASS all provided tests." },
      { key: "explanation", label: "Explanation", role: "rationale" },
    ],
    verification: {
      pipeline: ["dedupe", "execution", "llm"],
      executionEnv: "node:20 / python:3.11",
      dedupeFields: ["prompt", "solution_code"],
      auditOptions: [0, 25, 100],
    },
    trustTier: "execution_verified",
    difficultyLevels: DIFF3,
    usageCount: 4,
  },
  {
    id: "test_generation",
    version: 2,
    domain: "coding",
    name: "Test Generation",
    description:
      "Comprehensive unit or integration tests for a provided piece of target code or specification.",
    status: "active",
    origin: "platform",
    category: "test_generation",
    fields: [
      { key: "target_code_or_spec", label: "Target code / spec", role: "input_code", lang: "go", required: true },
      { key: "test_code", label: "Test code", role: "solution_code", lang: "go", required: true },
      { key: "test_rationale", label: "Test rationale", role: "rationale", required: true },
      { key: "edge_cases_covered", label: "Edge cases covered", role: "list" },
    ],
    verification: {
      pipeline: ["dedupe", "execution", "llm"],
      executionEnv: "node:20 / go:1.22",
      dedupeFields: ["target_code_or_spec", "test_code"],
      auditOptions: [0, 25, 100],
    },
    trustTier: "execution_verified",
    difficultyLevels: ["intermediate", "expert"],
    usageCount: 3,
  },
  {
    id: "error_diagnosis",
    version: 2,
    domain: "coding",
    name: "Error Diagnosis / Root Cause Analysis",
    description:
      "Root-cause analysis of a complex error from a stack trace or log output, with a suggested fix.",
    status: "active",
    origin: "platform",
    category: "error_diagnosis",
    fields: [
      { key: "error_message", label: "Error message", role: "input_context", required: true },
      { key: "stack_trace", label: "Stack trace / logs", role: "input_context", required: true },
      { key: "relevant_code_snippet", label: "Relevant code", role: "input_code", lang: "py" },
      { key: "root_cause_analysis", label: "Root cause analysis", role: "rationale", required: true },
      { key: "suggested_fix", label: "Suggested fix", role: "solution_code", lang: "py" },
    ],
    verification: {
      pipeline: ["dedupe", "llm", "human_audit"],
      dedupeFields: ["error_message", "root_cause_analysis"],
      auditOptions: [25, 100],
    },
    trustTier: "llm_verified",
    difficultyLevels: ["intermediate", "expert"],
    usageCount: 3,
  },
  {
    id: "migration",
    version: 2,
    domain: "coding",
    name: "Migration / Refactor",
    description:
      "Old pattern to modern equivalent within a language or framework — behavior preserved, verified by tests.",
    status: "active",
    origin: "platform",
    category: "migration",
    fields: [
      { key: "prompt", label: "Migration goal", role: "instruction", required: true },
      { key: "source_code", label: "Source (old pattern)", role: "input_code", lang: "ts", required: true },
      { key: "migrated_code", label: "Migrated code", role: "solution_code", lang: "ts", required: true },
      { key: "tests", label: "Behavior tests", role: "tests", lang: "ts", required: true },
      { key: "explanation", label: "Explanation", role: "rationale" },
    ],
    verification: {
      pipeline: ["dedupe", "execution", "llm"],
      executionEnv: "node:20 / python:3.11",
      dedupeFields: ["source_code", "migrated_code"],
      auditOptions: [0, 25, 100],
    },
    trustTier: "execution_verified",
    difficultyLevels: ["intermediate", "expert"],
    usageCount: 2,
  },

  /* ---------- coding · from the taxonomy doc ---------- */
  {
    id: "sql_generation",
    version: 1,
    domain: "coding",
    name: "SQL Query Optimization / Generation",
    description:
      "Natural language to SQL against a provided schema, or optimizing slow queries — executed against a mock database.",
    status: "active",
    origin: "platform",
    category: "implementation",
    fields: [
      { key: "schema_definition", label: "Schema definition", role: "input_context", required: true },
      { key: "natural_language_prompt", label: "Request", role: "instruction", required: true },
      { key: "sql_query", label: "SQL query", role: "solution_code", lang: "sql", required: true },
      { key: "expected_output_shape", label: "Expected output shape", role: "expected_output", required: true },
    ],
    verification: {
      pipeline: ["dedupe", "execution", "llm"],
      executionEnv: "sqlite / postgres:16",
      dedupeFields: ["natural_language_prompt", "sql_query"],
      auditOptions: [0, 25],
    },
    trustTier: "execution_verified",
    difficultyLevels: DIFF3,
    usageCount: 1,
  },
  {
    id: "code_translation",
    version: 1,
    domain: "coding",
    name: "Code Translation (Cross-Language)",
    description:
      "Translating code between languages — the translated code must pass the same logical tests as the source.",
    status: "active",
    origin: "platform",
    category: "migration",
    fields: [
      { key: "source_code", label: "Source code", role: "input_code", lang: "py", required: true },
      { key: "source_language", label: "Source language", role: "enum", options: ["Python", "TypeScript", "Go", "Rust", "Java"], required: true },
      { key: "target_language", label: "Target language", role: "enum", options: ["Python", "TypeScript", "Go", "Rust", "Java"], required: true },
      { key: "translated_code", label: "Translated code", role: "solution_code", lang: "rs", required: true },
      { key: "tests", label: "Shared logical tests", role: "tests", required: true },
    ],
    verification: {
      pipeline: ["dedupe", "execution", "llm"],
      executionEnv: "polyglot sandbox",
      dedupeFields: ["source_code", "translated_code"],
      auditOptions: [0, 25],
    },
    trustTier: "execution_verified",
    difficultyLevels: ["intermediate", "expert"],
    usageCount: 1,
  },
  {
    id: "regex_generation",
    version: 1,
    domain: "coding",
    name: "Regular Expression Generation",
    description:
      "Regex patterns for a stated intent, with positive and negative match sets — mechanically verified in milliseconds.",
    status: "active",
    origin: "platform",
    category: "implementation",
    fields: [
      { key: "intent_prompt", label: "Intent", role: "instruction", required: true },
      { key: "regex_pattern", label: "Pattern", role: "solution_code", lang: "regex", required: true },
      { key: "positive_matches", label: "Must match", role: "list", required: true },
      { key: "negative_matches", label: "Must NOT match", role: "list", required: true },
    ],
    verification: {
      pipeline: ["dedupe", "execution"],
      executionEnv: "regex-engine",
      dedupeFields: ["intent_prompt", "regex_pattern"],
      auditOptions: [0],
    },
    trustTier: "execution_verified",
    difficultyLevels: DIFF3,
    usageCount: 0,
  },
  {
    id: "config_iac",
    version: 1,
    domain: "coding",
    name: "Configuration / IaC Generation",
    description:
      "CI/CD, Docker, and IaC config files from requirements — validated by linters and dry runs.",
    status: "draft",
    origin: "platform",
    category: "implementation",
    fields: [
      { key: "requirement_prompt", label: "Requirement", role: "instruction", required: true },
      { key: "config_file_content", label: "Config file", role: "solution_code", lang: "yaml", required: true },
      { key: "target_system", label: "Target system", role: "enum", options: ["GitHub Actions", "Dockerfile", "Infrastructure-as-Code", "Kubernetes"], required: true },
    ],
    verification: {
      pipeline: ["dedupe", "llm"],
      executionEnv: "linters / dry-run",
      dedupeFields: ["requirement_prompt", "config_file_content"],
      auditOptions: [25],
    },
    trustTier: "llm_verified",
    difficultyLevels: DIFF3,
    usageCount: 0,
  },
  {
    id: "security_vuln",
    version: 1,
    domain: "coding",
    name: "Security Vulnerability Identification",
    description:
      "Specific security flaws in code with secure alternatives — SAST plus mandatory expert audit.",
    status: "draft",
    origin: "platform",
    category: "error_diagnosis",
    fields: [
      { key: "vulnerable_code", label: "Vulnerable code", role: "input_code", required: true },
      { key: "vulnerability_type", label: "Vulnerability type", role: "enum", options: ["XSS", "SQLi", "CSRF", "race condition", "crypto", "authz"], required: true },
      { key: "cve_reference", label: "CVE reference", role: "reference" },
      { key: "secure_code", label: "Secure alternative", role: "solution_code", required: true },
      { key: "explanation", label: "Explanation", role: "rationale", required: true },
    ],
    verification: {
      pipeline: ["dedupe", "llm", "human_audit"],
      executionEnv: "SAST tools",
      dedupeFields: ["vulnerable_code", "explanation"],
      auditOptions: [100],
    },
    trustTier: "expert_audited",
    difficultyLevels: ["intermediate", "expert"],
    usageCount: 0,
  },
  {
    id: "api_docs",
    version: 1,
    domain: "coding",
    name: "API Documentation Generation",
    description:
      "OpenAPI specs or Markdown docs generated from source — schema-linted and LLM-checked against the source.",
    status: "draft",
    origin: "platform",
    category: "implementation",
    fields: [
      { key: "source_code_or_endpoint", label: "Source code / endpoint", role: "input_code", required: true },
      { key: "openapi_spec_json", label: "OpenAPI spec", role: "solution_code", lang: "json", required: true },
      { key: "markdown_docs", label: "Markdown docs", role: "rationale" },
    ],
    verification: {
      pipeline: ["dedupe", "llm"],
      executionEnv: "openapi linter",
      dedupeFields: ["source_code_or_endpoint"],
      auditOptions: [0, 25],
    },
    trustTier: "llm_verified",
    difficultyLevels: ["intermediate"],
    usageCount: 0,
  },
  {
    id: "data_extraction",
    version: 1,
    domain: "coding",
    name: "Data Parsing / Extraction Scripts",
    description:
      "Scripts that pull exact structured data out of messy input — output must byte-match the expected JSON.",
    status: "draft",
    origin: "platform",
    category: "implementation",
    fields: [
      { key: "raw_input_data", label: "Raw input", role: "input_context", required: true },
      { key: "extraction_script", label: "Extraction script", role: "solution_code", lang: "py", required: true },
      { key: "expected_json_output", label: "Expected JSON output", role: "expected_output", required: true },
    ],
    verification: {
      pipeline: ["dedupe", "execution"],
      executionEnv: "python:3.11",
      dedupeFields: ["raw_input_data", "extraction_script"],
      auditOptions: [0, 25],
    },
    trustTier: "execution_verified",
    difficultyLevels: ["intermediate", "expert"],
    usageCount: 0,
  },

  /* ---------- coding · platform picks ---------- */
  {
    id: "code_explanation",
    version: 1,
    domain: "coding",
    name: "Code Explanation & Docstrings",
    description:
      "Accurate natural-language explanations and docstrings for real code — trains models to read before they write.",
    status: "active",
    origin: "platform",
    category: "error_diagnosis",
    fields: [
      { key: "target_code", label: "Target code", role: "input_code", required: true },
      { key: "explanation", label: "Explanation", role: "rationale", required: true },
      { key: "docstring", label: "Docstring", role: "solution_code" },
      { key: "audience", label: "Audience", role: "enum", options: ["beginner", "peer", "reviewer"] },
    ],
    verification: {
      pipeline: ["dedupe", "llm", "human_audit"],
      dedupeFields: ["target_code", "explanation"],
      auditOptions: [25, 100],
    },
    trustTier: "llm_verified",
    difficultyLevels: DIFF3,
    usageCount: 1,
  },
  {
    id: "code_review",
    version: 1,
    domain: "coding",
    name: "Code Review Annotations",
    description:
      "Find the real issues in a diff — line-anchored review comments with severity, verified by expert audit.",
    status: "active",
    origin: "platform",
    category: "error_diagnosis",
    fields: [
      { key: "diff", label: "Diff under review", role: "input_code", lang: "diff", required: true },
      { key: "review_comments", label: "Review comments", role: "list", required: true, help: "Each: line anchor + issue + why it matters." },
      { key: "severity_summary", label: "Severity summary", role: "enum", options: ["blocking", "major", "minor", "clean"] },
      { key: "rationale", label: "Overall rationale", role: "rationale", required: true },
    ],
    verification: {
      pipeline: ["dedupe", "llm", "human_audit"],
      dedupeFields: ["diff", "rationale"],
      auditOptions: [25, 100],
    },
    trustTier: "expert_audited",
    difficultyLevels: ["intermediate", "expert"],
    usageCount: 1,
  },
  {
    id: "perf_optimization",
    version: 1,
    domain: "coding",
    name: "Performance Optimization Pairs",
    description:
      "Slow implementation → fast implementation with a benchmark harness proving the speedup and identical behavior.",
    status: "active",
    origin: "platform",
    category: "debugging",
    fields: [
      { key: "slow_code", label: "Slow implementation", role: "input_code", required: true },
      { key: "fast_code", label: "Optimized implementation", role: "solution_code", required: true },
      { key: "benchmark", label: "Benchmark harness", role: "tests", required: true, help: "Must show ≥2x speedup and identical outputs." },
      { key: "explanation", label: "What changed and why", role: "rationale", required: true },
    ],
    verification: {
      pipeline: ["dedupe", "execution", "llm"],
      executionEnv: "node:20 / python:3.11",
      dedupeFields: ["slow_code", "fast_code"],
      auditOptions: [0, 25],
    },
    trustTier: "execution_verified",
    difficultyLevels: ["intermediate", "expert"],
    usageCount: 0,
  },
  {
    id: "cli_commands",
    version: 1,
    domain: "coding",
    name: "CLI Command Generation",
    description:
      "Natural language to safe, correct shell commands with safety annotations — dry-run verified where possible.",
    status: "draft",
    origin: "platform",
    category: "implementation",
    fields: [
      { key: "intent", label: "Intent", role: "instruction", required: true },
      { key: "command", label: "Command", role: "solution_code", lang: "sh", required: true },
      { key: "safety_notes", label: "Safety annotations", role: "list", required: true },
      { key: "platform", label: "Platform", role: "enum", options: ["linux", "macos", "windows"] },
    ],
    verification: {
      pipeline: ["dedupe", "llm"],
      executionEnv: "container dry-run",
      dedupeFields: ["intent", "command"],
      auditOptions: [25],
    },
    trustTier: "llm_verified",
    difficultyLevels: DIFF3,
    usageCount: 0,
  },

  /* ---------- coming-soon domains (teaser types) ---------- */
  {
    id: "legal_clause",
    version: 1,
    domain: "legal",
    name: "Legal Contract Clause Generation",
    description:
      "Clauses tailored to jurisdiction and negotiation constraints, with legal rationale — audited by licensed attorneys.",
    status: "coming_soon",
    origin: "platform",
    category: "implementation",
    fields: [
      { key: "jurisdiction", label: "Jurisdiction", role: "enum", options: ["US-DE", "US-CA", "UK", "EU", "IN"], required: true },
      { key: "contract_type", label: "Contract type", role: "enum", options: ["NDA", "MSA", "SAFE", "employment", "licensing"], required: true },
      { key: "party_representation", label: "Representing", role: "instruction", required: true },
      { key: "clause_text", label: "Clause", role: "rationale", required: true },
      { key: "legal_rationale", label: "Legal rationale", role: "rationale", required: true },
    ],
    verification: {
      pipeline: ["dedupe", "llm", "human_audit"],
      dedupeFields: ["clause_text"],
      auditOptions: [100],
    },
    trustTier: "expert_audited",
    difficultyLevels: ["intermediate", "expert"],
    usageCount: 0,
  },
  {
    id: "medical_reasoning",
    version: 1,
    domain: "healthcare",
    name: "Medical Diagnostic Reasoning",
    description:
      "Structured clinical reasoning from anonymized presentations — audited by verified medical professionals.",
    status: "coming_soon",
    origin: "platform",
    category: "error_diagnosis",
    fields: [
      { key: "anonymized_case_presentation", label: "Case presentation", role: "input_context", required: true },
      { key: "differential_diagnosis", label: "Differential diagnosis", role: "list", required: true },
      { key: "recommended_tests", label: "Recommended tests", role: "list", required: true },
      { key: "final_diagnosis_rationale", label: "Diagnosis rationale", role: "rationale", required: true },
    ],
    verification: {
      pipeline: ["dedupe", "llm", "human_audit"],
      dedupeFields: ["anonymized_case_presentation"],
      auditOptions: [100],
    },
    trustTier: "expert_audited",
    difficultyLevels: ["expert"],
    usageCount: 0,
  },
  {
    id: "quant_strategy",
    version: 1,
    domain: "finance",
    name: "Quantitative Finance Strategy",
    description:
      "Strategy logic and risk parameters for market scenarios — backtested when expressed as code.",
    status: "coming_soon",
    origin: "platform",
    category: "implementation",
    fields: [
      { key: "market_scenario_description", label: "Market scenario", role: "input_context", required: true },
      { key: "strategy_logic_or_pseudocode", label: "Strategy logic", role: "solution_code", lang: "py", required: true },
      { key: "risk_parameters", label: "Risk parameters", role: "list", required: true },
      { key: "expected_outcome", label: "Expected outcome", role: "expected_output", required: true },
    ],
    verification: {
      pipeline: ["dedupe", "execution", "llm", "human_audit"],
      executionEnv: "backtest sandbox",
      dedupeFields: ["strategy_logic_or_pseudocode"],
      auditOptions: [100],
    },
    trustTier: "expert_audited",
    difficultyLevels: ["expert"],
    usageCount: 0,
  },
  {
    id: "accounting_analysis",
    version: 1,
    domain: "finance",
    name: "Accounting Document Analysis",
    description:
      "Anomalies and compliance flags from 10-K/10-Q excerpts, referenced to accounting standards — CPA-audited.",
    status: "coming_soon",
    origin: "platform",
    category: "error_diagnosis",
    fields: [
      { key: "document_excerpt", label: "Document excerpt", role: "input_context", required: true },
      { key: "identified_anomaly_or_insight", label: "Anomaly / insight", role: "rationale", required: true },
      { key: "accounting_standard_reference", label: "Standard reference", role: "reference", required: true },
    ],
    verification: {
      pipeline: ["dedupe", "llm", "human_audit"],
      dedupeFields: ["financial_document_excerpt", "identified_anomaly_or_insight"],
      auditOptions: [100],
    },
    trustTier: "expert_audited",
    difficultyLevels: ["intermediate", "expert"],
    usageCount: 0,
  },
  {
    id: "math_proofs",
    version: 1,
    domain: "science",
    name: "Mathematics / Physics Proofs",
    description:
      "Step-by-step proofs for complex problems, checked by symbolic computation where possible.",
    status: "coming_soon",
    origin: "platform",
    category: "implementation",
    fields: [
      { key: "problem_statement", label: "Problem statement", role: "instruction", required: true },
      { key: "step_by_step_proof", label: "Step-by-step proof", role: "rationale", required: true },
      { key: "final_answer", label: "Final answer", role: "expected_output", required: true },
    ],
    verification: {
      pipeline: ["dedupe", "execution", "llm"],
      executionEnv: "sympy / mathematica",
      dedupeFields: ["problem_statement", "step_by_step_proof"],
      auditOptions: [25, 100],
    },
    trustTier: "llm_verified",
    difficultyLevels: ["intermediate", "expert"],
    usageCount: 0,
  },
];

/* ---------- helpers ---------- */

export function typesForDomain(types: DatasetType[], domain: DomainId): DatasetType[] {
  return types.filter((t) => t.domain === domain);
}

export function activeCodingTypes(types: DatasetType[]): DatasetType[] {
  return types.filter((t) => t.domain === "coding" && t.status === "active");
}

/** Render a type definition as the YAML the platform stores. */
export function typeToYaml(t: DatasetType): string {
  const lines: string[] = [
    `type: ${t.id}`,
    `version: ${t.version}`,
    `domain: ${t.domain}`,
    `name: "${t.name}"`,
    `status: ${t.status}`,
    `origin: ${t.origin}`,
    `trust_tier: ${t.trustTier}`,
    `schema:`,
  ];
  for (const f of t.fields) {
    lines.push(`  - field: ${f.key}`);
    lines.push(`    role: ${f.role}`);
    if (f.lang) lines.push(`    lang: ${f.lang}`);
    if (f.options) lines.push(`    options: [${f.options.join(", ")}]`);
    if (f.required) lines.push(`    required: true`);
  }
  lines.push(`verification:`);
  lines.push(`  pipeline: [${t.verification.pipeline.join(", ")}]`);
  if (t.verification.executionEnv)
    lines.push(`  execution_env: "${t.verification.executionEnv}"`);
  lines.push(`  dedupe_embed_fields: [${t.verification.dedupeFields.join(", ")}]`);
  lines.push(`  human_audit_options: [${t.verification.auditOptions.join(", ")}]`);
  lines.push(`difficulty_levels: [${t.difficultyLevels.join(", ")}]`);
  return lines.join("\n");
}
