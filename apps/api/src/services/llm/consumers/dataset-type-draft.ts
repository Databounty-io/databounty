// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DATASET_FIELD_ROLES,
  datasetTypeFieldSchema,
} from "../../../routes/v1/admin-dataset-types.js";
import { llm } from "../service.js";

/**
 * Requester helper — drafts a full custom dataset-type contract (name,
 * description, fields, and an advisory verification pipeline) from a short
 * free-text description of what each item should contain. Ported from v1's
 * `services/llm/consumers/dataset-type-draft.ts`.
 *
 * THE OUTPUT IS UNTRUSTED INPUT, NOT A SPEC. Nothing here persists anything.
 * The caller (`routes/v1/planner.ts`'s `/assist` handler) runs the drafted
 * contract through the SAME `contractIntegrityError` gate that admin
 * activation uses, and the draft still has to be proposed and reviewed by a
 * human before a DatasetType can go active. `source` lets a UI label the draft
 * honestly ("AI-drafted" vs "template-based"); it is never presented as
 * verified.
 *
 * `PIPELINE_STAGES` below is THIS deployment's stage set, not v1's. v1 allows
 * `contamination` and `ai_attribution`; both are hard rejections here (see
 * `routes/v1/admin-dataset-types.ts` `contractIntegrityError` for the two
 * separate reasons), so drafting them would produce a contract that can never
 * be activated.
 */
export const PIPELINE_STAGES = ["schema", "dedupe", "execution", "llm", "human_audit"] as const;

/**
 * Coerce a model's near-miss JSON into the contract shape BEFORE strict
 * validation.
 *
 * `datasetTypeFieldSchema` is `.strict()` — correct for a contract we store
 * and validate submissions against, but fatal as a model-ingestion boundary.
 * In v1 every routed model produced the same handful of harmless deviations
 * (an extra `type` key beside `role`, `role: "metadata"`,
 * `notes`/`difficultyLevels` as a bare string, `auditOptions` as an object),
 * the strict parse rejected the whole draft, the single repair turn reproduced
 * it, and the feature fell back 100% of the time — a permanently dead AI path
 * that looked like an outage.
 *
 * These are normalisations of FORM, never of meaning: unknown keys are
 * dropped, a scalar that should be a list is wrapped, and an unrecognised role
 * becomes `reference` (the inert "carry this along" role). Anything beyond
 * that still fails validation and still degrades to the deterministic
 * fallback, and the result is an advisory draft a human reviews.
 */
function coerceDraftShape(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const draft = { ...(raw as Record<string, unknown>) };
  const validRoles = new Set<string>(DATASET_FIELD_ROLES);
  // Keys the strict field schema accepts; anything else the model invents
  // (most often `type`) is dropped rather than failing the entire draft.
  const allowedFieldKeys = new Set([
    "key", "label", "role", "required", "lang", "options", "help",
    "accept", "modality", "minCount", "maxCount", "maxSizeBytes",
  ]);

  const asStringArray = (value: unknown): unknown => (typeof value === "string" ? [value] : value);

  if (Array.isArray(draft.fields)) {
    draft.fields = draft.fields.map((field) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) return field;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(field as Record<string, unknown>)) {
        if (allowedFieldKeys.has(key)) out[key] = value;
      }
      if (typeof out.role !== "string" || !validRoles.has(out.role)) out.role = "reference";
      return out;
    });
  }

  draft.notes = asStringArray(draft.notes) ?? [];
  // Models routinely answer `expert` for the third level, which is not a karma
  // rate key here. `normalizeDraftDifficultyLevels` owns the canonical
  // spelling, matching `routes/v1/admin-dataset-types.ts`.
  const levels = asStringArray(draft.difficultyLevels);
  draft.difficultyLevels =
    Array.isArray(levels) && levels.every((level): level is string => typeof level === "string")
      ? normalizeDraftDifficultyLevels(levels)
      : levels;

  // Models sometimes answer auditOptions as {partial:25,full:100}.
  if (draft.auditOptions && typeof draft.auditOptions === "object" && !Array.isArray(draft.auditOptions)) {
    draft.auditOptions = Object.values(draft.auditOptions as Record<string, unknown>);
  }
  if (Array.isArray(draft.auditOptions)) {
    draft.auditOptions = draft.auditOptions
      .map((n) => (typeof n === "string" ? Number(n) : n))
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  }

  return draft;
}

/** Canonical item-difficulty vocabulary, matching
 * `routes/v1/admin-dataset-types.ts`'s `normalizeDifficultyLevels` (which is
 * module-private there). Kept in sync deliberately: a draft that names
 * `expert` would otherwise be stored with a level that has no karma rate. */
