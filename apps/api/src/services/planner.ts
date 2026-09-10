// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { llm } from "./llm/service.js";
import { getKarmaRuntimeSettings } from "./karma.js";
import { languageSupportFor } from "./execution.js";
import { normalizeLanguage } from "../lib/exec-languages.js";
import { BUNDLED_LICENSE_IDS, datasetLicense } from "../lib/publication/license-texts.js";
import { DatasetTypeOrigin, DatasetTypeStatus, TrustTier, type DatasetType } from "@prisma/client";

/**
 * Community "create a dataset request" planner — the real, database-driven
 * replacement for a hand-rolled chat script. This is the community-app
 * counterpart of v1's `services`/`lib/planner.ts` + `routes/v1/planner.ts`
 * (see databounty-api/src/routes/v1/planner.ts), adapted for a deployment
 * with NO bounties/wallet/payments/bonds/USDC: it produces a `DatasetRequest`
 * for admin review (`POST /v1/community/requests`'s own shape), never a
 * funded `Bounty`. There is deliberately no `deriveSlots`/`deriveBudget`
 * equivalent here — those compute a $ budget from platform fees, a concept
 * that does not exist in this deployment; karma pricing is fixed per
 * difficulty (`KARMA_RULES.acceptedItem`) and only ever finalized by an admin
 * at request-implement time (routes/v1/admin-community.ts `POST
 * /community/requests/:id/implement`), so the preview below is honestly
 * advisory, not a locked-in quote.
 */

/** The step keys the planner chat walks through, in order. Mirrors the
 * fields `POST /v1/community/requests` actually accepts (routes/v1/
 * community.ts `requestDatasetBody`) plus `title`, so a session's answers
 * map onto that endpoint's payload with no translation layer. */
export const PLANNER_STEPS = [
  { key: "category", label: "What kind of dataset?" },
  { key: "title", label: "Give it a title" },
  { key: "items", label: "How many items?" },
  { key: "difficulty", label: "Difficulty mix" },
  { key: "audit", label: "Validator audit coverage" },
  { key: "license", label: "License" },
  { key: "language", label: "Primary language" },
  { key: "framework", label: "Framework" },
] as const;

export type PlannerStepKey = (typeof PLANNER_STEPS)[number]["key"];
export const PLANNER_STEP_KEYS: readonly string[] = PLANNER_STEPS.map((s) => s.key);

/** The named difficulty presets, as a zod-usable tuple. Declared here as the
 * single source of truth: `answersSchema` below and `POST /v1/community/
 * requests`'s own `difficultyMix` field (routes/v1/community.ts) both build
 * their enum from it, and `resolvePoolDifficulty`
 * (routes/v1/admin-community.ts) recognises exactly these three. The route
 * used to accept a bare `z.string()`, so an unrecognised mix reached the
 * column and then silently resolved to `intermediate` at mint time. */
export const PLANNER_DIFFICULTY_MIXES = ["mostly_beginner", "balanced", "mostly_advanced"] as const;
export type PlannerDifficultyMix = (typeof PLANNER_DIFFICULTY_MIXES)[number];

/** Answers accumulated across planner turns. Every field is optional because
 * a session is a work-in-progress until `finalize` — the same reasoning as
 * v1's `PlannerAnswers` (routes/v1/planner.ts). `track` is deliberately NOT
 * modeled: this deployment has exactly one planner (community), so there is
 * no funded/community fork to record. */
export interface PlannerAnswers {
  category?: string;
  title?: string;
  targetItems?: number;
  difficultyMix?: PlannerDifficultyMix;
  auditCoveragePct?: number;
  proposedLicense?: string;
  language?: string;
  framework?: string;
  description?: string;
  step?: string;
  pathChoice?: "existing" | "fork" | "custom" | null;
  datasetTypeId?: string;
  datasetTypeName?: string;
  customForkedFrom?: { id: string; name: string } | null;
}

