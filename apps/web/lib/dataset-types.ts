// SPDX-License-Identifier: Apache-2.0

import type { DatasetCategory } from "./types";

export type DomainId = "coding" | "legal" | "healthcare" | "finance" | "science";

export interface Domain {
  id: DomainId;
  name: string;
  status: "live" | "coming_soon";
  tagline: string;
  expertPitch: string;
  waitlistCount: number;
}

export const DOMAINS: Domain[] = [
  {
    id: "coding",
    name: "Coding",
    status: "live",
    tagline: "Debugging, implementation, tests, SQL, regex — execution-verified where possible.",
    expertPitch: "Software engineers earn karma per accepted item across 11 dataset types.",
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

export type FieldRole =
  | "instruction"
  | "input_context"
  | "input_code"
  | "solution_code"
  | "tests"
  | "expected_output"
  | "rationale"
  | "enum"
  | "list"
  | "reference"
  | "file";

export interface TypeField {
  key: string;
  label: string;
  role: FieldRole;
  lang?: string;
  options?: string[];
  required?: boolean;
  help?: string;
  accept?: string;
  minCount?: number;
  maxCount?: number;
  maxSizeBytes?: number;
}

export type VerificationCheck =
  | "dedupe"
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

export interface DatasetTypeSample {
  fields?: Record<string, string>;
  media?: { key: string; url: string; kind: "image" | "audio" | "video" | "file"; alt?: string }[];
  caption?: string;
}

export interface DatasetType {
  id: string;
  version: number;
  domain: DomainId;
  name: string;
  description: string;
  status: TypeStatus;
  origin: "platform" | "sponsor";
  category: DatasetCategory;
  fields: TypeField[];
  verification: {
    pipeline: VerificationCheck[];
    executionEnv?: string;
    dedupeFields: string[];
    auditOptions: number[];
  };
  trustTier: TrustTier;
  languageSupport?: {
    mode: "fixed" | "choice" | "any" | "none";
    languages: { id: string; label: string; status: "verified" | "unverifiable"; reason?: string }[];
  };
  difficultyLevels: string[];
  usageCount: number;
  sampleAssets?: DatasetTypeSample[] | null;
}

export const DATASET_TYPE_CATALOG: DatasetType[] = [
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
    difficultyLevels: ["beginner", "intermediate", "expert"],
    usageCount: 142,
  },
  {
    id: "implementation",
    version: 2,
    domain: "coding",
    name: "Function / Feature Implementation",
    description: "Write working, tested code against a specification or starter interface.",
    status: "active",
    origin: "platform",
    category: "implementation",
    fields: [
      { key: "prompt", label: "Specification", role: "instruction", required: true },
      { key: "starter_code", label: "Starter code / Signature", role: "input_code", lang: "ts" },
      { key: "solution_code", label: "Implementation", role: "solution_code", lang: "ts", required: true },
      { key: "tests", label: "Tests", role: "tests", lang: "ts", required: true },
      { key: "explanation", label: "Implementation rationale", role: "rationale" },
    ],
    verification: {
      pipeline: ["dedupe", "execution", "llm", "human_audit"],
      executionEnv: "node:20 / python:3.11",
      dedupeFields: ["prompt", "solution_code"],
      auditOptions: [0, 25, 100],
    },
    trustTier: "execution_verified",
    difficultyLevels: ["beginner", "intermediate", "expert"],
    usageCount: 87,
  },
  {
    id: "test_generation",
    version: 2,
    domain: "coding",
    name: "Test Generation",
    description: "Produce comprehensive unit and edge-case tests for working code.",
    status: "active",
    origin: "platform",
    category: "test_generation",
    fields: [
      { key: "prompt", label: "Test requirement", role: "instruction", required: true },
      { key: "source_code", label: "Source code to test", role: "input_code", lang: "ts", required: true },
      { key: "test_code", label: "Generated tests", role: "tests", lang: "ts", required: true },
      { key: "test_rationale", label: "Edge-case coverage notes", role: "rationale" },
    ],
    verification: {
      pipeline: ["dedupe", "execution", "llm", "human_audit"],
      executionEnv: "node:20 / python:3.11",
      dedupeFields: ["source_code", "test_code"],
      auditOptions: [0, 25, 100],
    },
    trustTier: "execution_verified",
    difficultyLevels: ["beginner", "intermediate", "expert"],
    usageCount: 64,
  },
  {
    id: "error_diagnosis",
    version: 1,
    domain: "coding",
    name: "Error Diagnosis & Root Cause",
    description: "Given a stack trace, build log, or runtime failure, identify the root cause and provide the fix.",
    status: "active",
    origin: "platform",
    category: "error_diagnosis",
    fields: [
      { key: "prompt", label: "Failure scenario", role: "instruction", required: true },
      { key: "stack_trace", label: "Error log / Stack trace", role: "input_context", required: true },
      { key: "root_cause_analysis", label: "Root cause analysis", role: "rationale", required: true },
      { key: "suggested_fix", label: "Fix code", role: "solution_code", lang: "ts" },
    ],
    verification: {
      pipeline: ["dedupe", "llm", "human_audit"],
      dedupeFields: ["stack_trace", "root_cause_analysis"],
      auditOptions: [0, 25, 100],
    },
    trustTier: "llm_verified",
    difficultyLevels: ["beginner", "intermediate", "expert"],
    usageCount: 43,
  },
  {
    id: "migration",
    version: 1,
    domain: "coding",
    name: "Migration / Refactor Pairs",
    description: "Convert code between library versions, API generations, or idioms while preserving exact behavior.",
    status: "active",
    origin: "platform",
    category: "migration",
    fields: [
      { key: "prompt", label: "Migration intent", role: "instruction", required: true },
      { key: "source_code", label: "Legacy code", role: "input_code", lang: "ts", required: true },
      { key: "migrated_code", label: "Migrated code", role: "solution_code", lang: "ts", required: true },
      { key: "tests", label: "Behavior-preserving tests", role: "tests", lang: "ts" },
    ],
    verification: {
      pipeline: ["dedupe", "execution", "llm", "human_audit"],
      executionEnv: "node:20 / python:3.11",
      dedupeFields: ["source_code", "migrated_code"],
      auditOptions: [0, 25, 100],
    },
    trustTier: "execution_verified",
    difficultyLevels: ["intermediate", "expert"],
    usageCount: 31,
  },
];

export function typesForDomain(types: DatasetType[], domain: DomainId): DatasetType[] {
  return types.filter((t) => t.domain === domain);
}

export function activeCodingTypes(types: DatasetType[]): DatasetType[] {
  return types.filter((t) => t.domain === "coding" && t.status === "active");
}

export function pipelineWithPlatformStages(pipeline: string[], opts?: { llmEnabled?: boolean }): string[] {
  // "schema" is a config-shape artifact some stored dataset-type contracts
  // still carry (the admin API requires every pipeline to start with it),
  // but `services/validation.ts` never writes a ValidationResult for it —
  // it must never reach display or it renders as a stage that can never
  // resolve. Strip it before augmenting/deduping, regardless of source.
  // `contamination` is a stale catalog value in a few historical contracts.
  // External-corpus screening is not implemented and the API rejects it for
  // new/edited types, so it must never reach a contributor-facing preview as
  // though it were a real check. Dedupe is the live duplicate-identity stage.
  const withoutNonRuntimeStages = pipeline.filter((stage) => stage !== "schema" && stage !== "contamination");
  const dedupeIndex = withoutNonRuntimeStages.indexOf("dedupe");
  const insertAt = dedupeIndex >= 0 ? dedupeIndex + 1 : 0;
  const withAttribution = withoutNonRuntimeStages.includes("ai_attribution")
    ? withoutNonRuntimeStages
    : [...withoutNonRuntimeStages.slice(0, insertAt), "ai_attribution", ...withoutNonRuntimeStages.slice(insertAt)];
  const stages = opts?.llmEnabled === false ? withAttribution.filter((s) => s !== "llm") : withAttribution;
  return [...new Set(stages)];
}

const STAGE_LABELS: Record<string, string> = {
  dedupe: "Dedupe",
  ai_attribution: "AI attribution",
  execution: "Execution",
  llm: "LLM review",
  human_audit: "Validator audit",
};

export function stageLabel(stage: string): string {
  const known = STAGE_LABELS[stage];
  if (known) return known;
  const words = stage.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What a reference sample for one template may actually be.
 *
 * MUST mirror the server rule in `apps/api/src/services/artifacts.ts`
 * (`fileFieldAccepts(datasetType.fields)` at :706, applied at :771-789, falling
 * back to `.json,.jsonl,.ndjson` for a resolved type that declares no
 * file-role field): a template whose contract has file fields takes those file
 * types; a structured template normalizes its examples through JSON/JSONL only.
 *
 * Ported from v1 `sponsor/create/page.tsx:1091-1095` — read its comment, which
 * records this exact bug being reported and fixed once already there. The
 * pickers here were hardcoded to `.json,.jsonl,.ndjson,.csv,.tsv,.txt,.md`,
 * which the server rejects for every structured template: the sponsor picked a
 * `.csv` the UI had offered, the upload slot came back 400, and the message was
 * a lowercase fragment naming neither the file nor the permitted set. Deriving
 * it means a new modality needs no change here, and a picker can never offer
 * something the server will refuse.
 *
 * A file-role field with no `accept` of its own is skipped rather than widened
 * to "any file" — that is exactly what the server's `fileFieldAccepts` does
 * (it requires `typeof accept === "string"`), so the two agree on the fallback.
 */
export function sampleAccept(type: DatasetType | null | undefined): { accept: string; label: string } {
  const declared = (type?.fields ?? [])
    .filter((f) => f.role === "file" && typeof f.accept === "string" && f.accept.trim().length > 0)
    .flatMap((f) => f.accept!.split(",").map((part) => part.trim()))
    .filter(Boolean);
  if (declared.length > 0) {
    const merged = [...new Set(declared)];
    return { accept: merged.join(","), label: merged.join(", ") };
  }
  return { accept: ".json,.jsonl,.ndjson", label: "JSON or JSONL" };
}

/**
 * Why this file cannot be a reference sample under `accept`, or null.
 *
 * The picker's `accept` attribute constrains the browser's own file dialog and
 * nothing else — a drag-drop, a paste, or a dialog switched to "All files"
 * walks straight past it. Checking here means the sponsor is told which file
 * and which types are permitted before any bytes move, instead of reading the
 * server's declaration error, which names neither.
 *
 * Extension-first on purpose: the contract the server enforces is written in
 * extensions, and `File.type` is empty for `.jsonl`/`.ndjson` in every browser
 * measured. An empty accept, or a wildcard entry, means "not constrained on
 * this side" and passes — this must never guess a rule narrower than the
 * server's, or it would block an upload the server would have taken.
 */
export function sampleAcceptViolation(file: File, accept: string, acceptLabel: string): string | null {
  const parts = accept.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0 || parts.includes("*") || parts.includes("*/*")) return null;
  const name = file.name.toLowerCase();
  const mime = (file.type || "").toLowerCase();
  const allowed = parts.some((part) => {
    if (part.startsWith(".")) return name.endsWith(part);
    if (part.endsWith("/*")) return mime.startsWith(part.slice(0, -1));
    return mime !== "" && mime === part;
  });
  if (allowed) return null;
  return `${file.name} isn't a file type this template accepts. Attach ${acceptLabel} instead.`;
}