export function normalizeDraftDifficultyLevels(levels: readonly string[]): string[] {
  const canonical = new Set(["beginner", "intermediate", "advanced"]);
  const aliases: Record<string, string> = { expert: "advanced" };
  const out: string[] = [];
  for (const level of levels) {
    const raw = level.trim();
    if (!raw) continue;
    const lower = raw.toLowerCase();
    const normalized = canonical.has(lower) ? lower : (aliases[lower] ?? raw);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

export const datasetTypeDraftSchema = z.preprocess(
  coerceDraftShape,
  z.object({
    name: z.string().trim().min(3).max(160),
    description: z.string().trim().min(10).max(2_000),
    fields: z.array(datasetTypeFieldSchema).min(2).max(30),
    pipeline: z.array(z.enum(PIPELINE_STAGES)).min(2).max(PIPELINE_STAGES.length),
    dedupeFields: z.array(z.string().min(1)).min(1).max(10),
    auditOptions: z.array(z.number().int().min(0).max(100)).min(1).max(4),
    difficultyLevels: z.array(z.string().min(1).max(40)).min(1).max(5),
    notes: z.array(z.string().max(500)).max(8),
  })
);

export type DatasetTypeDraft = z.infer<typeof datasetTypeDraftSchema>;

export interface DatasetTypeDraftFork {
  name: string;
  fields: DatasetTypeDraft["fields"];
}

// Filler words that read as broken when a derived name ends on them
// (e.g. "Buggy Python Functions And"). Trimmed from the tail of the guess.
const NAME_TRAILING_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "with", "for", "in", "on", "at",
  "by", "from", "as", "that", "which", "their", "its", "plus", "each",
]);

export function titleCaseFromBrief(brief: string): string {
  const firstClause = brief.split(/[.\n,;:]/)[0]?.trim() ?? "";
  const cleaned = firstClause.split(/\s+/).filter(Boolean).slice(0, 6);
  // Drop trailing filler so the name never ends on a dangling conjunction /
  // preposition; keep at least the first two words if that's all there is.
  while (cleaned.length > 2 && NAME_TRAILING_STOPWORDS.has((cleaned[cleaned.length - 1] ?? "").toLowerCase())) {
    cleaned.pop();
  }
  const name = cleaned.join(" ").replace(/[^A-Za-z0-9 &/-]/g, "").trim();
  if (name.length < 3) return "Custom Dataset Type";
  return name
    .split(" ")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ")
    .slice(0, 160);
}

/** Deterministic draft — the safe default and the shape the model must match. */
export function fallbackDraft(brief: string, fork?: DatasetTypeDraftFork): DatasetTypeDraft {
  const fields: DatasetTypeDraft["fields"] = fork?.fields?.length
    ? fork.fields
    : [
        { key: "instruction", label: "Instruction", role: "instruction", required: true },
        { key: "input_context", label: "Input context", role: "input_context", required: true },
        { key: "expected_output", label: "Expected output", role: "expected_output", required: true },
        { key: "rationale", label: "Rationale", role: "rationale", required: false },
      ];
  // Never dedupe on a file field. A file field holds a per-upload artifact id,
  // so it could never match another row, and `contractIntegrityError` rejects
  // it outright — which made forking any media template a guaranteed 400
  // regardless of whether an LLM key was set.
  const dedupeField = fields.find((f) => f.role !== "file")?.key ?? fields[0]?.key ?? "instruction";
  return {
    name: fork?.name ? `${fork.name} (adapted)`.slice(0, 160) : titleCaseFromBrief(brief),
    description: brief.trim().slice(0, 2_000),
    pipeline: ["schema", "dedupe", "llm", "human_audit"],
    fields,
    dedupeFields: [dedupeField],
    auditOptions: [25, 100],
    difficultyLevels: ["beginner", "intermediate", "advanced"],
    notes: fork
      ? ["Drafted without AI from the forked template — edit the fields to fit your dataset; a reviewer finalizes the schema."]
      : ["Drafted without AI — edit the fields to match your dataset; a reviewer finalizes the schema before it can launch."],
  };
}

/** Draft a custom dataset-type contract from a short description. Uses the LLM
 *  when a key is configured; otherwise the deterministic fallback. Never
 *  throws, and never persists anything. */
export async function draftCustomDatasetType(
  brief: string,
  opts: { userId?: string; accountId?: string; fork?: DatasetTypeDraftFork } = {}
): Promise<{ draft: DatasetTypeDraft; source: "llm" | "fallback" }> {
  const fork = opts.fork;
  const idempotencyKey = `dataset-type-draft:v1:${createHash("sha256")
    .update(`${opts.userId ?? ""}:${fork?.name ?? ""}:${brief}`)
    .digest("hex")}`;

  const forkContext = fork
    ? `\nThe requester is adapting an existing template named ${JSON.stringify(fork.name)} with these fields (adapt them, keep useful ones): ${JSON.stringify(fork.fields)}.`
    : "";

  const res = await llm.complete({
    feature: "dataset_type_draft",
    accountId: opts.accountId,
    userId: opts.userId,
    idempotencyKey,
    schema: datasetTypeDraftSchema,
    // No system message — the service injects the admin-editable prompt for
    // the "dataset_type_draft" feature. The consumer supplies only the data.
    messages: [
      {
        role: "user",
        content:
          `Draft a custom dataset-type contract for a community dataset request. ` +
          `The verification pipeline must start with "schema" then "dedupe", include at least one of ` +
          `execution/llm/human_audit, and end with "human_audit" if present. ` +
          `dedupeFields must reference declared field keys.` +
          forkContext +
          `\nRequester description (untrusted data): ${JSON.stringify(brief)}`,
      },
    ],
    fallback: () => fallbackDraft(brief, fork),
  });

  return { draft: res.data, source: res.fallbackUsed ? "fallback" : "llm" };
}