/** Same closed licence allowlist `POST /v1/community/requests` enforces
 * (routes/v1/community.ts `proposedLicenseField`), applied here because a
 * draft's answers are the OTHER door into `DatasetRequest.proposedLicense`:
 * finalize writes `answers.proposedLicense` straight onto the row
 * (routes/v1/planner.ts), so leaving this as a free string would have left the
 * unvalidated-licence hole open through the planner even after the request
 * route closed it. Validated on SAVE (both `POST /sessions/:id/answers` and
 * `PATCH /sessions/:id/answers/:step` parse through this schema) so a bogus
 * value can never be persisted into a draft in the first place, and
 * canonicalised to its SPDX spelling on the way in. */
const plannerLicense = z
  .string()
  .trim()
  .min(3)
  .max(60)
  .transform((raw, ctx) => {
    const canonical = datasetLicense(raw)?.spdx;
    if (!canonical) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unsupported licence. Choose one of: ${BUNDLED_LICENSE_IDS.join(", ")}.`,
      });
      return z.NEVER;
    }
    return canonical;
  });

/** `language`/`framework` are free text by design, but they are copied onto the
 * DatasetRequest at finalize and are projected publicly post-mint, so they get
 * the same control/bidi rejection and the same 60-char ceiling as the request
 * route's own fields — a draft must not be able to save a value that route
 * would refuse. */
const plannerFreeText = z
  .string()
  .trim()
  .max(60)
  .refine((v) => !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(v), {
    message: "Value must not contain control or bidirectional-override characters.",
  });

export const answersSchema = z.object({
  category: z.string().max(200).optional(),
  title: z.string().trim().min(5).max(120).optional(),
  targetItems: z.number().int().min(10).max(100_000).optional(),
  difficultyMix: z.enum(PLANNER_DIFFICULTY_MIXES).optional(),
  auditCoveragePct: z.number().int().min(0).max(100).optional(),
  proposedLicense: plannerLicense.optional(),
  language: plannerFreeText.optional(),
  framework: plannerFreeText.optional(),
  description: z.string().trim().min(20).max(2000).optional(),
  step: z.string().max(40).optional(),
  pathChoice: z.enum(["existing", "fork", "custom"]).nullable().optional(),
  datasetTypeId: z.string().max(200).optional(),
  datasetTypeName: z.string().max(200).optional(),
  customForkedFrom: z.object({ id: z.string().max(200), name: z.string().max(200) }).nullable().optional(),
});

export type TranscriptMsg = { role: "a" | "u"; text: string };

/** Resolve the DatasetType a session's answers point at. `category` may be a
 * live type id (the planner's real inputs) or, defensively, a stale/garbage
 * string — a miss just returns null rather than throwing. Mirrors v1's
 * `resolveType` (routes/v1/planner.ts) minus the legacy-category fallback,
 * which has no equivalent in this schema (DatasetType.category here is a
 * coarse filter facet, not a second identifier a session would carry). */
export async function resolveType(category?: string | null): Promise<DatasetType | null> {
  if (!category) return null;
  return prisma.datasetType.findUnique({ where: { id: category } });
}

export function isLaunchableType(type: DatasetType | null): type is DatasetType {
  return !!type && type.status === DatasetTypeStatus.active;
}

/** De-duplicate the planner chat transcript exactly like v1's
 * `normalizeTranscript` (routes/v1/planner.ts): drop an immediate exact
 * repeat, and collapse an accidental double-fire of the same (u, a) pair
 * that shows up as a 4-message echo. Per-turn autosaves race each other (the
 * client fires them without awaiting the response), so this is real
 * de-duplication, not paranoia. */
export function normalizeTranscript(transcript: TranscriptMsg[]): TranscriptMsg[] {
  return transcript.reduce<TranscriptMsg[]>((clean, msg) => {
    const previous = clean.at(-1);
    if (previous?.role === msg.role && previous.text === msg.text) return clean;

    clean.push(msg);

    const n = clean.length;
    const firstPairUser = clean[n - 4];
    const firstPairAssistant = clean[n - 3];
    const secondPairUser = clean[n - 2];
    const secondPairAssistant = clean[n - 1];
    if (
      n >= 4 &&
      firstPairUser &&
      firstPairAssistant &&
      secondPairUser &&
      secondPairAssistant &&
      firstPairUser.role === secondPairUser.role &&
      firstPairUser.text === secondPairUser.text &&
      firstPairAssistant.role === secondPairAssistant.role &&
      firstPairAssistant.text === secondPairAssistant.text
    ) {
      clean.splice(n - 2, 2);
    }

    return clean;
  }, []);
}

/** Validation the finalize step runs before it will produce a DatasetRequest
 * — the server-side backstop behind whatever the chat UI already checked.
 * Returns a list of human-readable problems; empty means ready to finalize.
 * Mirrors `requestDatasetBody`'s own bounds (routes/v1/community.ts) so a
 * session can never finalize into a payload that route would itself reject. */
/** Read `auditOptions` off a type's stored `verification` blob, falling back
 * to the same presets `requestDatasetBody`'s default sits inside. Duplicated
 * from the private copy in routes/v1/planner.ts because BOTH request-creation
 * doors need it now; that route keeps its own until someone consolidates. */
export function auditOptionsForType(verification: unknown): number[] {
  if (verification && typeof verification === "object" && !Array.isArray(verification)) {
    const opts = (verification as { auditOptions?: unknown }).auditOptions;
    if (Array.isArray(opts) && opts.every((n) => typeof n === "number")) return opts as number[];
  }
  // V1's ladder, verbatim: lib/planner.ts:329-332 calls [0, 25, 100] "the
  // standard 0/25/100 ladder". The [10, 25, 50, 100] that used to be here was
  // rebuild-invented drift, and it is what made a first version of the
  // coherence check below reject the create route's own default of 10.
  return [0, 25, 100];
}

/**
 * Coherence of an answer set against the dataset type it names — the check
 * neither request-creation door had.
 *
 * Types and bounds were already validated; what was missing is whether the
 * values make sense TOGETHER. A QA run minted a real request reading
 * `type=api_function_calling | language=Haskell | mix=mostly_advanced` while
 * its title described Python-to-TypeScript translation: that type declares
 * only `beginner`/`intermediate`, so `mostly_advanced` was a value the
 * planner's own chip filter could never have offered, and `Haskell` is not a
 * language its contract can verify — on a type whose trust tier is
 * `execution_verified`, which made that badge false.
 *
 * The UI now blocks all three client-side, but a direct
 * `POST /v1/community/requests` bypassed the UI entirely, so this is the
 * server-side backstop. Rules MIRROR the client deliberately — divergence
 * here reproduces the original class of bug from the other side:
 *
 *  - difficulty: `difficultyOptionsFor` in apps/web's planner, which accepts
 *    either spelling of the top tier (v1 page.tsx:1915) and always allows
 *    `balanced` because it maps to no single level.
 *  - language: `languageSupportFor` — the same resolver `/planner/catalog`
 *    serves, so UI and server cannot disagree about what a type permits.
 *
 * An empty `difficultyLevels` means the type constrains nothing, matching the
 * client's `levels.length === 0` branch — absence is not treated as a denial.
 */
/**
 * The template's own spelling of a language a caller supplied, or the trimmed
 * input when the template constrains nothing.
 *
 * Write-time canonicalisation, for the same reason `proposedLicenseField`
 * canonicalises a licence id: the stored value is served to anonymous callers
 * and grouped in listings. Without it `typescript`, `TypeScript` and
 * `TYPESCRIPT` become three distinct rows for one language — which is exactly
 * why `dedupeLanguagesByCase` exists in routes/v1/community.ts, a read-time
 * fold over the same problem. `coherenceProblems` has already established the
 * value IS permitted; this only fixes its casing.
 *
 * Returns the input unchanged for `any`/`none`/unresolved support, where there
 * is no contract spelling to fold onto — never a fabricated one. That
 * exception is why the read-time fold STAYS rather than being retired by this
 * function: on a template that constrains nothing, two casings of one language
 * are still a supported outcome. See that function's own comment for the
 * decision and the data behind it.
 *
 * Applied on every door onto a stored language: `POST`/`PATCH
 * /v1/community/requests` and planner finalize (routes/v1/planner.ts) for
 * `DatasetRequest.language`, and both admin mint routes
 * (routes/v1/admin-community.ts) for `Bounty.language` — the column the
 * community catalog's language filter is grouped from.
 */
/**
 * Whether `input` names the same language as one `languageSupportFor` permits
 * — not just the same spelling of it.
 *
 * The exact-match check alone (`id`/`label`, case-insensitive) is what a
 * sponsor typing the template's own casing satisfies. It is not what a
 * sponsor typing an ALIAS satisfies: `debugging`'s own field config stores
 * `lang: "ts"`, so `languageSupportFor` resolves that to
 * `{ id: "typescript", label: "TypeScript" }` — but a sponsor who ALSO types
 * `ts` was rejected, because `"ts"` is neither `"typescript"` nor
 * `"TypeScript"` case-insensitively. That is the asymmetry: the template's own
 * alias gets folded by `normalizeLanguage` inside `languageSupportFor`, but the
 * sponsor's identical input never gets the same treatment.
 *
 * Folding `input` through `normalizeLanguage` and comparing against `l.id`
 * closes that gap without loosening anything else: `l.id` is already the
 * canonical id when one exists (`languageSupportFor`'s own doc comment), so
 * this only matches when `input` resolves to the SAME canonical language the
 * template permits. A category spelling with no canonical id (`sh`, `regex`,
 * `sql`, `graphql`) makes `normalizeLanguage` return null for both sides, so
 * those keep relying on the exact-match branch exactly as before — this does
 * not invent a new mapping for them.
 */
function permittedLanguageMatch(
  input: string,
  languages: { id: string; label: string }[]
): { id: string; label: string } | null {
  const wanted = input.toLowerCase();
  const exact = languages.find((l) => l.id.toLowerCase() === wanted || l.label.toLowerCase() === wanted);
  if (exact) return exact;
  const normalizedInput = normalizeLanguage(input);
  if (!normalizedInput) return null;
  return languages.find((l) => l.id === normalizedInput) ?? null;
}

export function canonicalLanguageFor(type: DatasetType, language: string | null | undefined): string | null {
  const value = language?.trim();
  if (!value) return null;
  const support = languageSupportFor(type);
  if (support.mode !== "fixed" && support.mode !== "choice") return value;
  const match = permittedLanguageMatch(value, support.languages);
  return match ? match.label : value;
}

export function coherenceProblems(
  type: DatasetType,
  answers: { language?: string | null; difficultyMix?: string | null; auditCoveragePct?: number | null }
): string[] {
  const problems: string[] = [];

  const levels = type.difficultyLevels ?? [];
  if (answers.difficultyMix && levels.length > 0) {
    const needs =
      answers.difficultyMix === "mostly_beginner" ? "beginner"
      : answers.difficultyMix === "mostly_advanced" ? "expert"
      : null;
    const satisfied =
      needs === null ? true
      : needs === "expert" ? levels.includes("expert") || levels.includes("advanced")
      : levels.includes(needs);
    if (!satisfied) {
      problems.push(
        `"${answers.difficultyMix}" is not a difficulty mix this template offers — it declares ${levels.join(", ")}.`
      );
    }
  }

  const language = answers.language?.trim();
  if (language) {
    const support = languageSupportFor(type);
    if (support.mode === "fixed" || support.mode === "choice") {
      const permitted = permittedLanguageMatch(language, support.languages) !== null;
      if (!permitted) {
        problems.push(
          `"${language}" is not a language this template can verify — it permits ${support.languages
            .map((l) => l.label)
            .join(", ")}.`
        );
      }
    }
  }

  // NOTE — deliberately NOT enforcing membership of `auditOptions`.
  //
  // A first version of this function rejected any coverage value outside the
  // type's stored `auditOptions`, and it was wrong: it failed the server's
  // OWN default. `requestDatasetBody.auditCoveragePct` is `.default(10)`
  // (routes/v1/community.ts) while every active seeded type declares
  // `[0, 25, 100]`, so a request that merely omitted the field was rejected —
  // and 19 existing tests across 5 files, all posting the documented
  // `auditCoveragePct: 10`, failed.
  //
  // Two preset families exist in this codebase and disagree: the code
  // fallback `[10, 25, 50, 100]` in `auditOptionsForType`, whose comment
  // describes 10 as the preset the route default "sits inside of", and the
  // `[0, 25, 100]` actually seeded onto types. That predates this function.
  //
  // So `auditOptions` is the list a type OFFERS in the picker, not an
  // allowlist of permissible values; the real constraint is the 0-100 bound
  // `validateAnswers` and the zod schema already apply. Reconciling the two
  // families — and deciding which value should be seeded by default — is a
  // product decision, not a validation fix.
  //
  // Difficulty and language below ARE coherence, not presentation: a level a
  // type does not declare cannot be produced at all, and a language its
  // contract cannot verify makes an `execution_verified` badge false.

  return problems;
}

export function validateAnswers(type: DatasetType | null, answers: PlannerAnswers): string[] {
  const problems: string[] = [];
  if (!type) problems.push("Pick a dataset type first.");
  else if (!isLaunchableType(type)) problems.push("This dataset type is not open for new requests yet.");
  if (!answers.title || answers.title.trim().length < 5) problems.push("Give the request a title (at least 5 characters).");
  if (!answers.description || answers.description.trim().length < 20) problems.push("Describe the dataset in at least 20 characters.");
  if (!answers.targetItems || answers.targetItems < 10) problems.push("Target at least 10 items.");
  if (answers.auditCoveragePct != null && (answers.auditCoveragePct < 0 || answers.auditCoveragePct > 100)) {
    problems.push("Validator audit coverage must be between 0 and 100.");
  }
  // Coherence against the named type, not just bounds. `auditCoveragePct` is
  // genuinely optional on a session's answers, so a present value is one the
  // sponsor chose — unlike the create route, which defaults it.
  if (type) problems.push(...coherenceProblems(type, answers));
  return problems;
}

/** Karma-pricing preview for a not-yet-created request. Deliberately mirrors
 * `buildKarmaPreview` in routes/v1/admin-community.ts (same flat
 * KARMA_RULES.acceptedItem/auditItem scale, same intermediate fallback for an
 * unset/unrecognized difficulty mix) so a sponsor previewing a draft and an
 * admin reviewing the submitted request never see two different numbers for
 * the same inputs. Unlike that admin-only helper this reads the LIVE
 * admin-configurable rules (getKarmaRuntimeSettings) rather than the
 * `KARMA_RULES` code constant, since this is a pre-submit, no-auth-required
 * preview where staleness is a bigger cost than the extra read. The two are
 * NOT the same function only because this file cannot import from
 * routes/v1/admin-community.ts (that route's helper is a private closure,
 * not exported) — see the PR notes for the follow-up to extract a single
 * shared helper. */
export async function buildKarmaPreview(
  type: Pick<DatasetType, "id"> | null,
  answers: Pick<PlannerAnswers, "targetItems" | "difficultyMix" | "auditCoveragePct">
) {
  if (!type) return null;
  const { rules } = await getKarmaRuntimeSettings();
  const target = answers.targetItems ?? 0;
  const difficulty: keyof typeof rules.acceptedItem =
    answers.difficultyMix === "mostly_beginner"
      ? "beginner"
      : answers.difficultyMix === "mostly_advanced"
        ? "advanced"
        : "intermediate";
  const contributorPerItem = rules.acceptedItem[difficulty];
  const contributorTotal = contributorPerItem * target;
  const auditCoveragePct = answers.auditCoveragePct ?? 10;
  const plannedAuditItems = Math.round((target * auditCoveragePct) / 100);
  const validatorPerAuditedItem = rules.auditItem;
  const validatorTotal = plannedAuditItems * validatorPerAuditedItem;
  return {
    difficulty,
    contributorPerItem,
    contributorTotal,
    plannedAuditItems,
    validatorPerAuditedItem,
    validatorTotal,
  };
}

/* ------------------------------------------------------------------------ *
 * POST /dataset-types/requests — sponsor-proposed NEW dataset type. Distinct
 * from a DatasetRequest (which asks for an INSTANCE of an existing type):
 * this persists a brand-new, sponsor-authored DatasetType row in
 * platform_review, exactly the pattern admin-owned types already use
 * (origin/status/forkedFromId/authorUserId columns all pre-exist on
 * DatasetType — see prisma/schema.prisma — no schema change needed). Ported
 * from v1's routes/v1/planner.ts `/dataset-types/requests`, minus the
 * LLM-drafting helpers (`draftCustomDatasetType`/`guessSponsorFields` there
 * import from `services/llm/consumers/*`, which does not exist in this repo
 * — see the dataset-type-draft `/assist` intent note in routes/v1/planner.ts
 * for why that intent is not ported). The deterministic field-guessing
 * fallback below is kept, self-contained, since it needs no LLM.
 * ------------------------------------------------------------------------ */

export const sponsorTypeFieldSchema = z.object({
  key: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(160),
  role: z.string().trim().min(1).max(60),
  required: z.boolean().default(true),
});
export type SponsorTypeField = z.infer<typeof sponsorTypeFieldSchema>;

export function slugifyId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 72) || "custom_type"
  );
}

function fieldKey(value: string): string {
  return slugifyId(value).slice(0, 64) || "field";
}

/** Deterministic field-guessing fallback for a proposed type with no fields
 * supplied — no LLM call, so drafting a custom type is never blocked on one
 * being configured. Mirrors v1's `guessSponsorFields` shape. */
export function guessSponsorFields(description: string): SponsorTypeField[] {
  const parts = description
    .split(/,|\n|;/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 12);
  const labels = parts.length >= 2 ? parts : ["Instruction", "Input context", "Expected output", "Rationale"];
  const roles = ["instruction", "input_context", "expected_output", "rationale"] as const;
  const used = new Set<string>();

  return labels.map((label, i) => {
    let key = fieldKey(label);
    while (used.has(key)) key = `${key}_2`.slice(0, 80);
    used.add(key);
    return {
      key,
      label: label.charAt(0).toUpperCase() + label.slice(1),
      role: roles[Math.min(i, roles.length - 1)] ?? "rationale",
      required: true,
    };
  });
}

export async function uniqueDatasetTypeId(base: string): Promise<string> {
  const root = slugifyId(base);
  for (let i = 0; i < 50; i++) {
    const id = i === 0 ? root : `${root}_${i + 1}`;
    const exists = await prisma.datasetType.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return id;
  }
  return `${root}_${Date.now()}`;
}

/** Contract-integrity check for a sponsor-proposed dataset type — imported
 * from routes/v1/admin-dataset-types.ts (`contractIntegrityError`), NOT
 * redefined here. This file used to carry its own lightweight, laxer
 * duplicate of that check (no schema-then-dedupe ordering rule, no
 * human_audit-last rule, no "at least one quality/human gate" rule, and a
 * 6-stage allowlist missing `ai_attribution`), which let a sponsor-proposed
 * type pass this check, get written to the DB, and only later fail the
 * admin route's stricter check when an admin tried to activate it. Both
 * entry points now call the exact same function so a type that can be
 * proposed can also be activated. See routes/v1/planner.ts for the call
 * site. */

/* ------------------------------------------------------------------------ *
 * POST /assist { intent: "title" }. v1's other three intents
 * (`planner_copy`, `draft_type`, `validate_field`) are now ported too and
 * live in `services/llm/consumers/*`; this one goes through the same layer,
 * as the registered `suggest` feature, so an admin routing/prompt override
 * made on the console's /llm page actually applies to it. It used to hold
 * its own direct `fetch` to OpenRouter, which meant the console described a
 * `suggest` feature whose config nothing read.
 *
 * The public contract is unchanged: `{ titles, source }` with
 * `source: "fallback"` whenever no live model answered, and the same
 * deterministic titles as before on that path — the planner is never
 * blocked on an LLM call, and a fallback is never labelled as an LLM result.
 * ------------------------------------------------------------------------ */

export interface TitleSuggestion {
  titles: string[];
  source: "llm" | "fallback";
}

const titlesSchema = z.object({ titles: z.array(z.string().trim().min(3).max(120)).min(1).max(5) });

export function fallbackTitles(typeName: string, brief?: string): string[] {
  const trimmedBrief = brief?.trim();
  const base = trimmedBrief ? `${typeName}: ${trimmedBrief.slice(0, 60)}` : `${typeName} contribution pool`;
  return [base, `${typeName} — community dataset request`, `Help build a ${typeName} dataset`].map((t) => t.slice(0, 120));
}

/** Real working-title suggestions for a proposed community request, scoped to
 * one dataset type + optional free-text brief. Routed through
 * `services/llm/` as the `suggest` feature, which guarantees no-throw and
 * hands back the deterministic fallback below on ANY failure (no key, network
 * error, bad response shape, budget/rate block). */
export async function suggestRequestTitles(
  type: Pick<DatasetType, "name"> & { id?: string; version?: number; domain?: string | null; description?: string | null },
  opts: { brief?: string; userId?: string; accountId?: string }
): Promise<TitleSuggestion> {
  const brief = opts.brief?.trim();
  const res = await llm.complete({
    feature: "suggest",
    userId: opts.userId,
    accountId: opts.accountId,
    idempotencyKey: `suggest-title:v1:${type.id ?? type.name}:${type.version ?? 0}:${brief ?? "none"}`,
    schema: titlesSchema,
    // No system message: the service injects the admin-editable system prompt
    // for the "suggest" feature. The consumer supplies only the data.
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          dataset_type: type.name,
          domain: type.domain ?? null,
          what_it_is: type.description ?? null,
          brief: brief ?? null,
        }),
      },
    ],
    fallback: { titles: fallbackTitles(type.name, brief) },
  });
  return { titles: res.data.titles.slice(0, 5), source: res.fallbackUsed ? "fallback" : "llm" };
}

/* ------------------------------------------------------------------------ *
 * Finalize — turn a PlannerSession's answers into a real DatasetRequest,
 * exactly as `POST /v1/community/requests` would (routes/v1/community.ts
 * `requestDatasetBody` + `prisma.datasetRequest.create`). That creation
 * logic is a private route-handler closure, not an exported service
 * function, and routes/v1/community.ts is out of this change's scope (owned
 * by other concurrent work), so it cannot be extracted and imported here —
 * this mirrors the same field list and defaults instead. Flagged as a
 * follow-up: extract a shared `createDatasetRequest()` service so the two
 * call sites cannot drift.
 * ------------------------------------------------------------------------ */

export interface FinalizeInput {
  requesterUserId: string;
  answers: PlannerAnswers;
  /** Stable per-session idempotency key, independent of what the client
   * sends, so retrying finalize on the same session can never create two
   * DatasetRequest rows even if the PlannerSession-level idempotency guard
   * (session.completed / session.createdBounty) is somehow bypassed — the
   * DB's own `@@unique([requesterUserId, idempotencyKey])` constraint is the
   * backstop. */
  sessionId: string;
}

const DEFAULT_LICENSE = "CC-BY-4.0";
const DEFAULT_AUDIT_COVERAGE_PCT = 10;

export function finalizeIdempotencyKey(sessionId: string): string {
  return `planner_session_${sessionId}`;
}

export async function createDatasetRequestFromAnswers(input: FinalizeInput) {
  const { requesterUserId, answers } = input;
  const type = await resolveType(answers.category ?? answers.datasetTypeId);

  return prisma.datasetRequest.create({
    data: {
      requesterUserId,
      title: (answers.title ?? "").trim(),
      description: (answers.description ?? "").trim(),
      datasetTypeId: type?.id,
      domain: type?.domain,
      proposedLicense: answers.proposedLicense?.trim() || DEFAULT_LICENSE,
      // Canonicalised exactly as `POST /v1/community/requests` does, for the
      // same reason `proposedLicense` above is: finalize is the second door
      // onto this column, and a draft's `answers.language` is whatever the
      // client last autosaved. `validateAnswers` (→ `coherenceProblems`) has
      // already run in the finalize route before this is called, so the value
      // is known to be one the template permits; this only fixes its casing.
      // `type` is nullable here (`resolveType` returns null for an unknown or
      // absent category), and with no template there is no spelling to fold
      // onto — the answer is stored as given rather than guessed at.
      language: type ? canonicalLanguageFor(type, answers.language) : answers.language,
      framework: answers.framework,
      targetItems: answers.targetItems,
      difficultyMix: answers.difficultyMix,
      auditCoveragePct: answers.auditCoveragePct ?? DEFAULT_AUDIT_COVERAGE_PCT,
      idempotencyKey: finalizeIdempotencyKey(input.sessionId),
    },
  });
}

/** Only used to build a stable hash for the draft-generation audit log
 * entry, mirroring v1's pattern (routes/v1/planner.ts) — kept here rather
 * than inlined so the two call sites (route handler) share one definition. */
export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export { DatasetTypeOrigin, TrustTier };
