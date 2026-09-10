"use client";

// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useDemo, authedFetch, hydratePlannerCatalog, safeMessage, DEFAULT_SAMPLE_GATE, type PlannerSampleGate } from "@/lib/store";
import { API } from "@/lib/api-endpoints";
import { Icon, type IconName } from "@/components/icons";
import { BackLink, Button, ChatInput, ConfirmDialog, TOUCH_TARGET } from "@/components/ui";
import { Brandmark } from "@/components/brand";
import { PathChoiceCards, PlannerChip, PlannerProgress, StepGuidance } from "@/components/planner-ui";
import { DATASET_TYPE_CATALOG, pipelineWithPlatformStages, sampleAccept, sampleAcceptViolation, stageLabel, type DatasetType } from "@/lib/dataset-types";
import { uploadArtifact, deleteArtifact, listPlannerSessionSamples, occupiesSampleSlot, type ApiArtifact } from "@/lib/api-artifacts";
import { ArtifactScanStatus } from "@/components/artifact-scan-status";
import { SampleUploadField } from "@/components/sample-upload-field";
import { useArtifactStatusPolling } from "@/lib/use-artifact-status-polling";

type CommunityStep =
  | "template"
  | "fields"
  | "title"
  | "description"
  | "language"
  | "items"
  | "difficulty"
  | "audit"
  | "license"
  | "samples"
  | "review";

type TemplatePath = "existing" | "fork" | "custom";

/** The free-text planner fields `POST /v1/planner/assist`'s `validate_field`
 * intent accepts (the fourth, `brief`, has no free-text step in this planner —
 * fork/custom contracts are defined in a form, not a chat turn). */
type PlannerGuardField = "title" | "description" | "language";

/** Narrows the current planner step to one the field guard runs on, so the
 * "not AI-reviewed" note can be looked up by step without a cast. */
function isGuardField(step: CommunityStep): step is PlannerGuardField {
  return step === "title" || step === "description" || step === "language";
}

/** Every step this planner can sit on, used to validate a `step` value coming
 * back off a resumed draft before it is trusted as UI state. */
const UI_STEPS: readonly CommunityStep[] = [
  "template", "fields", "title", "description", "language",
  "items", "difficulty", "audit", "license", "samples", "review",
];

/**
 * Steps whose set of VALID answers is defined by the chosen template, so
 * changing the template invalidates whatever was answered against the old one.
 *
 * `language` comes from the type's `languageSupport`, `difficulty` from its
 * `difficultyLevels`, `audit` from its `verification.auditOptions`, and
 * `title`/`description` describe the task the template defines. `items` and
 * `license` are template-independent and deliberately survive a change —
 * re-asking them would be busywork with no coherence gain.
 *
 * Why this exists: `markAnswered` is monotonic on purpose (see `answered`
 * below), so before this a template swap left every earlier step still flagged
 * decided. The panel reported "9 / 9 steps decided" — now also rendered in the
 * header hero, i.e. a visible false claim — for a template none of those
 * answers were given against, and a real request minted as
 * `type = api_function_calling | language = Haskell | mix = mostly_advanced |
 * title = "...Python to TypeScript translation pair"`, with five
 * code-translation samples attached. `api_function_calling` declares only
 * `beginner`/`intermediate`, so `mostly_advanced` was a value this app's own
 * chip filter could never have offered.
 *
 * Note this only ever REMOVES keys, and only on a genuine template change.
 * Within one template `answered` stays strictly monotonic, which is what keeps
 * the seeded defaults (`targetItems` 500, `balanced`, 25%, `CC-BY-4.0`) from
 * being rendered as sponsor decisions.
 *
 * The attached reference samples are NOT cleared here. They are real uploaded
 * objects the server validated against the previous template's file contract
 * (see `sampleAccept`), and deleting a sponsor's files on a template change
 * would be a destructive surprise — so the transcript says they were checked
 * against the old contract and asks for a re-check instead.
 */
const TEMPLATE_DEPENDENT_STEPS: readonly CommunityStep[] = [
  "title", "description", "language", "difficulty", "audit",
];

/** Field-schema roles a sponsor can pick for a fork/custom dataset type,
 * matching `FieldRole` in `lib/dataset-types.ts` exactly — the server's
 * `sponsorTypeFieldSchema.role` accepts any string, but the rest of this app
 * (contract panels, dynamic item forms) only knows how to render these. */
const FIELD_ROLE_OPTIONS: { value: import("@/lib/dataset-types").FieldRole; label: string }[] = [
  { value: "instruction", label: "Instruction / prompt" },
  { value: "input_context", label: "Input context" },
  { value: "input_code", label: "Input code" },
  { value: "solution_code", label: "Solution code" },
  { value: "tests", label: "Tests" },
  { value: "expected_output", label: "Expected output" },
  { value: "rationale", label: "Rationale / explanation" },
  { value: "enum", label: "Enum / category" },
  { value: "list", label: "List" },
  { value: "reference", label: "Reference material" },
  { value: "file", label: "File upload" },
];

/** One row in the fork/custom field editor — the server's
 * `sponsorTypeFieldSchema` shape (`services/planner.ts`), kept separate from
 * `TypeField` since the editor works with plain strings before validation. */
interface EditableField {
  key: string;
  label: string;
  role: string;
  required: boolean;
}

let editableFieldSeq = 0;
function blankField(): EditableField & { _id: number } {
  editableFieldSeq += 1;
  return { _id: editableFieldSeq, key: "", label: "", role: "instruction", required: true };
}

/** The transcript shape the API stores (`services/planner.ts TranscriptMsg`) —
 * `a`/`u`, not the `assistant`/`user` this component renders. */
type StoredTranscriptTurn = { role: "a" | "u"; text: string };

/**
 * The subset of the server's `PlannerAnswers` this planner reads and writes.
 * Field names and value domains mirror `answersSchema` in the API's
 * `services/planner.ts` exactly — a mismatch here is rejected at autosave with
 * a 400, so they are kept deliberately identical rather than translated.
 */
interface PersistedAnswers {
  category?: string;
  title?: string;
  description?: string;
  language?: string;
  framework?: string;
  targetItems?: number;
  difficultyMix?: string;
  auditCoveragePct?: number;
  proposedLicense?: string;
  step?: string;
  pathChoice?: TemplatePath | null;
  datasetTypeId?: string;
  datasetTypeName?: string;
}

const PATH_OPTIONS: { key: TemplatePath; label: string; hint: string; icon: IconName }[] = [
  { key: "existing", label: "Use an existing template", hint: "start from a verified template in the catalog", icon: "file" },
  { key: "fork", label: "Fork / adapt an existing template", hint: "copy an existing template's fields and tweak them", icon: "refresh" },
  { key: "custom", label: "Create a custom dataset type", hint: "define your own contract schema and verification pipeline", icon: "sparkles" },
];

const LICENSE_OPTIONS = [
  { value: "CC-BY-4.0", label: "Creative Commons Attribution (CC BY 4.0)", hint: "open attribution" },
  { value: "CC-BY-SA-4.0", label: "CC Attribution-ShareAlike (CC BY-SA 4.0)", hint: "copyleft / viral sharealike" },
  { value: "CC0-1.0", label: "Public Domain Dedication (CC0 1.0)", hint: "universal public domain" },
  { value: "ODC-By-1.0", label: "Open Data Commons (ODC-By 1.0)", hint: "open database attribution" },
];

/**
 * The three difficulty answers the server accepts
 * (`answersSchema.difficultyMix`, api `services/planner.ts:77`), with V1's
 * community labels (page.tsx:139) and honest hints.
 *
 * The labels used to assert literal splits — "33% beginner, 34% intermediate,
 * 33% expert". Two things were wrong with that. It was offered on every type,
 * including types that declare no `expert` level at all, so the option promised
 * a mix the contract cannot produce. And no such split exists anywhere in the
 * server: `buildKarmaPreview` (api `services/planner.ts:182`) collapses the
 * whole answer to ONE karma tier that every accepted item is priced at —
 * mostly_beginner → beginner, balanced → intermediate, mostly_advanced →
 * advanced. So the hints below name exactly that tier, which IS substantiated,
 * and deliberately claim no ordering between the three rates: the rates are
 * admin-configurable (`admin-settings.ts`, defaults 10/25/60) and constrained
 * only to sit above the audit rate, so "higher karma for harder items" would be
 * a promise this UI cannot keep.
 */
const DIFFICULTY_OPTIONS: { key: string; label: string; hint: string; level: string | null }[] = [
  {
    key: "mostly_beginner",
    label: "Mostly beginner",
    hint: "approachable items · priced at the beginner karma rate",
    level: "beginner",
  },
  {
    key: "balanced",
    label: "Balanced",
    hint: "recommended · priced at the intermediate karma rate",
    // Always offered, as V1 does (page.tsx:1913 pushes "Balanced"
    // unconditionally): it is the server's own default tier for an unset or
    // unrecognised mix, so it can never be an answer the backend cannot honour.
    level: null,
  },
  {
    key: "mostly_advanced",
    label: "Mostly advanced",
    hint: "harder items · priced at the advanced karma rate",
    level: "expert",
  },
];

/**
 * Which difficulty answers a template actually permits, from its own declared
 * levels (V1 page.tsx:1909-1916). A type declaring only
 * `["intermediate","expert"]` must not be offered "Mostly beginner" — that
 * describes items its contract does not define.
 *
 * An empty `difficultyLevels` means the type declares nothing, so all three
 * stay: absent is "unconstrained", never "none permitted".
 */
function difficultyOptionsFor(type: DatasetType | null) {
  const levels = type?.difficultyLevels ?? [];
  if (levels.length === 0) return DIFFICULTY_OPTIONS;
  return DIFFICULTY_OPTIONS.filter((o) => {
    if (!o.level) return true;
    // V1 accepts either spelling for the top tier (page.tsx:1915).
    if (o.level === "expert") return levels.includes("expert") || levels.includes("advanced");
    return levels.includes(o.level);
  });
}

/** V1 community copy verbatim — labels page.tsx:141-146, hints :289-291. The
 * rebuild had drifted to more verbose labels and vaguer hints ("fastest
 * intake", "balanced verification", "highest rigor") for the same 0/25/100
 * values.
 *
 * The 25% hint is deliberately NOT V1-verbatim (was "a defined sample
 * receives validator audit"). Coverage sampling of clean items is deferred
 * to pool close-out (COMMUNITY_OPEN_POOL_PLAN_V2 §3.3) and every item that
 * reaches that point is currently a forced escalation
 * (`pendingHumanReview` is written `true` at every site in
 * services/validation.ts, never `false`), so `runPoolSamplingJob`'s
 * clean-item sample in services/pool-lifecycle.ts is always empty and every
 * cleared item gets a full validator review regardless of this pick — only
 * 0% changes anything (routes to the sponsor instead). The old hint told
 * sponsors the opposite of what happens today. */
const AUDIT_OPTIONS = [
  { pct: 0, label: "Automated checks only — 0%", hint: "no validator-audit allocation" },
  { pct: 25, label: "Partial validator audit — 25%", hint: "today: every cleared item still gets a full validator review — this % isn't applied yet" },
  { pct: 100, label: "Full validator audit — 100%", hint: "every item receives validator audit" },
];

/**
 * Generic language suggestions, used ONLY when the template constrains nothing
 * (`languageSupport.mode === "any"`) or when the catalog response carried no
 * `languageSupport` at all.
 *
 * This list is a convenience, not a capability claim, and it must never reach a
 * template that declares its own languages: rendered unfiltered it offered Java
 * on types that only accept Python, offered SQL when no active type accepts it,
 * and offered nothing valid at all for the C, Bash, Regex and GraphQL
 * templates — while `POST /assist` with `intent: "validate_field"` DOES receive
 * the dataset type and rejected the answer one call later. Picking Java on
 * `websocket_realtime` (python3 + websockets) was the reported symptom.
 */
const FALLBACK_LANGUAGES = ["Python", "TypeScript", "JavaScript", "Rust", "Go", "Java", "C++", "SQL", "Multi-language / Any"];

/** What the language step may offer for one template, plus the answer the rest
 * of the planner should display and submit. Mirrors V1's `LanguageDecision`
 * (page.tsx:1015-1027) so the fixed-template precedence rule exists once. */
interface LanguageDecision {
  /** `"unknown"` is NOT one of the server's modes: it is the catalog having
   * said nothing (`languageSupport` absent). Kept distinct from `"any"` on
   * purpose — `lib/store.tsx:358` leaves the field undefined rather than
   * fabricating `{ mode: "any", languages: [] }`, because a fabricated value is
   * indistinguishable from a real answer. */
  mode: "fixed" | "choice" | "any" | "none" | "unknown";
  /** Options to render, whatever the mode, so there is ONE chip renderer. */
  choices: { id: string; label: string; status: "verified" | "unverifiable"; reason?: string }[];
  /** The answer to display, validate and submit. */
  value: string;
  /** Does this template have a language at all? (`none` = no executable fields.) */
  required: boolean;
  /** Is the sponsor asked, or is it decided from the contract? */
  asked: boolean;
}

/**
 * Single source of truth for the language answer.
 *
 * `FALLBACK_LANGUAGES` is reachable only from `any`/`unknown`: it says nothing
 * about what a template can verify, so it must never reach a template that
 * declares its own languages.
 */
function resolveLanguage(type: DatasetType | null, typed: string): LanguageDecision {
  const support = type?.languageSupport;
  if (!support) {
    // No template yet, or a catalog payload without `languageSupport`. Keep
    // asking, exactly as the step did before — the honest degrade.
    return {
      mode: "unknown",
      choices: FALLBACK_LANGUAGES.map((label) => ({ id: label.toLowerCase(), label, status: "verified" as const })),
      value: typed,
      required: true,
      asked: true,
    };
  }
  const only = support.mode === "fixed" ? support.languages[0] : undefined;
  return {
    mode: support.mode,
    choices:
      support.mode === "any"
        ? FALLBACK_LANGUAGES.map((label) => ({ id: label.toLowerCase(), label, status: "verified" as const }))
        : support.languages,
    // On a `fixed` template the CONTRACT beats a stored answer. Drafts written
    // against the old hardcoded chip list hold languages the template cannot
    // verify — a real saved V1 session paired `websocket_realtime` (python3 +
    // websockets) with `language: "TypeScript"`. Letting the draft win would
    // carry that contradiction into a minted request.
    value: only ? only.label : typed,
    required: support.mode !== "none",
    asked: support.mode === "any" || support.mode === "choice",
  };
}

const ITEM_COUNT_OPTIONS = [250, 500, 1000, 2000, 5000, 10000] as const;

/** Per-size guidance, keyed by the rendered label so the lookup can't drift
 * from the option list. */
const ITEM_COUNT_HINTS: Record<string, string> = {
  "250": "small · fastest to fill",
  "500": "balanced starter corpus",
  "1,000": "large corpus",
  "2,000": "benchmark-scale",
  "5,000": "large coverage set",
  "10,000": "maximum suggested size",
};

/** What to say when a sponsor re-opens one step from the spec panel, so the
 * transcript explains why the planner jumped backwards. */
const PANEL_EDIT_PROMPT: Partial<Record<CommunityStep, string>> = {
  template: "Pick the dataset template again.",
  title: "What should this dataset be called?",
  description: "Describe what it should contain, and why it matters.",
  language: "Which language should the items target?",
  items: "How many verified items do you need?",
  difficulty: "What difficulty mix should contributors target?",
  audit: "How much validator audit coverage should run?",
  license: "Under which open license should it be published?",
  samples: "Attach or replace the reference examples.",
};

/**
 * Deterministic starter descriptions for the description step. Template- and
 * title-derived on purpose: these are scaffolding the sponsor edits, and they
 * must work with no LLM configured rather than leaving the box empty.
 */
function descriptionStarters(type: DatasetType | null, title: string): string[] {
  const subject = title.trim() || (type ? type.name.toLowerCase() : "this dataset");
  const fields = type?.fields.filter((f) => f.required).map((f) => f.label) ?? [];
  const fieldList = fields.length ? fields.join(", ") : "the fields defined by the template";
  return [
    `Each item covers ${subject}. Contributors fill ${fieldList}. A strong submission is self-contained, reproducible, and specific — avoid near-duplicates of earlier items and anything copied from a public benchmark.`,
    `We need broad coverage of ${subject}, not variations on one example. Every item must populate ${fieldList} and stand on its own. Reject-worthy: vague prompts, untested solutions, and content lifted from tutorials.`,
    `Goal: a clean, permissively licensed corpus on ${subject}. Fill ${fieldList} for every item, keep one concern per item, and make sure the expected result is verifiable rather than a matter of opinion.`,
  ];
}

/**
 * Local bounds for the three free-text steps, extracted from their handlers so
 * the LLM field guard can be gated on them: an out-of-bounds value must get its
 * own precise error, not a model's opinion, and must not spend an assist call.
 * The handlers below still call these, so the bounds exist exactly once.
 */
function titleProblem(trimmed: string): string | null {
  // V1's community planner bounds (page.tsx:4803-4810). The floor is V1's 8,
  // which is stricter than the server's `answersSchema.title.min(5)` — safe.
  // The ceiling is the server's real `max(120)`, not V1's 160: quoting 160
  // here would accept a title autosave then rejects with a 400.
  if (trimmed.length < 8) return "Give the title at least 8 characters so contributors can tell what it is.";
  if (trimmed.length > 120) return "Titles are capped at 120 characters.";
  return null;
}

function descriptionProblem(trimmed: string): string | null {
  // V1's bounds (page.tsx:4820-4827). 30 is V1's floor and is stricter than
  // the server's `answersSchema.description.min(20)`, so nothing that passes
  // here fails autosave. The ceiling is the server's real `max(2000)`, not
  // V1's 10,000, for the same reason as the title cap above.
  if (trimmed.length < 30) return "Add a bit more — at least 30 characters, so a reviewer can act on it.";
  if (trimmed.length > 2000) return "Descriptions are capped at 2,000 characters.";
  return null;
}

/** "TypeScript · React" or "TypeScript, React" — the part after the separator
 * is the optional framework the API accepts alongside the language
 * (V1 page.tsx:4856-4870). A chip passes a bare language and takes the same
 * path, so the two can never validate differently. */
function languageParts(raw: string): { language: string; framework: string; problem: string | null } {
  const [typedLang, ...rest] = raw.trim().split(/\s*[·,|]\s*/);
  const framework = rest.join(" ").trim();
  if (!typedLang || typedLang.length > 60) {
    return { language: typedLang ?? "", framework, problem: "Give a language name of 60 characters or fewer." };
  }
  if (framework.length > 60) {
    return { language: typedLang, framework, problem: "Framework names are capped at 60 characters." };
  }
  return { language: typedLang, framework, problem: null };
}

export function CreateRequestView() {
  const router = useRouter();
  const { pushToast } = useDemo();

  const [catalogTypes, setCatalogTypes] = useState<DatasetType[]>(DATASET_TYPE_CATALOG);
  const [sampleGate, setSampleGate] = useState<PlannerSampleGate>(DEFAULT_SAMPLE_GATE);
  /** Server-owned `validation.llm.enabled`. Starts false and stays false on any
   * catalog failure, so an unreachable API can never make the spec panel
   * advertise an LLM review stage that is switched off. */
  const [llmEnabled, setLlmEnabled] = useState(false);
  /**
   * Which steps the sponsor has genuinely answered.
   *
   * This cannot be inferred from the answer state itself, because several
   * answers carry a seeded default (`targetItems` 500, `difficultyMix`
   * "balanced", `auditCoveragePct` 25, `license` CC-BY-4.0, and a seeded
   * `datasetTypeName`). Testing those for truthiness rendered them in the spec
   * panel as decisions the sponsor had made — with a filled dot and a live
   * `edit` button — on the very first screen. That was both a false trust claim
   * and a way to bypass the walk entirely: `edit` on an unanswered row jumped
   * straight to review, so a request could be submitted with a template the
   * sponsor never chose and placeholder title/description text.
   */
  const [answered, setAnswered] = useState<Partial<Record<CommunityStep, boolean>>>({});
  const markAnswered = (step: CommunityStep) =>
    setAnswered((prev) => (prev[step] ? prev : { ...prev, [step]: true }));
  const [samples, setSamples] = useState<ApiArtifact[]>([]);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);

  /**
   * THE inline validation surface for the planner — one error at a time, shown
   * above the step's options, set by every step's answer handler on a bad
   * answer and cleared by that same handler on a good one (V1's single `error`
   * state, page.tsx:3876). A toast was the wrong mechanism for field
   * validation: it disappears while the input is still wrong and there is
   * nothing to clear when the sponsor fixes it.
   *
   * Deliberately still distinct from two states that are NOT step-answer
   * validation: `draftError` (the draft failed to persist — about the tab, not
   * the answer) and `sampleError` (an upload failed, rendered by the upload
   * field itself). `createTypeError` also stays separate: it validates the
   * fork/custom dataset-type FORM and renders beside that form's own submit
   * button, which has no V1 chat-step counterpart.
   */
  const [stepError, setStepError] = useState<string | null>(null);

  /** A `validate_field` call is in flight — gates the composer and the chips so
   * one answer can't be sent twice while the guard is still deciding. */
  const [fieldChecking, setFieldChecking] = useState(false);
  /**
   * Fields whose AI review could not be performed.
   *
   * NOT a rejection of the sponsor's text, and never rendered as one. The
   * server's `validate_field` FAILS CLOSED: with no model configured (or the
   * provider down) it answers `ok: false` with `source: "fallback"` and a reason
   * that says review is unavailable — it is explicitly not a verdict about the
   * value (api `services/llm/consumers/validate-field.ts`). Telling a sponsor
   * their perfectly good title is junk because a model was offline would be a
   * false claim, so the answer is accepted and this set drives an honest
   * "not AI-reviewed" note instead. The request still passes mandatory human
   * admin review before it can mint, which is the real gate.
   */
  const [aiReviewUnavailable, setAiReviewUnavailable] = useState<Partial<Record<PlannerGuardField, true>>>({});

  const [step, setStep] = useState<CommunityStep>("template");
  const [pathChoice, setPathChoice] = useState<TemplatePath | null>(null);

  const [datasetTypeId, setDatasetTypeId] = useState("debugging");
  const [datasetTypeName, setDatasetTypeName] = useState("Debugging / Bug Fix");
  const [selectedType, setSelectedType] = useState<DatasetType | null>(DATASET_TYPE_CATALOG[0]);

  // Fork/custom dataset-type editor state — the sponsor defines (fork) or
  // writes from scratch (custom) the new type's own name/description/fields,
  // then `POST /v1/planner/dataset-types/requests` creates it before the
  // linear planner (title/description/... below) continues against it, same
  // as picking an existing catalog type does.
  const [forkSourceId, setForkSourceId] = useState<string | null>(null);
  const [customTypeName, setCustomTypeName] = useState("");
  const [customTypeDescription, setCustomTypeDescription] = useState("");
  const [customFields, setCustomFields] = useState<(EditableField & { _id: number })[]>([blankField(), blankField()]);
  const [creatingType, setCreatingType] = useState(false);
  const [createTypeError, setCreateTypeError] = useState<string | null>(null);
  // Harness authorship stays ADMIN-ONLY (admin-harness.ts) — a sponsor can
  // never submit executable code. This is only a plain-text REQUEST that an
  // admin sees when reviewing the type, so they can decide whether to author
  // a real harness via the existing secured flow.
  const [wantsHarness, setWantsHarness] = useState(false);
  const [harnessNote, setHarnessNote] = useState("");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState("");
  const [framework, setFramework] = useState("");
  const [targetItems, setTargetItems] = useState<number>(500);
  const [difficultyMix, setDifficultyMix] = useState("balanced");
  const [auditCoveragePct, setAuditCoveragePct] = useState<number>(25);
  const [license, setLicense] = useState("CC-BY-4.0");

  /**
   * Everything type-aware about the two contract-driven steps, resolved once
   * per render and read by the handlers, the step counter, the renders, the
   * spec panel and the submit payload. Declared here, above the handlers, so
   * there is exactly one copy of each rule — two copies of the fixed-language
   * precedence rule is one bug away from the spec panel and the submitted
   * request disagreeing about what language the dataset is in.
   */
  const languageDecision = resolveLanguage(selectedType, language);

  // Steps this walk will actually ask. `fields` only exists on the fork/custom
  // paths, so counting it on the catalog path would advertise a step that is
  // never reached and leave the bar short of 100%.
  //
  // Declared here rather than beside the progress bar it also feeds, because
  // `handleSubmitRequest` and `answerWith` below both have to agree with it and
  // a closure over a later `const` reads worse than one ordering.
  const askedSteps = UI_STEPS.filter((s) => {
    if (s === "review") return false;
    if (s === "fields") return pathChoice === "fork" || pathChoice === "custom";
    // A `none` template has no language and a `fixed` one is answered from the
    // contract without asking, so the counter must not promise a step that
    // never appears (V1 page.tsx:5104-5106). `unknown` and the two asked modes
    // all keep the step.
    if (s === "language") return !selectedType || languageDecision.asked || languageDecision.mode === "unknown";
    return true;
  });

  /**
   * Asked steps that still have no genuine answer, in walk order.
   *
   * ONE list drives the submit guard, the submit button's enabled state, the
   * review screen's readiness claim and where `answerWith` returns to after a
   * panel edit — so those four cannot disagree with each other or with the
   * spec panel's own dots.
   *
   * Before this, the guard re-checked only `template`/`title`/`description`
   * while `answerWith` sent the sponsor straight back to review after a single
   * answer. One `license` edit after a template change therefore reached
   * "Ready for submission" with submit enabled, skipping the title and
   * description re-walk the template change had queued.
   *
   * `samples` is deliberately excluded: its real gate is the server's own
   * minimum (`sampleGate.min`, still checked separately), and nothing about it
   * is persisted, so a resumed draft never carries a `samples` flag and would
   * be bounced out of review for no reason. `fields` is excluded for a
   * different reason — it is part of DEFINING the template on the fork/custom
   * paths, and `template` being answered already means the type was created.
   */
  const pendingAnswers = askedSteps.filter(
    (s) => s !== "samples" && s !== "fields" && !answered[s]
  );
  const difficultyOptions = difficultyOptionsFor(selectedType);

  /**
   * AI title ideas for the `title` step, from the real
   * `POST /v1/planner/assist` (`intent: "title"`) endpoint.
   *
   * `source` is a load-bearing honesty signal, not decoration: the API falls
   * closed to deterministic, catalog-derived titles whenever no LLM is
   * configured (or the call fails), and those must never be labelled
   * AI-generated. The two labels below stay distinct for that reason.
   */
  const [titleSuggestions, setTitleSuggestions] = useState<string[]>([]);
  const [titleSuggestionsLoading, setTitleSuggestionsLoading] = useState(false);
  const [titleSuggestionSource, setTitleSuggestionSource] = useState<"llm" | "fallback" | null>(null);
  /** When the assist call fails (or returns nothing) the title step must not
   * go silent — that leaves a bare input with no explanation of where the
   * ideas went. Drives the retry affordance, and blocks the auto-fire effect
   * below from re-looping forever on a persistent failure. */
  const [titleSuggestionError, setTitleSuggestionError] = useState(false);
  /** The dataset type we have already auto-fetched ideas for, so entering the
   * title step self-populates ONCE per type instead of spending another LLM
   * call every time the sponsor walks back to it from the spec panel. */
  const autoTitleRequestedRef = useRef<string | null>(null);

  /** The real server call for title ideas. Kept separate from the step
   * handlers so the "try again" control can re-run it without re-picking the
   * template. An empty result is deliberately treated as an error state: the
   * step must never render a bare input with no explanation. */
  const fetchTitleSuggestions = useCallback((typeId: string) => {
    setTitleSuggestions([]);
    setTitleSuggestionSource(null);
    setTitleSuggestionError(false);
    setTitleSuggestionsLoading(true);
    void authedFetch(API.planner.assist, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "title", datasetTypeId: typeId }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("Title generation did not complete.");
        return (await res.json()) as { titles?: string[]; source?: "llm" | "fallback" };
      })
      .then((body) => {
        const titles = body.titles?.filter((t) => typeof t === "string" && t.trim().length > 0) ?? [];
        if (titles.length === 0) throw new Error("No title ideas were returned.");
        setTitleSuggestions(titles);
        // Anything the server does not explicitly mark `llm` is the fallback.
        setTitleSuggestionSource(body.source === "llm" ? "llm" : "fallback");
      })
      .catch(() => {
        // Surfaced with a retry rather than swallowed — manual title entry
        // stays available either way.
        setTitleSuggestionSource(null);
        setTitleSuggestionError(true);
      })
      .finally(() => setTitleSuggestionsLoading(false));
  }, []);

  /** Suggestions belong to one dataset type. Clearing them (and the once-per-
   * type ref's effect via the state reset) is what lets the auto-fire below
   * re-run when the sponsor changes template mid-walk. */
  const resetTitleSuggestions = useCallback(() => {
    setTitleSuggestions([]);
    setTitleSuggestionSource(null);
    setTitleSuggestionError(false);
  }, []);

  /**
   * Starter descriptions for the `description` step, from the real
   * `POST /v1/planner/assist` (`intent: "description"`) endpoint.
   *
   * Same honesty contract as the title ideas above: `source` is the server's
   * own statement of whether a model wrote these or it fell closed to
   * deterministic, template-derived copy, and the two are labelled
   * differently for that reason. Anything not explicitly `"llm"` is a
   * fallback.
   *
   * This intent is NOT a v1 intent — v1's description step is served entirely
   * by the local `descriptionStarters()` helper with no model behind it. It is
   * an approved deviation (see the API's
   * `services/llm/consumers/suggest-description.ts` parity note). The local
   * helper stays as the instant/offline fallback, so this step never renders
   * an empty option list while a request is in flight or after one fails —
   * which is also why, unlike `title`, nothing here gates the composer.
   */
  const [descriptionSuggestions, setDescriptionSuggestions] = useState<string[]>([]);
  const [descriptionSuggestionsLoading, setDescriptionSuggestionsLoading] = useState(false);
  const [descriptionSuggestionSource, setDescriptionSuggestionSource] = useState<"llm" | "fallback" | null>(null);
  /** A failed (or empty) assist call must say so rather than silently leaving
   * the deterministic starters looking like the AI result. Drives the retry
   * affordance in the render. */
  const [descriptionSuggestionError, setDescriptionSuggestionError] = useState(false);
  /** `datasetTypeId` + the committed title we have already auto-fetched for,
   * so entering the description step self-populates ONCE per grounding rather
   * than spending a model call every time the sponsor walks back to it. The
   * title is part of the key because it is the grounding the server is given:
   * re-answering the title genuinely changes what good starters look like, and
   * a title only ever changes on commit, never per keystroke. */
  const autoDescriptionRequestedRef = useRef<string | null>(null);

  /** The real server call for starter descriptions. Separate from the step
   * handlers so the retry control can re-run it without re-walking the
   * planner. An empty result is treated as an error state on purpose — the
   * step must never claim AI copy it did not receive. */
  const fetchDescriptionSuggestions = useCallback((typeId: string, titleContext: string) => {
    setDescriptionSuggestions([]);
    setDescriptionSuggestionSource(null);
    setDescriptionSuggestionError(false);
    setDescriptionSuggestionsLoading(true);
    const trimmedTitle = titleContext.trim();
    void authedFetch(API.planner.assist, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "description",
        datasetTypeId: typeId,
        // The server bounds this context at `min(3).max(120)` and 400s the
        // whole request on a violation, so an out-of-bounds title is omitted
        // rather than sent — losing the grounding is better than losing the
        // starters. 120 is also the title step's own cap, so a title that
        // could be saved always fits.
        ...(trimmedTitle.length >= 3 && trimmedTitle.length <= 120 ? { title: trimmedTitle } : {}),
      }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("Description generation did not complete.");
        return (await res.json()) as { descriptions?: string[]; source?: "llm" | "fallback" };
      })
      .then((body) => {
        const descriptions = body.descriptions?.filter((d) => typeof d === "string" && d.trim().length > 0) ?? [];
        if (descriptions.length === 0) throw new Error("No starter descriptions were returned.");
        setDescriptionSuggestions(descriptions);
        // Anything the server does not explicitly mark `llm` is the fallback.
        setDescriptionSuggestionSource(body.source === "llm" ? "llm" : "fallback");
      })
      .catch(() => {
        // Surfaced with a retry rather than swallowed. The deterministic
        // starters still render underneath, labelled as what they are.
        setDescriptionSuggestionSource(null);
        setDescriptionSuggestionError(true);
      })
      .finally(() => setDescriptionSuggestionsLoading(false));
  }, []);

  /** Starters are grounded in one dataset type. Clearing them is what lets the
   * auto-fire below re-run when the sponsor changes template mid-walk. */
  const resetDescriptionSuggestions = useCallback(() => {
    setDescriptionSuggestions([]);
    setDescriptionSuggestionSource(null);
    setDescriptionSuggestionError(false);
  }, []);

  /**
   * The starters the description step renders, and the one condition under
   * which they may be called AI-generated.
   *
   * Server results win when there are any; otherwise the local deterministic
   * helper fills the list, which is what keeps the step usable before the
   * first response, while one is in flight, and after one fails.
   *
   * `descriptionSuggestionsAreAi` deliberately requires BOTH a server list and
   * the server's own `source === "llm"`. A deterministic list — local, or the
   * API's own fail-closed fallback — is never labelled AI. Resolved here, once,
   * so the label and the list cannot disagree with each other.
   */
  const descriptionStarterList =
    descriptionSuggestions.length > 0 ? descriptionSuggestions : descriptionStarters(selectedType, title);
  const descriptionSuggestionsAreAi =
    descriptionSuggestions.length > 0 && descriptionSuggestionSource === "llm";

  const [messages, setMessages] = useState<{ role: "assistant" | "user"; text: string }[]>([
    {
      role: "assistant",
      text: "Welcome to the Community Dataset Planner. Let's design your open dataset specification. How should we define the contract?",
    },
  ]);

  const [submitting, setSubmitting] = useState(false);

  // Auto-suggest titles the moment the title step opens — the sponsor sees
  // clickable ideas without having to press "generate" (v1 parity:
  // databounty-web sponsor/create/page.tsx:1868-1888). Non-blocking by
  // design: the field stays typeable and a failure surfaces "try again"
  // instead of re-looping.
  useEffect(() => {
    if (step !== "title") return;
    // Once the request is being submitted the title step is no longer truly
    // active; spending an LLM call then would be pure waste.
    if (submitting) return;
    // Only for a launchable catalog type. A freshly drafted custom/forked type
    // sits in `platform_review`, which `POST /assist` refuses with a 400
    // (`isLaunchableType`), so firing would manufacture an error state where
    // the render below correctly shows a plain "once approved" note instead.
    if (!catalogTypes.some((t) => t.id === datasetTypeId)) return;
    if (autoTitleRequestedRef.current === datasetTypeId) return;
    // Nothing in flight, nothing already resolved, and no error to loop on.
    if (
      titleSuggestions.length > 0 ||
      titleSuggestionSource !== null ||
      titleSuggestionsLoading ||
      titleSuggestionError
    ) {
      return;
    }
    autoTitleRequestedRef.current = datasetTypeId;
    // Kicked off on a timer rather than called inline: fetchTitleSuggestions
    // sets state immediately (clears the list, flips `loading`), and doing
    // that inside the effect body is a cascading render. The timeout also
    // collapses the double invocation React StrictMode performs in dev, which
    // would otherwise fire two assist calls per step entry.
    const timer = setTimeout(() => fetchTitleSuggestions(datasetTypeId), 0);
    return () => clearTimeout(timer);
  }, [
    step,
    submitting,
    catalogTypes,
    datasetTypeId,
    titleSuggestions.length,
    titleSuggestionSource,
    titleSuggestionsLoading,
    titleSuggestionError,
    fetchTitleSuggestions,
  ]);

  // Same shape as the title auto-suggest above: the description step opens
  // with real starters already fetched instead of a "generate" button, and the
  // composer stays typeable throughout.
  //
  // Two deliberate differences from the title effect:
  //  * No launchable-type gate. `POST /assist` refuses `intent: "title"` for a
  //    custom/forked type still in `platform_review`, but for `description` it
  //    answers with the deterministic starters and reports
  //    `source: "fallback"` — refusing here would regress v1, whose
  //    description step works on every path. So this fires for custom types
  //    too, and the render labels whatever comes back honestly.
  //  * The once-per key includes the committed title, since that is the
  //    grounding the server is handed.
  useEffect(() => {
    if (step !== "description") return;
    // Once the request is being submitted this step is no longer really
    // active; spending a model call then would be pure waste.
    if (submitting) return;
    // NUL-separated: neither a dataset-type id nor a title can contain it, so
    // the two parts can never run together into a colliding key.
    const grounding = `${datasetTypeId}\u0000${title.trim()}`;
    if (autoDescriptionRequestedRef.current === grounding) return;
    // Never stack a second call on top of one already in flight.
    if (descriptionSuggestionsLoading) return;
    autoDescriptionRequestedRef.current = grounding;
    // Kicked off on a timer for the same reason as the title effect:
    // `fetchDescriptionSuggestions` sets state immediately, and doing that in
    // an effect body is a cascading render. The `fired` flag hands the key
    // back if the effect is torn down before the timer runs, so React
    // StrictMode's dev double-invoke (effect → cleanup → effect) cannot leave
    // the step permanently marked "already requested" without a request.
    let fired = false;
    const timer = setTimeout(() => {
      fired = true;
      fetchDescriptionSuggestions(datasetTypeId, title);
    }, 0);
    return () => {
      clearTimeout(timer);
      if (!fired) autoDescriptionRequestedRef.current = null;
    };
  }, [
    step,
    submitting,
    datasetTypeId,
    title,
    descriptionSuggestionsLoading,
    fetchDescriptionSuggestions,
  ]);

  /**
   * The server-side draft this planner is editing.
   *
   * Every answer is persisted to a real `PlannerSession` row as the sponsor
   * goes, exactly as v1's `sponsor/create/page.tsx` does on each turn. Before
   * this, the id was a client-only `planner_${useId()}` string that matched no
   * row anywhere: a reload discarded every answered step, `GET
   * /v1/planner/sessions/active` could never return anything (so the "resume
   * your draft" affordance was dead by construction), and the id handed to
   * sponsor-reference uploads pointed at nothing.
   *
   * `null` until the session is created — `persist()` no-ops while it is, so
   * a draft-service outage degrades to the old in-memory behaviour with an
   * explicit warning rather than blocking the planner outright.
   */
  const sessionIdRef = useRef<string | null>(null);
  /**
   * The server's `version` for this row, for the API's optimistic-concurrency
   * check. Autosaves are deliberately not awaited by the step handlers (a
   * sponsor should never wait on a network round-trip to advance), so two can
   * be in flight at once; sending the version we last saw makes the API reject
   * a stale write with 409 instead of silently clobbering the newer one. Held
   * in a ref, not state, because it must be read by the next save without
   * waiting for a re-render.
   */
  const versionRef = useRef<number>(0);
  /** Serialises autosaves so two turns in quick succession cannot race each
   * other into a self-inflicted 409. */
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const [draftError, setDraftError] = useState<string | null>(null);

  /** Re-seed the form from a resumed draft. Catalog types are passed in
   * rather than read from state because this runs inside the same mount
   * effect that fetched them — `catalogTypes` has not re-rendered yet. */
  const restoreFrom = useCallback(
    (transcript: unknown, answers: PersistedAnswers, types: DatasetType[]) => {
      if (answers.datasetTypeId) {
        const hit = types.find((t) => t.id === answers.datasetTypeId);
        if (hit) {
          setSelectedType(hit);
          setDatasetTypeId(hit.id);
          setDatasetTypeName(hit.name);
        } else {
          // The type was retired or unpriced since the draft was saved. Keep
          // the id so nothing is silently rewritten to a different dataset
          // type; `selectedType` stays null and the review step's own
          // validation surfaces it.
          setDatasetTypeId(answers.datasetTypeId);
          if (answers.datasetTypeName) setDatasetTypeName(answers.datasetTypeName);
        }
      }
      // A `fixed` template's contract overrides whatever the draft stored. A
      // real saved V1 session paired `websocket_realtime` (python3 +
      // websockets) with `language: "TypeScript"`, written by the old
      // hardcoded chip list; without this override that contradiction rides
      // into a minted request. `resolveLanguage` applies the same precedence
      // for display and submit, but writing it into state here is what makes
      // the next autosave correct the stored draft too.
      const resumedType = answers.datasetTypeId
        ? types.find((t) => t.id === answers.datasetTypeId) ?? null
        : null;
      const fixedOnly =
        resumedType?.languageSupport?.mode === "fixed"
          ? resumedType.languageSupport.languages[0]
          : undefined;

      /**
       * Does the resumed draft's stored answer still fit the resumed type?
       *
       * `persist` only ever writes a field once the sponsor answered its step,
       * so presence in the draft is the answered signal — but presence does
       * not make an answer VALID for the type now on the draft. Drafts
       * predating the template-change fix (and any written before this
       * planner filtered its chips) can pair a type with a difficulty it never
       * declares or a language it cannot verify.
       *
       * The honest degrade is the same one `resolveLanguage` uses: do not mark
       * the step answered, so the row reads "—", the step goes back into
       * `pendingAnswers`, and the sponsor is asked again. Nothing is rewritten
       * to a substitute value — that would be inventing an answer — and
       * nothing is silently accepted.
       *
       * This extends a precedent already in this function: the `fixedOnly`
       * override below exists because a real saved session paired
       * `websocket_realtime` (python3 + websockets) with `language:
       * "TypeScript"`.
       */
      const mixStillOffered =
        !answers.difficultyMix ||
        difficultyOptionsFor(resumedType).some((o) => o.key === answers.difficultyMix);
      const resumedLanguageSupport = resumedType?.languageSupport;
      const languageStillDeclared =
        !answers.language ||
        resumedLanguageSupport?.mode !== "choice" ||
        resumedLanguageSupport.languages.some(
          (l) =>
            l.label.toLowerCase() === answers.language!.toLowerCase() ||
            l.id.toLowerCase() === answers.language!.toLowerCase()
        );
      const auditStillOffered =
        typeof answers.auditCoveragePct !== "number" ||
        !resumedType?.verification?.auditOptions?.length ||
        resumedType.verification.auditOptions.includes(answers.auditCoveragePct);

      setAnswered({
        ...(answers.datasetTypeId ? { template: true } : {}),
        ...(answers.title ? { title: true } : {}),
        ...(answers.description ? { description: true } : {}),
        // `fixedOnly` counts as answered because the CONTRACT answered it —
        // the walk never asks. Do NOT widen this to "a template was picked":
        // that would render an unanswered `choice`/`any` language row as a
        // decision the sponsor made, with a live `edit` button, which is the
        // exact false-trust bug the `answered` doc comment above describes.
        ...((answers.language && languageStillDeclared) || fixedOnly ? { language: true } : {}),
        ...(typeof answers.targetItems === "number" ? { items: true } : {}),
        ...(answers.difficultyMix && mixStillOffered ? { difficulty: true } : {}),
        ...(typeof answers.auditCoveragePct === "number" && auditStillOffered
          ? { audit: true }
          : {}),
        ...(answers.proposedLicense ? { license: true } : {}),
      });
      if (answers.pathChoice) setPathChoice(answers.pathChoice);
      if (answers.title) setTitle(answers.title);
      if (answers.description) setDescription(answers.description);
      if (fixedOnly) {
        setLanguage(fixedOnly.label);
        setFramework("");
      } else if (answers.language) {
        setLanguage(answers.language);
      }
      if (!fixedOnly && answers.framework) setFramework(answers.framework);
      if (typeof answers.targetItems === "number") setTargetItems(answers.targetItems);
      if (answers.difficultyMix) setDifficultyMix(answers.difficultyMix);
      if (typeof answers.auditCoveragePct === "number") setAuditCoveragePct(answers.auditCoveragePct);
      if (answers.proposedLicense) setLicense(answers.proposedLicense);

      // The resume notice is a transcript turn, not a page banner — V1
      // page.tsx:4240 appends exactly this line after restoring the saved
      // conversation, so the notice costs no vertical space above the cards and
      // sits where the sponsor is already reading.
      const RESUME_NOTE = {
        role: "assistant" as const,
        text: "Resumed your dataset request. Pick up where you left off, or edit any answer on the right.",
      };
      const turns = Array.isArray(transcript) ? (transcript as StoredTranscriptTurn[]) : [];
      if (turns.length > 0) {
        setMessages([
          ...turns.map((t) => ({ role: t.role === "u" ? ("user" as const) : ("assistant" as const), text: t.text })),
          RESUME_NOTE,
        ]);
      } else {
        // Answers were restored but no transcript was persisted — keep the
        // welcome turn and still say the draft was picked up, rather than
        // silently landing the sponsor mid-walk with no explanation.
        setMessages((prev) => [...prev, RESUME_NOTE]);
      }

      // The reference samples attached to this draft are restored too (see the
      // `listPlannerSessionSamples` call in the mount effect), so a resumed
      // draft can land on its saved step — including `review` — without the
      // sample list reading as empty.
      const savedStep = answers.step;
      if (savedStep && UI_STEPS.includes(savedStep as CommunityStep)) {
        setStep(savedStep as CommunityStep);
      }
    },
    []
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      let types: DatasetType[] = DATASET_TYPE_CATALOG;
      try {
        const cat = await hydratePlannerCatalog();
        if (!alive) return;
        if (cat.datasetTypes.length > 0) {
          types = cat.datasetTypes;
          setCatalogTypes(cat.datasetTypes);
        }
        setSampleGate(cat.sampleGate);
        setLlmEnabled(cat.llmValidationEnabled);
      } catch {
        // Keep the bundled catalog; the planner still works off it.
      }
      if (!alive) return;

      const seed = types.find((t) => t.id === "debugging") ?? types[0];
      if (seed) {
        setSelectedType(seed);
        setDatasetTypeId(seed.id);
        setDatasetTypeName(seed.name);
      }

      // Create-or-resume this user's single active draft. The API returns the
      // existing incomplete session when there is one (`reused: true`), which
      // is what makes a reload continue instead of starting over.
      try {
        const res = await authedFetch(API.planner.sessions, { method: "POST" });
        if (!alive) return;
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as {
          session: { id: string; version?: number; transcript?: unknown };
          prefilled?: PersistedAnswers;
          reused?: boolean;
        };
        sessionIdRef.current = body.session.id;
        versionRef.current = body.session.version ?? 0;
        // `reused` alone is not enough to claim a resume: opening the planner
        // and navigating away leaves an empty draft, and announcing "Draft
        // resumed" for a draft with nothing in it is a claim the page cannot
        // support. Only say it when something was actually restored.
        const prefilled = body.prefilled ?? {};
        const hasContent =
          Object.keys(prefilled).length > 0 ||
          (Array.isArray(body.session.transcript) && body.session.transcript.length > 0);
        if (body.reused && hasContent) {
          restoreFrom(body.session.transcript, prefilled, types);
          // Re-attach this draft's reference samples. Awaited before the step
          // is shown so the samples/review step never renders a real "0 / 2"
          // gate for a draft that does have files.
          const restoredSamples = await listPlannerSessionSamples(body.session.id);
          if (!alive) return;
          setSamples(restoredSamples);
        }
      } catch {
        if (alive) {
          setDraftError(
            "Couldn't start a saved draft — your answers are only held in this tab and will be lost if you reload."
          );
        }
      }
    })();
    return () => { alive = false; };
  }, [restoreFrom]);

  /**
   * Keep the sample list's scan state true to the server.
   *
   * The refresh callback used to be `() => {}`. The poll ran, so the hook
   * looked wired, but nothing re-read the artifacts — the `scanning` snapshot
   * that `upload-complete` returns was the last thing the UI ever saw. With
   * `artifacts.malware_scan.enabled` off (the default in every environment) the
   * server settles the row to `status: ready, scanStatus: not_required`
   * immediately, and the planner still displayed "File stored · security scan
   * in progress" — a check claimed to be running for a scanner that is
   * switched off. A page reload rendered the correct line, which is what
   * isolated the missing refresh rather than the label.
   *
   * Re-listing the session's samples is exactly what the original app does
   * on this same screen.
   * `sessionIdRef` is read INSIDE the callback, not during render: the hook
   * holds the newest callback in a ref, so this always sees the live id and
   * nothing reads a ref in the render body.
   */
  useArtifactStatusPolling(samples.some((s) => s.status === "scanning"), () => {
    const id = sessionIdRef.current;
    if (!id) return;
    return listPlannerSessionSamples(id).then(setSamples);
  });

  const addMessage = (role: "assistant" | "user", text: string) => {
    setMessages((prev) => [...prev, { role, text }]);
  };

  /**
   * Persist one step's answers plus the transcript turns it produced.
   *
   * Only the NEW turns are sent: the API appends and de-duplicates them
   * server-side (`normalizeTranscript`), so replaying the whole transcript on
   * every turn would be both wasteful and lossy.
   *
   * Saves are chained rather than fired in parallel so two fast answers cannot
   * race into a 409 against each other. A 409 from a genuinely concurrent
   * writer (the same draft open in another tab) re-syncs from the server's
   * version and warns, instead of overwriting the other tab's work.
   */
  const persist = useCallback((
    answers: PersistedAnswers,
    turns: StoredTranscriptTurn[] = [],
    /**
     * Send `replace: true`, so the stored answers become EXACTLY `answers`
     * instead of being merged over what is there.
     *
     * The route supports this already (`body.replace`, api
     * `routes/v1/planner.ts:612-614`), and it is the only way to REMOVE a
     * stored answer — a merge treats an absent key as "leave alone", so a
     * template change could clear `answered` in this tab and still have the
     * old template's title, language and difficulty sitting on the draft row,
     * ready for the next reload's `restoreFrom` to hand back as decided
     * answers. That reload is not a corner case: the draft is server-persisted
     * precisely so a reload resumes.
     */
    replace = false
  ) => {
    const id = sessionIdRef.current;
    if (!id) return;
    saveChainRef.current = saveChainRef.current
      .then(async () => {
        const res = await authedFetch(API.planner.sessionAnswers(id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            answers,
            transcript: turns,
            expectedVersion: versionRef.current,
            ...(replace ? { replace: true } : {}),
          }),
        });
        if (res.status === 409) {
          const body = await res.json().catch(() => ({}) as { currentVersion?: number });
          if (typeof body.currentVersion === "number") versionRef.current = body.currentVersion;
          setDraftError("This draft was changed in another tab. Reload before continuing so nothing is lost.");
          return;
        }
        if (!res.ok) {
          setDraftError("Couldn't save your progress — the last answer is only held in this tab.");
          return;
        }
        const body = (await res.json()) as { session: { version?: number } };
        if (typeof body.session?.version === "number") versionRef.current = body.session.version;
        setDraftError(null);
      })
      .catch(() => {
        setDraftError("Couldn't save your progress — the last answer is only held in this tab.");
      });
  }, []);

  const handleChoosePath = (path: TemplatePath) => {
    setStepError(null);
    setPathChoice(path);
    const [userTurn, assistantTurn] =
      path === "existing"
        ? ["Use an existing template", "Select a template from our verified catalog to define the input and solution fields."]
        : path === "fork"
          ? ["Fork / adapt an existing template", "Choose a base template to clone and customize its fields."]
          : ["Create a custom dataset type", "Define your custom schema. Describe the dataset task and fields required."];
    addMessage("user", userTurn);
    addMessage("assistant", assistantTurn);
    // "existing" and "fork" both still need a catalog pick next (fork picks a
    // SOURCE to clone, existing picks the type itself), so they stay on
    // "template" for the catalog grid below. "custom" has nothing to pick —
    // go straight to a blank field editor.
    const nextStep: CommunityStep = path === "custom" ? "fields" : "template";
    if (path === "custom") {
      setForkSourceId(null);
      setCustomTypeName("");
      setCustomTypeDescription("");
      setCustomFields([blankField(), blankField()]);
      setCreateTypeError(null);
      setWantsHarness(false);
      setHarnessNote("");
    }
    setStep(nextStep);
    persist({ pathChoice: path, step: nextStep }, [
      { role: "u", text: userTurn },
      { role: "a", text: assistantTurn },
    ]);
  };

  const handleSelectType = (t: DatasetType) => {
    setStepError(null);
    /**
     * Is this a CHANGE of template, rather than the first pick?
     *
     * Gated on `answered.template` rather than compared against
     * `selectedType`: that is seeded to the first catalog row before the
     * sponsor has picked anything, so comparing to it would treat the very
     * first selection as a change.
     *
     * On a real change every template-dependent answer is dropped
     * (see `TEMPLATE_DEPENDENT_STEPS`), which is what makes the panel's dots,
     * the "steps decided" count and the submit guard describe the NEW
     * template. The underlying values are deliberately left in state rather
     * than blanked: the guard below refuses to submit until each is re-answered
     * against this template, and clearing them to a placeholder would be
     * inventing an answer the sponsor never gave.
     */
    const templateChanged = Boolean(answered.template) && datasetTypeId !== t.id;
    // Title ideas and starter descriptions are both scoped to one dataset
    // type — drop the previous type's before those steps re-fetch for this
    // one.
    resetTitleSuggestions();
    resetDescriptionSuggestions();
    setSelectedType(t);
    setDatasetTypeId(t.id);
    setDatasetTypeName(t.name);
    markAnswered("template");
    if (templateChanged) {
      setAnswered((prev) => {
        const next = { ...prev };
        for (const dependent of TEMPLATE_DEPENDENT_STEPS) delete next[dependent];
        return next;
      });
    }
    const userTurn = `Selected template: ${t.name}`;
    const fieldList = t.fields.map((f) => f.label).join(", ");
    // A template change has to SAY what it invalidated. Silently resetting five
    // rows in the panel while the transcript reads like a normal step forward
    // is how the sponsor ends up re-walking without understanding why.
    const assistantTurn = templateChanged
      ? `Switched to ${t.name}, which requires: ${fieldList}. Its languages, difficulty levels and audit options are its own, so the language, difficulty and audit answers — and the title and description written for the previous template — have been cleared and are asked again.${
          samples.length > 0
            ? " Your attached examples were checked against the previous template's contract, so re-check them on the samples step."
            : ""
        } What is the working title for your dataset?`
      : `Great choice! ${t.name} requires: ${fieldList}. What is the working title for your dataset?`;
    addMessage("user", userTurn);
    addMessage("assistant", assistantTurn);
    setStep("title");
    // `category` is what the API's `resolveType` looks the DatasetType up by
    // at finalize time (`answers.category ?? answers.datasetTypeId`), so it
    // carries the type id, not a display label.
    const base: PersistedAnswers = {
      category: t.id,
      datasetTypeId: t.id,
      datasetTypeName: t.name,
      step: "title",
    };
    if (!templateChanged) {
      persist(base, [{ role: "u", text: userTurn }, { role: "a", text: assistantTurn }]);
      return;
    }
    /**
     * A template change is persisted as a REPLACE carrying only the answers
     * that survive it, so the invalidation is durable.
     *
     * Clearing `answered` in this tab is not enough on its own: the draft row
     * would still hold the previous template's title, description, language,
     * framework, difficultyMix and auditCoveragePct, and the next reload's
     * `restoreFrom` reads presence-in-the-draft as the answered signal — so it
     * would hand every one of them back as a decision made against the NEW
     * template, restoring exactly the incoherent state this fix removes. A
     * merge cannot express a removal; `replace` can.
     *
     * The survivors are the template-independent answers (`targetItems`,
     * `proposedLicense`) and `pathChoice`, each included only if it was
     * genuinely answered — writing a seeded default here would persist it and
     * make the next resume read it as a sponsor decision, which is the bug the
     * `answered` map exists to prevent.
     */
    persist(
      {
        ...base,
        ...(pathChoice ? { pathChoice } : {}),
        ...(answered.items ? { targetItems } : {}),
        ...(answered.license ? { proposedLicense: license } : {}),
      },
      [{ role: "u", text: userTurn }, { role: "a", text: assistantTurn }],
      true
    );
  };

  /** Fork path: pick a source template to clone, then edit its fields before
   * creating the new type — mirrors `handleSelectType`'s transcript pattern
   * but lands on the "fields" editor instead of going straight to "title". */
  const handleForkType = (t: DatasetType) => {
    setStepError(null);
    setForkSourceId(t.id);
    setCustomTypeName(`${t.name} (fork)`);
    setCustomTypeDescription(t.description);
    setCustomFields(
      t.fields.length
        ? t.fields.map((f) => ({ ...blankField(), key: f.key, label: f.label, role: f.role, required: f.required !== false }))
        : [blankField(), blankField()]
    );
    setCreateTypeError(null);
    setWantsHarness(false);
    setHarnessNote("");
    const userTurn = `Fork template: ${t.name}`;
    const assistantTurn = `Cloned ${t.name}'s ${t.fields.length} field${t.fields.length === 1 ? "" : "s"}. Edit them below, then continue.`;
    addMessage("user", userTurn);
    addMessage("assistant", assistantTurn);
    setStep("fields");
    persist({ pathChoice: "fork", step: "fields" }, [
      { role: "u", text: userTurn },
      { role: "a", text: assistantTurn },
    ]);
  };

  const updateCustomField = (id: number, patch: Partial<EditableField>) => {
    setCustomFields((prev) => prev.map((f) => (f._id === id ? { ...f, ...patch } : f)));
  };
  const removeCustomField = (id: number) => {
    setCustomFields((prev) => (prev.length <= 2 ? prev : prev.filter((f) => f._id !== id)));
  };
  const addCustomField = () => setCustomFields((prev) => [...prev, blankField()]);

  /** Creates the fork/custom dataset type for real via the already-built,
   * previously-unused `POST /v1/planner/dataset-types/requests` (services/
   * planner.ts — deterministic, no LLM dependency), then continues the
   * planner against it exactly as `handleSelectType` does for a catalog pick.
   * Status lands as `platform_review`: same admin-review gate an existing
   * catalog type already went through, not a new bypass. */
  const handleCreateCustomType = async () => {
    const name = customTypeName.trim();
    const description = customTypeDescription.trim();
    const fields = customFields
      .map((f) => ({ key: f.key.trim(), label: f.label.trim(), role: f.role, required: f.required }))
      .filter((f) => f.key && f.label);

    if (name.length < 3) {
      setCreateTypeError("Give this dataset type a name of at least 3 characters.");
      return;
    }
    if (description.length < 3) {
      setCreateTypeError("Describe what this dataset type is for.");
      return;
    }
    if (fields.length < 2) {
      setCreateTypeError("Add at least 2 fields with both a key and a label.");
      return;
    }
    const keys = new Set(fields.map((f) => f.key));
    if (keys.size !== fields.length) {
      setCreateTypeError("Field keys must be unique.");
      return;
    }
    const trimmedHarnessNote = harnessNote.trim();
    if (wantsHarness && trimmedHarnessNote.length < 1) {
      setCreateTypeError("Describe what the execution harness should check, or turn the toggle off.");
      return;
    }

    setCreatingType(true);
    setCreateTypeError(null);
    try {
      const res = await authedFetch(API.planner.datasetTypeRequests, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          fields,
          ...(forkSourceId ? { forkedFromTypeId: forkSourceId } : {}),
          ...(wantsHarness && trimmedHarnessNote ? { harnessNote: trimmedHarnessNote } : {}),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(safeMessage(err.message, "Could not create this dataset type."));
      }
      const body = (await res.json()) as {
        datasetType: {
          id: string;
          version: number;
          domain: string;
          name: string;
          description: string;
          status: string;
          origin: string;
          category: string;
          trustTier: string;
          fields: { key: string; label: string; role: string; required: boolean }[];
          verification: { pipeline: string[]; dedupeFields: string[]; auditOptions: number[]; executionEnv?: string };
          difficultyLevels?: string[];
        };
      };
      const created = body.datasetType;
      const asType = created as unknown as DatasetType;
      setSelectedType(asType);
      setDatasetTypeId(created.id);
      setDatasetTypeName(created.name);
      markAnswered("template");
      markAnswered("fields");
      // A freshly drafted custom/forked type sits in platform_review, which
      // `POST /v1/planner/assist` refuses for `intent: "title"`. Clear any
      // prior type's ideas AND the error flag, so the title step shows the
      // "once this template is approved" note rather than a retry that would
      // only 400 again.
      resetTitleSuggestions();
      // The description intent is NOT refused for a type under review — it
      // answers with deterministic starters marked `source: "fallback"` — so
      // this clears the previous type's starters purely so the description
      // step re-fetches against the type just created.
      resetDescriptionSuggestions();
      const userTurn = forkSourceId ? `Forked dataset type "${created.name}"` : `Defined custom dataset type "${created.name}"`;
      const assistantTurn = `Created and queued for platform review: ${created.name} (${fields.length} field${fields.length === 1 ? "" : "s"}).${
        wantsHarness && trimmedHarnessNote
          ? " Your execution-harness request was attached for the reviewing admin — an admin authors and verifies the actual harness before it runs."
          : ""
      } It will need admin approval before your request can go live, same as any new type. What is the working title for your dataset?`;
      addMessage("user", userTurn);
      addMessage("assistant", assistantTurn);
      setStep("title");
      persist(
        { category: created.id, datasetTypeId: created.id, datasetTypeName: created.name, step: "title" },
        [{ role: "u", text: userTurn }, { role: "a", text: assistantTurn }]
      );
    } catch (err) {
      setCreateTypeError(err instanceof Error ? err.message : "Could not create this dataset type.");
    } finally {
      setCreatingType(false);
    }
  };

  const handleSetTitle = (val: string): boolean => {
    const trimmed = val.trim();
    const problem = titleProblem(trimmed);
    if (problem) {
      setStepError(problem);
      return false;
    }
    setStepError(null);
    setTitle(trimmed);
    markAnswered("title");
    const assistantTurn =
      "Now describe the specification in more detail. What kinds of problems or scenarios should contributors solve?";
    addMessage("user", trimmed);
    addMessage("assistant", assistantTurn);
    setStep("description");
    persist({ title: trimmed, step: "description" }, [
      { role: "u", text: trimmed },
      { role: "a", text: assistantTurn },
    ]);
    return true;
  };

  const handleSetDescription = (val: string): boolean => {
    const trimmed = val.trim();
    const problem = descriptionProblem(trimmed);
    if (problem) {
      setStepError(problem);
      return false;
    }
    setStepError(null);
    setDescription(trimmed);
    markAnswered("description");
    addMessage("user", trimmed);

    // Two kinds of template never reach the language step (V1 page.tsx:4830-4855):
    //   none  — no executable fields at all, so there is no language to target.
    //   fixed — the contract permits exactly ONE language, so asking would be a
    //           question with a single valid answer. State it in the transcript
    //           and fill it in, rather than asking and then having the LLM field
    //           guard reject everything else.
    if (!languageDecision.required) {
      const assistantTurn = "This template has no code fields, so there is no language to set. How many total verified items do you need in the dataset?";
      addMessage("assistant", assistantTurn);
      setStep("items");
      persist({ description: trimmed, step: "items" }, [
        { role: "u", text: trimmed },
        { role: "a", text: assistantTurn },
      ]);
      return true;
    }
    if (languageDecision.mode === "fixed") {
      const only = languageDecision.choices[0]!;
      setLanguage(only.label);
      setFramework("");
      markAnswered("language");
      const assistantTurn =
        (only.status === "unverifiable"
          ? `This template is ${only.label}-only, so that's the language. Note: ${only.reason}.`
          : `This template is ${only.label}-only — its verification harness runs ${only.label}, so I've set that for you.`) +
        " How many total verified items do you need in the dataset?";
      addMessage("assistant", assistantTurn);
      setStep("items");
      // The contract-derived language is persisted here, which is also what
      // corrects a resumed draft that holds a language this template cannot
      // verify (see the override in `restoreFrom`).
      persist({ description: trimmed, language: only.label, step: "items" }, [
        { role: "u", text: trimmed },
        { role: "a", text: assistantTurn },
      ]);
      return true;
    }

    const assistantTurn = "Which programming language or technical domain is this targeted at?";
    addMessage("assistant", assistantTurn);
    setStep("language");
    persist({ description: trimmed, step: "language" }, [
      { role: "u", text: trimmed },
      { role: "a", text: assistantTurn },
    ]);
    return true;
  };

  const handleSetLanguage = (raw: string): boolean => {
    const { language: typedLang, framework: fw, problem } = languageParts(raw);
    if (problem) {
      setStepError(problem);
      return false;
    }
    /**
     * A typed answer is held to the same contract as a chip.
     *
     * This handler checked only length, so a free-text language went through
     * untouched whatever the template declared. Typing "Haskell" on
     * `code_translation` — a `choice` template declaring 10 languages, with
     * `trustTier: execution_verified` — was accepted, persisted and minted,
     * which makes that trust badge false: nothing in the pipeline can execute
     * Haskell for that type. The chips were already filtered to the declared
     * set (`resolveLanguage`), so the composer was the one way around it.
     *
     *   choice  — the template declares exactly which languages its
     *             verification can run. Anything else is not a preference, it
     *             is a language the template cannot verify. Reject, and name
     *             the permitted set rather than making the sponsor guess.
     *   fixed   — the contract wins. The walk answers this from the contract
     *             and never asks, so this is unreachable in normal flow; it is
     *             here so a resumed draft or a stale composer cannot write over
     *             a single-language contract either.
     *   any     — the template genuinely constrains nothing. Free text stands.
     *   unknown — the catalog said NOTHING about languages. That must stay
     *             "keep asking" and keep accepting free text: narrowing it
     *             would mean enforcing a contract the server never sent, which
     *             is the fabrication `resolveLanguage` exists to avoid.
     */
    const constrained = languageDecision.mode === "choice" || languageDecision.mode === "fixed";
    const declared = constrained
      ? languageDecision.choices.find(
          (c) =>
            c.label.toLowerCase() === typedLang.toLowerCase() ||
            c.id.toLowerCase() === typedLang.toLowerCase()
        )
      : undefined;
    if (constrained && !declared) {
      const permitted = languageDecision.choices.map((c) => c.label);
      setStepError(
        languageDecision.mode === "fixed"
          ? `This template only verifies ${permitted[0] ?? "one language"}, so that is the language for every item.`
          : `${typedLang} isn't a language this template can verify. Pick one of: ${permitted.join(", ")}.`
      );
      return false;
    }
    // The contract's own spelling, so a typed "typescript" and the chip persist
    // the identical value the API and the item forms match on.
    const resolvedLang = declared ? declared.label : typedLang;
    setStepError(null);
    setLanguage(resolvedLang);
    setFramework(fw);
    markAnswered("language");
    const userTurn = fw ? `${resolvedLang} · ${fw}` : resolvedLang;
    const assistantTurn = "How many total verified items do you need in the dataset?";
    addMessage("user", userTurn);
    addMessage("assistant", assistantTurn);
    setStep("items");
    persist({ language: resolvedLang, ...(fw ? { framework: fw } : {}), step: "items" }, [
      { role: "u", text: userTurn },
      { role: "a", text: assistantTurn },
    ]);
    return true;
  };

  const handleSetItems = (count: number): boolean => {
    setStepError(null);
    setTargetItems(count);
    markAnswered("items");
    const userTurn = `${count.toLocaleString()} items`;
    const assistantTurn = "What difficulty mix should contributors target across these items?";
    addMessage("user", userTurn);
    addMessage("assistant", assistantTurn);
    setStep("difficulty");
    persist({ targetItems: count, step: "difficulty" }, [
      { role: "u", text: userTurn },
      { role: "a", text: assistantTurn },
    ]);
    return true;
  };

  const handleSetDifficulty = (key: string, label: string): boolean => {
    setStepError(null);
    setDifficultyMix(key);
    markAnswered("difficulty");
    const assistantTurn = "How much validator audit coverage should run after automated verification?";
    addMessage("user", label);
    addMessage("assistant", assistantTurn);
    setStep("audit");
    persist({ difficultyMix: key, step: "audit" }, [
      { role: "u", text: label },
      { role: "a", text: assistantTurn },
    ]);
    return true;
  };

  const handleSetAudit = (pct: number, label: string): boolean => {
    setStepError(null);
    setAuditCoveragePct(pct);
    markAnswered("audit");
    const assistantTurn = "Under which open license will the accepted dataset be published?";
    addMessage("user", label);
    addMessage("assistant", assistantTurn);
    setStep("license");
    persist({ auditCoveragePct: pct, step: "license" }, [
      { role: "u", text: label },
      { role: "a", text: assistantTurn },
    ]);
    return true;
  };

  const handleSetLicense = (lic: string, label: string): boolean => {
    setStepError(null);
    setLicense(lic);
    markAnswered("license");
    const assistantTurn = `Attach at least ${sampleGate.min} reference examples so reviewers and contributors understand the exact structure and quality bar.`;
    addMessage("user", label);
    addMessage("assistant", assistantTurn);
    setStep("samples");
    persist({ proposedLicense: lic, step: "samples" }, [
      { role: "u", text: label },
      { role: "a", text: assistantTurn },
    ]);
    return true;
  };

  const handleAddSampleFiles = async (files: File[]) => {
    const plannerSessionId = sessionIdRef.current;
    // A sponsor_reference artifact is parked on the draft session and carried
    // forward by the server (plannerSession -> datasetRequest -> bounty). With
    // no session there is no owner to park it on, and the upload would strand
    // an artifact nothing can ever reach — so refuse rather than orphan it.
    if (!plannerSessionId) {
      setSampleError("Your draft isn't saved yet, so examples can't be attached. Reload and try again.");
      return;
    }
    // Checked before any bytes move, and for the whole pick rather than
    // per-file, so a bad choice in a multi-file selection does not half-upload.
    // The picker's `accept` only constrains the browser's file dialog; this is
    // the check a drag-drop or an "All files" dialog cannot walk past.
    for (const file of files) {
      const violation = sampleAcceptViolation(file, sampleContract.accept, sampleContract.label);
      if (violation) {
        setSampleError(violation);
        return;
      }
    }
    setSampleBusy(true);
    setSampleError(null);
    try {
      for (const file of files) {
        const artifact = await uploadArtifact(
          file,
          { kind: "sponsor_reference", plannerSessionId },
          // Name the file. The server's declaration errors are lowercase
          // fragments with no filename in them, and a multi-file pick gives the
          // sponsor no way to tell which one the message is about.
          (message) => setSampleError(`${file.name}: ${message}`)
        );
        if (artifact) {
          setSamples((prev) => [...prev, artifact]);
        }
      }
    } finally {
      setSampleBusy(false);
    }
  };

  const handleRemoveSample = async (id: string) => {
    setSampleBusy(true);
    try {
      const ok = await deleteArtifact(id);
      if (ok) {
        setSamples((prev) => prev.filter((s) => s.id !== id));
      }
    } finally {
      setSampleBusy(false);
    }
  };

  const handleContinueToReview = () => {
    if (samples.filter(occupiesSampleSlot).length < sampleGate.min) {
      setStepError(
        `Upload at least ${sampleGate.min} reference sample${sampleGate.min === 1 ? "" : "s"} to continue.`
      );
      return;
    }
    setStepError(null);
    markAnswered("samples");
    const userTurn = "Examples attached. Review specification.";
    const assistantTurn =
      "Here is your completed community dataset request. Review the spec and submit for platform review.";
    addMessage("user", userTurn);
    addMessage("assistant", assistantTurn);
    setStep("review");
    persist({ step: "review" }, [
      { role: "u", text: userTurn },
      { role: "a", text: assistantTurn },
    ]);
  };

  const handleSubmitRequest = async () => {
    if (submitting) return;
    /**
     * Defence in depth, over EVERY asked step rather than three of them.
     *
     * The payload below substitutes a generated title and a generic
     * description when either is empty, which is only safe if the sponsor
     * genuinely answered those steps — but title and description were never
     * the whole risk. This guard checked only `template`/`title`/`description`,
     * so a spec could leave here carrying a `difficultyMix` and a `language`
     * answered against a template that had since been swapped out, which is
     * precisely how `api_function_calling` + `mostly_advanced` reached the
     * database (see `TEMPLATE_DEPENDENT_STEPS`).
     *
     * `pendingAnswers` is that check, shared with the submit button and the
     * review screen's readiness claim so none of the three can drift.
     */
    if (pendingAnswers.length > 0) {
      setStepError(
        `Answer ${pendingAnswers.join(", ")} for this template before submitting your request.`
      );
      // A panel edit may still have the return-to-review armed. The sponsor is
      // being sent back INTO the walk, so it must not fire on their next
      // answer and teleport them straight back here.
      editingStepRef.current = null;
      setStep(pendingAnswers[0]!);
      return;
    }
    if (samples.filter(occupiesSampleSlot).length < sampleGate.min) {
      setStepError(
        `Upload at least ${sampleGate.min} reference sample${sampleGate.min === 1 ? "" : "s"} before submitting.`
      );
      setStep("samples");
      return;
    }
    setStepError(null);
    setSubmitting(true);
    try {
      const id = sessionIdRef.current;

      // Flush the final state before finalizing. `finalize` builds the
      // DatasetRequest from what is STORED on the session, not from a body,
      // so anything not yet persisted would silently not make it into the
      // request. Awaited (unlike the per-step autosaves) precisely because
      // submission depends on it.
      if (id) {
        persist({
          category: datasetTypeId,
          datasetTypeId,
          datasetTypeName,
          title: title || `${datasetTypeName} Dataset`,
          description: description || "Community requested dataset.",
          // The decision, not the raw state: a `fixed` template's contract wins
          // over a stale stored answer, and a `none` template has no language.
          language: languageDecision.required ? languageDecision.value || "Any" : "Any",
          framework: languageDecision.required ? framework || undefined : undefined,
          targetItems,
          difficultyMix,
          auditCoveragePct,
          proposedLicense: license,
          step: "review",
        });
        await saveChainRef.current;
      }

      // Finalize through the session when there is one: it marks the draft
      // `completed` (so the next visit starts fresh instead of resuming a
      // draft that was already submitted), is idempotent on replay via
      // `PlannerSession.createdBounty`, and writes a
      // `planner_session.finalized` audit-log row. Falling back to the direct
      // create endpoint keeps submission working if the draft never started.
      const res = id
        ? await authedFetch(API.planner.sessionFinalize(id), { method: "POST" })
        : await authedFetch(API.community.requests, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              datasetTypeId,
              title: title || `${datasetTypeName} Dataset`,
              description: description || "Community requested dataset.",
              domain: selectedType?.domain ?? "coding",
              language: languageDecision.required ? languageDecision.value || "Any" : "Any",
              framework: languageDecision.required ? framework || undefined : undefined,
              targetItems,
              difficultyMix,
              auditCoveragePct,
              proposedLicense: license,
            }),
          });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(safeMessage(err.message, "Could not submit request."));
      }

      const body = (await res.json()) as { request: { id: string } };
      pushToast({ variant: "success", title: "Dataset request submitted!", body: "Our reviewers will evaluate it shortly." });
      router.push(`/sponsor/requests/${body.request.id}?from=community`);
    } catch (err) {
      // A failed submit is reported on the same inline surface every step's
      // validation uses (V1 page.tsx:5056), not as a toast that vanishes while
      // the review step is still sitting there un-submitted.
      setStepError(err instanceof Error ? err.message : "Could not submit request.");
    } finally {
      setSubmitting(false);
    }
  };

  const activeSamplesCount = samples.filter(occupiesSampleSlot).length;

  /** The file types the SERVER will accept for a sample under this template,
   * derived from its own contract rather than hardcoded — see `sampleAccept`. */
  const sampleContract = sampleAccept(selectedType);

  /** Which answers never got an AI review, in walk order, for the review-step
   * notice. */
  const unreviewedFields = (["title", "description", "language"] as const).filter(
    (f) => aiReviewUnavailable[f]
  );

  /* ---------------- planner chrome (V1 sponsor-planner parity) ------------- */

  const [draft, setDraft] = useState("");
  const [showStartOverConfirm, setShowStartOverConfirm] = useState(false);
  const [startingOver, setStartingOver] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  /** Set right before a starter chip overwrites `draft` programmatically, so
   * the layout effect below knows to move focus/caret. A plain typed edit
   * never sets this, so normal typing is left entirely alone. */
  const caretToEndPendingRef = useRef(false);

  /** Starter chips (description step) fill the composer rather than
   * answering the step outright — see the "why we ask" copy: "pick a
   * starter, then edit it". Setting `draft` alone is not enough: on a
   * browser that leaves the textarea focused through the chip's click (its
   * caret stays wherever it last was — position 0 on a still-empty box),
   * the browser preserves that caret position across the programmatic value
   * change instead of moving it to the end of the new text. The starter
   * LOOKS like it did nothing, and the sponsor's next keystroke lands at the
   * old caret offset — i.e. spliced into the middle of the starter's own
   * sentence — rather than appending after it. Explicitly focusing and
   * moving the caret to the end below is what "fill the box, then edit it"
   * actually requires. (C14) */
  const applyStarter = useCallback((starter: string) => {
    caretToEndPendingRef.current = true;
    setDraft(starter);
  }, []);

  useLayoutEffect(() => {
    if (!caretToEndPendingRef.current) return;
    caretToEndPendingRef.current = false;
    const el = composerRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [draft]);
  /** Set while the sponsor is re-answering one step from the spec panel, so the
   * next answer returns to review instead of re-walking the whole tail. */
  const editingStepRef = useRef<CommunityStep | null>(null);

  // `fieldChecking` belongs here: while the field guard is deciding, the
  // step's own chips must not accept a second answer that would race the first.
  const controlsBusy = submitting || startingOver || creatingType || fieldChecking;

  const stepIndex =
    step === "review" ? askedSteps.length : Math.max(1, askedSteps.indexOf(step) + 1);
  // Counts steps genuinely passed, not screens visited. Several answers carry
  // real defaults (500 items, balanced mix, 25% audit, CC-BY-4.0), so testing
  // them for truthiness would report them decided before the sponsor ever saw
  // the question. Position in the walk is the honest signal: the walk only
  // advances on an accepted answer.
  // Counts steps genuinely answered. Position-in-walk was the previous signal;
  // it rewound the bar to ~20% whenever the sponsor re-opened one row from the
  // panel, contradicting the rows that still showed their answers.
  const answeredCount = askedSteps.filter((s) => answered[s]).length;

  // Offered as soon as the sponsor has answered anything. Deliberately not
  // gated on a live session id: `handleStartOver` copes with a null id, and
  // reading a ref during render is both a lint error and a stale read.
  const canStartOver = step !== "template" && !submitting;

  // Audit choices come from the template's own allowlist when it declares one;
  // the hardcoded 0/25/100 is only a fallback. A template that permits e.g.
  // 10% or 50% would otherwise be offered three coverages it does not allow.
  const auditOptions = (() => {
    const declared = selectedType?.verification?.auditOptions;
    if (!declared || declared.length === 0) return AUDIT_OPTIONS;
    return declared.map((pct) => ({
      pct,
      // Same wording as AUDIT_OPTIONS above (V1 page.tsx:145, :289-291), just
      // with the template's own percentage substituted in.
      label:
        pct === 0
          ? "Automated checks only — 0%"
          : pct === 100
            ? "Full validator audit — 100%"
            : `Partial validator audit — ${pct}%`,
      // The 1-99% hint deliberately does not claim a sample is drawn — see
      // AUDIT_OPTIONS's doc comment above for why: coverage sampling of
      // clean items is dead code today (every cleared item is a forced
      // escalation), so any nonzero pick behaves like 100%.
      hint:
        pct === 0
          ? "no validator-audit allocation"
          : pct === 100
            ? "every item receives validator audit"
            : "today: every cleared item still gets a full validator review — this % isn't applied yet",
    }));
  })();

  const isFreeTextStep =
    step === "title" || step === "description" || step === "language" || step === "items";

  const composerPlaceholder = (() => {
    switch (step) {
      case "title":
        return "e.g. Python async bug fixes with failing tests";
      case "description":
        return "What goes in each item, what to avoid, what good looks like…";
      case "language":
        return "Pick a language above, or type one…";
      case "items":
        return "Or type a number…";
      case "review":
        return "Send to submit for review…";
      default:
        return "Pick an option above to continue…";
    }
  })();

  // `titleSuggestionsLoading` gates sending as it does in v1 (page.tsx:5156):
  // the composer and the send button must agree, and answering the title while
  // its ideas are still resolving would strand a request mid-flight against a
  // step the sponsor has already left. It only ever holds for the duration of
  // one assist call — a failed or empty result unblocks immediately and leaves
  // manual entry as the answer path.
  const canSend =
    step === "review"
      ? !controlsBusy
      : isFreeTextStep && !controlsBusy && !titleSuggestionsLoading && draft.trim().length > 0;

  /**
   * Single commit path for every answer, whether it came from a chip or the
   * composer. Runs the step's own handler and only then reacts to the outcome:
   * a rejected answer leaves the composer text alone so it can be fixed, and
   * an accepted one clears the box and — if the sponsor got here by clicking
   * `edit` in the spec panel — jumps straight back to review instead of
   * re-walking the whole tail of the planner.
   *
   * Both of those used to be `useEffect`s keyed on `step`, which is a
   * cascading-render pattern this codebase's lint rules reject; doing it in the
   * event handler is also the only version that can tell an accepted answer
   * from a rejected one.
   */
  const answerWith = (run: () => boolean) => {
    const accepted = run();
    if (!accepted) return;
    setDraft("");
    const editedStep = editingStepRef.current;
    if (!editedStep) return;
    editingStepRef.current = null;

    /**
     * Return to review only when the spec is actually complete.
     *
     * `pendingAnswers` is from the render that produced this click, so the step
     * just answered is subtracted by hand — `answered` has not re-rendered yet.
     *
     * Two outcomes, and the distinction is the fix: if the earliest still-
     * unanswered step sits BEHIND the one just edited in walk order, the
     * natural forward walk can never reach it, so go there. That is the case a
     * template change creates — `title` and `description` are cleared, the
     * sponsor edits `license` from the panel, and returning to review here
     * showed "Ready for submission" with submit enabled for a spec missing
     * both. If everything outstanding is still AHEAD, the handler's own next
     * step already leads there and overriding it would skip questions.
     */
    const outstanding = pendingAnswers.filter((s) => s !== editedStep);
    const behind = outstanding.find((s) => UI_STEPS.indexOf(s) < UI_STEPS.indexOf(editedStep));
    if (behind) {
      setStep(behind);
      addMessage("assistant", `Let's revisit that. ${PANEL_EDIT_PROMPT[behind] ?? "Pick a new answer."}`);
      persist({ step: behind });
      return;
    }
    if (outstanding.length > 0) return;

    setStep("review");
    // The handler already persisted its own natural next step; without this
    // the saved draft still says e.g. `description`, so a reload dropped the
    // sponsor back there and made them re-walk answers the panel already
    // showed as decided.
    persist({ step: "review" });
  };

  /**
   * Entry-time LLM sanity check for a hand-typed free-text answer
   * (`POST /v1/planner/assist`, `intent: "validate_field"`). Catches
   * "asdasdasd" as it is typed rather than letting an admin reviewer discover
   * it days later — V1 calls it at the same point (page.tsx:4696-4715).
   *
   * Advisory by construction: it never rewrites the value and never mutates
   * anything. Three outcomes, and the difference between the last two is a
   * trust claim, not a detail:
   *
   *   "ok"          — a model reviewed it and passed it.
   *   "reject"      — a model reviewed it and rejected it. Show its reason.
   *   "unavailable" — NO model reviewed it (`source: "fallback"`, or the call
   *                   failed outright). Says nothing whatsoever about the
   *                   value, so it must never be rendered as a rejection.
   */
  const checkField = async (field: PlannerGuardField, value: string): Promise<"ok" | "reject" | "unavailable"> => {
    setFieldChecking(true);
    try {
      const res = await authedFetch(API.planner.assist, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: "validate_field",
          field,
          value,
          // Sharpens the model's on-topic judgement. Omitted for a type the
          // catalog doesn't have (a fresh custom/forked draft), which the
          // server tolerates — it simply drops the context.
          ...(catalogTypes.some((t) => t.id === datasetTypeId) ? { datasetTypeId } : {}),
        }),
      });
      if (!res.ok) return "unavailable";
      const verdict = (await res.json()) as { ok?: boolean; reason?: string; source?: "llm" | "fallback" };
      if (verdict.ok === true) return "ok";
      // Anything the server does not explicitly mark `llm` is treated as "no
      // model answered". Collapsing the two would turn an outage into an
      // accusation about the sponsor's text.
      if (verdict.source !== "llm") return "unavailable";
      setStepError(
        safeMessage(verdict.reason, "That needs another look — try a more specific answer.")
      );
      return "reject";
    } catch {
      return "unavailable";
    } finally {
      setFieldChecking(false);
    }
  };

  /**
   * Commit one free-text answer through the guard.
   *
   * Order matters: the step's own bounds run FIRST, so a too-short title gets
   * its precise error instead of a model's opinion and costs no assist call.
   *
   * An "unavailable" verdict does NOT block. The guard is advisory and carries
   * no information about the value in that case, so blocking would block
   * legitimate good-faith answers — and, with no model configured, would make
   * it impossible to create any request at all. The answer is accepted and
   * `aiReviewUnavailable` records that it was never AI-reviewed, which the step
   * and the review panel both state plainly.
   */
  const answerGuarded = async (
    field: PlannerGuardField,
    value: string,
    boundsProblem: string | null,
    run: () => boolean
  ) => {
    if (fieldChecking || controlsBusy) return;
    if (boundsProblem) {
      setStepError(boundsProblem);
      return;
    }
    const verdict = await checkField(field, value);
    if (verdict === "reject") return;
    setAiReviewUnavailable((prev) => {
      if (verdict === "unavailable") return prev[field] ? prev : { ...prev, [field]: true };
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    answerWith(run);
    if (verdict === "unavailable") {
      // Said in the transcript, after the handler's own turns, because the step
      // has just advanced: the note rendered above the step's options would be
      // for a step the sponsor has already left, so they would never see it.
      // Deliberately NOT persisted — it describes a transient outage, and a
      // resumed draft must not keep asserting "never reviewed" once review
      // works again. The review step re-derives the same notice from
      // `aiReviewUnavailable` for as long as it holds this session.
      addMessage(
        "assistant",
        `Heads up: AI review was not available, so your ${field} has not been checked. It is saved either way — a reviewer reads your request before it is approved.`
      );
    }
  };

  const answerTitle = (value: string) => {
    const trimmed = value.trim();
    return answerGuarded("title", trimmed, titleProblem(trimmed), () => handleSetTitle(trimmed));
  };
  const answerDescription = (value: string) => {
    const trimmed = value.trim();
    return answerGuarded("description", trimmed, descriptionProblem(trimmed), () =>
      handleSetDescription(trimmed)
    );
  };
  const answerLanguage = (raw: string) => {
    const parts = languageParts(raw);
    // The LANGUAGE is what the guard judges; the optional framework suffix
    // rides along untouched, exactly as the handler splits it.
    return answerGuarded("language", parts.language, parts.problem, () => handleSetLanguage(raw));
  };

  /** One send path for every step. Free-text steps hand the box's contents to
   * the same handler the option chips use, so validation and persistence stay
   * in one place per step. */
  const send = () => {
    if (!canSend) return;
    if (step === "review") {
      void handleSubmitRequest();
      return;
    }
    const text = draft.trim();
    setStepError(null);
    switch (step) {
      case "title":
        void answerTitle(text);
        return;
      case "description":
        void answerDescription(text);
        return;
      case "language":
        void answerLanguage(text);
        return;
      case "items": {
        // Do not let JavaScript's permissive Number() parser turn "1e3",
        // "0x10", a decimal or arbitrary whitespace into an item count. Whole
        // decimal numbers only; conventional thousands commas are the one
        // formatting exception (V1 page.tsx:4880-4895).
        const hasValidThousandsSeparators = /^\d{1,3}(?:,\d{3})+$/.test(text);
        const hasPlainDigits = /^\d+$/.test(text);
        if (!hasPlainDigits && !hasValidThousandsSeparators) {
          setStepError("Enter a whole number only, for example 250 or 2,500.");
          return;
        }
        const parsed = Number(text.replaceAll(",", ""));
        // The floor is 10, not V1's 1: the server's
        // `answersSchema.targetItems` is `int().min(10)` and `validateAnswers`
        // repeats it, so quoting 1 here would accept a value that then fails
        // autosave with a bare "couldn't save your progress" and loses the turn.
        if (!Number.isInteger(parsed) || parsed < 10 || parsed > 100_000) {
          setStepError("Give a whole number of items between 10 and 100,000.");
          return;
        }
        answerWith(() => handleSetItems(parsed));
        return;
      }
      // The option steps below are selection-only — the composer is disabled
      // on them, exactly as V1's `selectionOnly` disables its own
      // (page.tsx:5139). These branches are the same defensive guards V1
      // carries behind that lock: they accept V1's "1"/exact-label answers and
      // otherwise name the step, so the single error surface stays correct if
      // the box is ever opened here.
      case "difficulty": {
        const byIndex = /^\d+$/.test(text) ? difficultyOptions[Number(text) - 1] : undefined;
        const match =
          byIndex ??
          difficultyOptions.find(
            (o) => o.label.toLowerCase() === text.toLowerCase() || o.key === text.toLowerCase()
          );
        if (!match) {
          setStepError("Pick one of the difficulty mixes above.");
          return;
        }
        answerWith(() => handleSetDifficulty(match.key, match.label));
        return;
      }
      case "audit": {
        const byIndex = /^\d+$/.test(text) ? auditOptions[Number(text) - 1] : undefined;
        const match = byIndex ?? auditOptions.find((o) => o.label.toLowerCase() === text.toLowerCase());
        if (!match) {
          setStepError("Pick one of the coverage levels above.");
          return;
        }
        answerWith(() => handleSetAudit(match.pct, match.label));
        return;
      }
      case "license": {
        const byIndex = /^\d+$/.test(text) ? LICENSE_OPTIONS[Number(text) - 1] : undefined;
        const match =
          byIndex ??
          LICENSE_OPTIONS.find(
            (o) => o.label.toLowerCase() === text.toLowerCase() || o.value.toLowerCase() === text.toLowerCase()
          );
        if (!match) {
          setStepError("Pick one of the licences above.");
          return;
        }
        answerWith(() => handleSetLicense(match.value, match.label));
        return;
      }
      case "template": {
        const byIndex = /^\d+$/.test(text) ? catalogTypes[Number(text) - 1] : undefined;
        const match = byIndex ?? catalogTypes.find((t) => t.name.toLowerCase() === text.toLowerCase());
        if (!match) {
          setStepError("Pick one of the templates above, or type its name exactly.");
          return;
        }
        if (pathChoice === "fork") handleForkType(match);
        else handleSelectType(match);
        setDraft("");
        return;
      }
      case "samples":
        handleContinueToReview();
        return;
      default:
        return;
    }
  };

  /** Re-answer one step from the spec panel. */
  const enterEditStep = (target: CommunityStep) => {
    setStepError(null);
    setDraft("");
    // `template` deliberately does NOT arm the edit-return: picking a different
    // template re-runs the contract-dependent steps, and `handleSelectType`
    // sends the sponsor to `title` on purpose. Arming the ref there left it set
    // and later teleported them to review off an unrelated answer.
    editingStepRef.current = target === "template" ? null : target;
    setStep(target);
    addMessage("assistant", `Let's revisit that. ${PANEL_EDIT_PROMPT[target] ?? "Pick a new answer."}`);
  };

  const handleStartOver = async () => {
    setStartingOver(true);
    const id = sessionIdRef.current;
    try {
      if (id) await authedFetch(API.planner.session(id), { method: "DELETE" });
    } catch {
      // Best effort. A failed delete leaves an abandoned draft row the next
      // `sessions/active` read may offer again, which is recoverable; refusing
      // to reset the form because the server is unreachable is not.
    }
    // A reload is the honest reset: this planner's answers live across ~20
    // separate `useState` hooks plus three refs, and re-seeding them by hand is
    // exactly how one stale field survives a "start over".
    window.location.reload();
  };

  // Keep the newest turn in view. The transcript is its own bounded scroll
  // container now, so this pins it to the bottom (V1 page.tsx:4041) instead of
  // scrolling the page — `scrollIntoView` would move the nearest scrollable
  // ancestor and, below `lg`, drag the whole page.
  //
  // Observed rather than scheduled on a frame: V1's one-shot
  // `scrollTo({ behavior: "smooth" })` was measured as a no-op here, and even
  // a direct assignment on two nested frames still landed before the footer's
  // option list had settled — the transcript was briefly unclipped, the
  // browser clamped `scrollTop` to 0, and nothing re-ran. Re-pinning on every
  // size change covers that late layout pass. `stick` keeps it from fighting a
  // sponsor who has deliberately scrolled up to re-read an earlier answer.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    let stick = true;
    const pin = () => {
      if (stick) el.scrollTop = el.scrollHeight;
    };
    const onScroll = () => {
      stick = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(pin);
    observer.observe(el);
    // The bubbles too: the container's own box stops changing well before a
    // multi-line answer finishes reflowing inside it.
    for (const child of Array.from(el.children)) observer.observe(child);
    pin();
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [messages, step]);


  const specRows: { label: string; value: string | null; editKey?: CommunityStep }[] = [
    { label: "template", value: answered.template ? datasetTypeName || null : null, editKey: "template" },
    {
      label: "fields per item",
      value: answered.template && selectedType
        ? selectedType.fields
            .map((f) => (f.required ? f.label : `${f.label} (optional)`))
            .join(", ")
        : null,
    },
    // Gated on `answered`, not on the state holding the text. The state is
    // deliberately NOT blanked when a template change invalidates these (see
    // `TEMPLATE_DEPENDENT_STEPS` — blanking would discard the sponsor's words
    // before they have chosen to rewrite them), so testing the string meant
    // the panel kept rendering a title written for the PREVIOUS template as a
    // decision, filled dot and live `edit` included, while the "steps decided"
    // count above it had already dropped. One of those two was lying.
    { label: "title", value: answered.title ? title || null : null, editKey: "title" },
    {
      label: "description",
      value: answered.description ? description || null : null,
      editKey: "description",
    },
    // A `none` template drops the row entirely; a `fixed` one still STATES the
    // language (contributors need to know what they are building in) but offers
    // no edit affordance, because there is nothing to change (V1
    // page.tsx:5183-5190).
    ...(languageDecision.required
      ? [
          {
            label: "language",
            // Gated on `answered.language`, which covers BOTH cases: a `fixed`
            // template's language is a contract fact the panel should state
            // even though the sponsor is never asked, and the walk marks it
            // answered from the contract (`handleSetDescription`'s fixed
            // branch), as does `restoreFrom` for a resumed draft.
            //
            // It cannot be gated on `answered.template` instead. `selectedType`
            // is seeded to the first catalog type before any pick, so an
            // ungated row asserted "TypeScript" on the very first screen; and
            // after a template change the previous template's language survives
            // in state on purpose, so `answered.template` alone re-asserted a
            // language the new contract may not verify at all.
            value: !answered.language
              ? null
              : languageDecision.value
                ? framework
                  ? `${languageDecision.value} · ${framework}`
                  : languageDecision.value
                : null,
            ...(languageDecision.asked || languageDecision.mode === "unknown"
              ? { editKey: "language" as CommunityStep }
              : {}),
          },
        ]
      : []),
    { label: "item count", value: answered.items ? targetItems.toLocaleString() : null, editKey: "items" },
    {
      label: "difficulty",
      // Looked up in the full list, not the type-filtered one: a resumed draft
      // can legitimately hold a mix the template no longer permits, and the
      // panel must name it rather than fall through to the raw enum key.
      value: answered.difficulty
        ? DIFFICULTY_OPTIONS.find((o) => o.key === difficultyMix)?.label ?? difficultyMix
        : null,
      editKey: "difficulty",
    },
    { label: "audit coverage", value: answered.audit ? `${auditCoveragePct}%` : null, editKey: "audit" },
    { label: "license", value: answered.license ? license || null : null, editKey: "license" },
    {
      label: "reference samples",
      value:
        activeSamplesCount > 0
          ? `${activeSamplesCount} attached · min ${sampleGate.min}`
          : null,
      editKey: "samples",
    },

    {
      label: "review",
      value: step === "review" ? "Ready to submit" : null,
    },
  ];

  return (
    // V1's planner owns a bounded viewport column
    // (`lg:h-screen lg:overflow-hidden`, page.tsx:5237) so the transcript and
    // the spec panel each scroll inside their own card and the composer is
    // always reachable without scrolling the page. This is the same shape,
    // measured against the app shell's own vertical padding (`main` is
    // `py-6`, 24px top + 24px bottom) instead of V1's page-owned `px-8 py-7`.
    // Below `lg` the page scrolls and the chat card takes V1's fixed height,
    // exactly as V1 does (`max-lg:h-[calc(100dvh-150px)]`, page.tsx:5250).
    <div className="flex flex-col gap-5 lg:h-[calc(100dvh-48px)] lg:overflow-hidden">
      {/* Page header, matching the V1 sponsor planner: the subtitle tells the
          sponsor where their answers are going (the spec panel on the right)
          and that typing a free answer is a first-class option, not a
          fallback. */}
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="m-0 mb-[5px] font-mono text-[22px] font-bold text-ink">Create a dataset</h1>
          <p className="m-0 text-[13.5px] text-ink-soft">
            Answer a few questions — your spec builds on the right. Pick an option or type your own.
          </p>
        </div>
        {/* 129x16 measured at 640 — a text link, so only its height falls
            short. `TOUCH_TARGET` is applied here rather than inside `BackLink`
            so the other pages using it keep their current hit boxes until
            they have been measured too. */}
        <BackLink href="/sponsor" className={TOUCH_TARGET}>Back to sponsor</BackLink>
      </div>

      {/* Draft state. This notice is about persistence specifically, so it says
          what actually happened to the sponsor's answers rather than a generic
          error — a sponsor who has typed a long spec needs to know whether it
          is safe to close the tab. There is deliberately no companion "draft
          resumed" banner: V1 has none, and the resume notice is a transcript
          turn instead (see `RESUME_NOTE` above), which costs no vertical
          space. */}
      {draftError && (
        <div
          role="status"
          className="shrink-0 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-ink"
        >
          {draftError}
        </div>
      )}

      {/* `lg:[grid-template-rows:minmax(0,1fr)]` is what lets the two cards be
          bounded instead of content-sized — without it a `min-h-0` child of an
          `auto`-height grid row still stretches to its content (V1
          page.tsx:5248). */}
      <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[1.35fr_1fr] lg:[grid-template-rows:minmax(0,1fr)]">
        {/* Left: Conversational Transcript & Step Controls */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel max-lg:h-[calc(100dvh-150px)] max-lg:min-h-[440px]">
          {/* Card header. The step counter's denominator is `askedSteps`, not
              the raw step union, so a walk that skips the fork/custom field
              editor doesn't advertise a step it will never ask. */}
          <div className="flex shrink-0 items-center gap-2.5 border-b border-line bg-white px-5 py-3.5">
            <Brandmark size={28} />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[13px] font-bold text-ink">Dataset planner</div>
              <div className="font-mono text-[10px] text-ink-faint">drafts your spec as you talk</div>
            </div>
            {canStartOver && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowStartOverConfirm(true)}
                // 88x28.7 measured at 640. `TOUCH_TARGET` rides on the call
                // site, not on `Button size="sm"` itself — every small button
                // in the app would otherwise grow an invisible 44px box, and
                // in tighter rows those boxes would overlap and start
                // swallowing each other's taps.
                className={`mr-2 border-line-strong font-mono text-[11px] text-ink-soft hover:border-danger-strong hover:bg-white hover:text-danger-strong ${TOUCH_TARGET}`}
              >
                start over
              </Button>
            )}
            <span className="rounded-full bg-brand-soft px-2.5 py-1 font-mono text-[10px] text-ink-soft">
              step {Math.min(stepIndex, askedSteps.length)} / {askedSteps.length}
            </span>
          </div>
          <PlannerProgress value={askedSteps.length ? answeredCount / askedSteps.length : 0} />

          <div
            ref={transcriptRef}
            className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-[22px]"
          >
            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {/* `whitespace-pre-line`: several assistant prompts are
                    deliberately multi-line, and collapsing them loses the
                    structure the sponsor is meant to read. */}
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[80%] whitespace-pre-line break-words rounded-xl rounded-br-sm bg-brand px-[15px] py-3 text-sm leading-normal text-white"
                      : "max-w-[84%] whitespace-pre-line break-words rounded-xl rounded-bl-sm border border-line bg-white px-[15px] py-3 text-sm leading-normal text-ink"
                  }
                >
                  {m.text}
                </div>
              </div>
            ))}
          </div>

          {/* Answer options, then the composer — V1's two-part footer
              (page.tsx:5295). The card is a fixed-height `overflow-hidden`
              column, so the options block absorbs the pressure by scrolling
              and the composer row stays `shrink-0` and pinned to the bottom:
              a long option list eats upward into the chips instead of pushing
              the send button off the clipped edge of the card. */}
          <div className="flex min-h-0 flex-col border-t border-line bg-white p-[18px]">
            <div className="min-h-0 flex-1 overflow-y-auto">
              {stepError && (
                <p
                  role="alert"
                  className="mb-3 rounded-lg border border-danger-border bg-danger-soft px-3 py-2 font-mono text-[11px] text-danger-strong"
                >
                  {stepError}
                </p>
              )}

              {step !== "review" && <StepGuidance stepKey={step} />}

              {/* Guard in flight. Rendered as its own status line rather than
                  folded into the send button, because the chips are disabled
                  too and the sponsor needs to know why nothing responded. */}
              {fieldChecking && (
                <p
                  className="mb-3 flex items-center gap-2 font-mono text-[11px] text-ink-faint"
                  role="status"
                  aria-live="polite"
                >
                  <span
                    className="inline-block h-3 w-3 animate-spin rounded-full border border-line border-t-ink"
                    aria-hidden="true"
                  />
                  Checking your answer…
                </p>
              )}

              {/* The honest wording for a fail-closed guard with no model
                  behind it. It states what did NOT happen; it must never be
                  written as though the answer were rejected or suspect —
                  `source: "fallback"` carries no verdict about the value. */}
              {!fieldChecking && isGuardField(step) && aiReviewUnavailable[step] && (
                <p
                  role="status"
                  className="mb-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 font-mono text-[11px] text-ink"
                >
                  AI review was not available for this answer, so it has not been checked. It is
                  saved either way — a reviewer reads it before your request is approved.
                </p>
              )}
              {step === "template" && !pathChoice && (
                <PathChoiceCards
                  options={PATH_OPTIONS}
                  onPick={handleChoosePath}
                  disabled={controlsBusy}
                />
              )}

            {step === "template" && pathChoice && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="micro-label text-ink-soft">
                    {pathChoice === "fork" ? "select a template to fork" : "select catalog template"}
                  </div>
                  <button
                    type="button"
                    onClick={() => setPathChoice(null)}
                    className="font-mono text-xs text-ink-faint hover:text-ink"
                  >
                    change path
                  </button>
                </div>
                <div className="grid gap-2.5">
                  {catalogTypes.map((t, i) => {
                    const required = t.fields.filter((f) => f.required);
                    const optional = t.fields.filter((f) => !f.required);
                    const media = t.fields
                      .filter((f) => f.role === "file")
                      .map((f) => ({ label: f.label, accept: f.accept ?? "any file type" }));
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => (pathChoice === "fork" ? handleForkType(t) : handleSelectType(t))}
                        className={`flex flex-col items-start rounded-xl border p-4 text-left transition-all ${
                          datasetTypeId === t.id
                            ? "border-violet-500 bg-violet-50/50 shadow-sm"
                            : "border-line bg-white hover:border-ink"
                        }`}
                      >
                        <div className="mb-3 flex w-full items-start gap-3">
                          <span className="mt-0.5 shrink-0 rounded-md bg-brand-soft px-[7px] py-1 font-mono text-[11px] text-ink-soft">
                            {i + 1}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-xs font-bold text-ink">{t.name}</span>
                            <span className="mt-1 block text-[11.5px] leading-snug text-ink-soft">{t.description}</span>
                          </span>
                          <span className="shrink-0 rounded-full border border-line-soft bg-white px-2 py-0.5 font-mono text-[10px] text-ink-faint">
                            v{t.version}
                          </span>
                        </div>

                        <div className="grid w-full gap-2.5 sm:grid-cols-2">
                          <div>
                            <div className="mb-1 font-mono text-[10px] uppercase tracking-[.05em] text-ink-faint">
                              delivered item
                            </div>
                            <p className="m-0 text-[12px] leading-snug text-ink">
                              {t.fields.map((f) => f.label).join(", ")}
                            </p>
                          </div>
                          <div>
                            <div className="mb-1 font-mono text-[10px] uppercase tracking-[.05em] text-ink-faint">
                              you provide
                            </div>
                            <p className="m-0 text-[12px] leading-snug text-ink">
                              Reference examples, target contract, and acceptance criteria.
                            </p>
                          </div>
                        </div>

                        {media.length > 0 && (
                          <div className="mt-3 flex w-full flex-wrap items-center gap-1.5">
                            <span className="rounded-full bg-[#e6eefb] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[.04em] text-[#2f5597]">
                              media upload
                            </span>
                            {media.map((m) => (
                              <span
                                key={m.label}
                                className="rounded-full border border-line-soft bg-white px-2 py-0.5 font-mono text-[10px] text-ink-soft"
                              >
                                {m.label} · {m.accept}
                              </span>
                            ))}
                          </div>
                        )}

                        <div className="mt-3 flex w-full flex-wrap gap-1.5">
                          {pipelineWithPlatformStages(t.verification.pipeline, { llmEnabled }).map((check) => (
                            <span
                              key={check}
                              className="rounded-full bg-brand-soft px-2 py-0.5 font-mono text-[10px] text-[#5d6755]"
                            >
                              {stageLabel(check)}
                            </span>
                          ))}
                        </div>

                        <div className="mt-3 grid w-full gap-2.5 border-t border-line-soft pt-3 sm:grid-cols-2">
                          <div className="text-[12px] leading-snug">
                            <span className="font-mono text-[10px] uppercase tracking-[.05em] text-ink-faint">
                              required fields
                            </span>
                            <p className="m-0 mt-1 text-ink-soft">
                              {required.length ? required.map((f) => f.label).join(", ") : "none"}
                            </p>
                          </div>
                          <div className="text-[12px] leading-snug">
                            <span className="font-mono text-[10px] uppercase tracking-[.05em] text-ink-faint">
                              optional fields
                            </span>
                            <p className="m-0 mt-1 text-ink-soft">
                              {optional.length ? optional.map((f) => f.label).join(", ") : "none"}
                            </p>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {step === "fields" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="micro-label text-ink-soft">
                    {forkSourceId ? "edit forked fields" : "define custom schema"}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setStep("template");
                      // Fork came from the catalog grid; custom skipped it —
                      // send each path back to where it actually branched off.
                      if (!forkSourceId) setPathChoice(null);
                    }}
                    className="font-mono text-xs text-ink-faint hover:text-ink"
                  >
                    back
                  </button>
                </div>

                <input
                  type="text"
                  value={customTypeName}
                  onChange={(e) => setCustomTypeName(e.target.value)}
                  placeholder="Dataset type name, e.g. SQL Query Correctness"
                  className="w-full rounded-xl border border-line bg-white px-3.5 py-2 text-sm text-ink focus:border-ink focus:outline-none"
                />
                <textarea
                  value={customTypeDescription}
                  onChange={(e) => setCustomTypeDescription(e.target.value)}
                  rows={2}
                  placeholder="What does this dataset type check, and how?"
                  className="w-full rounded-xl border border-line bg-white p-3 text-sm text-ink focus:border-ink focus:outline-none"
                />

                <div className="space-y-2">
                  {customFields.map((f, i) => (
                    <div key={f._id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-white p-2.5">
                      <input
                        type="text"
                        value={f.key}
                        onChange={(e) => updateCustomField(f._id, { key: e.target.value })}
                        placeholder={`field_key_${i + 1}`}
                        className="w-32 rounded-lg border border-line bg-panel px-2.5 py-1.5 font-mono text-xs text-ink focus:border-ink focus:outline-none"
                      />
                      <input
                        type="text"
                        value={f.label}
                        onChange={(e) => updateCustomField(f._id, { label: e.target.value })}
                        placeholder="Field label"
                        className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-xs text-ink focus:border-ink focus:outline-none"
                      />
                      <select
                        value={f.role}
                        onChange={(e) => updateCustomField(f._id, { role: e.target.value })}
                        className="rounded-lg border border-line bg-panel px-2 py-1.5 font-mono text-[11px] text-ink focus:border-ink focus:outline-none"
                      >
                        {FIELD_ROLE_OPTIONS.map((r) => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                      <label className="flex items-center gap-1 font-mono text-[10px] text-ink-soft">
                        <input
                          type="checkbox"
                          checked={f.required}
                          onChange={(e) => updateCustomField(f._id, { required: e.target.checked })}
                        />
                        required
                      </label>
                      <button
                        type="button"
                        onClick={() => removeCustomField(f._id)}
                        disabled={customFields.length <= 2}
                        className="ml-auto text-ink-faint hover:text-danger-strong disabled:cursor-not-allowed disabled:opacity-30"
                        aria-label="Remove field"
                      >
                        <Icon name="x" size={14} />
                      </button>
                    </div>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={addCustomField}
                  className="inline-flex items-center gap-1.5 font-mono text-xs text-ink-soft hover:text-ink"
                >
                  <Icon name="plus" size={12} />
                  Add field
                </button>

                <div className="rounded-lg border border-line-soft bg-panel/60 p-3">
                  <label className="flex cursor-pointer items-start gap-2.5 text-xs text-ink">
                    <input
                      type="checkbox"
                      checked={wantsHarness}
                      onChange={(e) => setWantsHarness(e.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-line accent-[var(--color-brand)]"
                    />
                    <span>
                      <span className="font-semibold">Request sandboxed execution verification</span>
                      <span className="block text-[11px] leading-relaxed text-ink-soft">
                        Describe what a harness should check. An admin authors and verifies the real harness
                        before anything runs — this is a request, not code, and it never executes on its own.
                      </span>
                    </span>
                  </label>
                  {wantsHarness && (
                    <textarea
                      value={harnessNote}
                      onChange={(e) => setHarnessNote(e.target.value)}
                      rows={2}
                      placeholder="e.g. Run the submitted solution against the provided test cases in a Python 3.11 sandbox; pass only if all tests succeed."
                      className="mt-2.5 w-full rounded-lg border border-line bg-white p-2.5 text-xs text-ink focus:border-ink focus:outline-none"
                    />
                  )}
                </div>

                {createTypeError && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 font-mono text-xs text-rose-700">
                    {createTypeError}
                  </div>
                )}

                <div className="flex justify-end">
                  <Button size="sm" onClick={handleCreateCustomType} disabled={creatingType} aria-busy={creatingType}>
                    {creatingType ? "Creating…" : "Create dataset type & continue"}
                  </Button>
                </div>
              </div>
            )}

              {/* `title` is answered in the composer below — there is no
                  deterministic option list for it. What the step does offer is
                  real AI title ideas from `POST /v1/planner/assist`. They are
                  never load-bearing: every branch here leaves the sponsor free
                  to ignore them and type their own title. */}
              {step === "title" && (
                <div
                  className="mb-3.5 flex max-h-[38vh] flex-col gap-2 overflow-y-auto"
                  aria-disabled={controlsBusy || titleSuggestionsLoading}
                >
                  {titleSuggestionsLoading ? (
                    <p
                      className="flex items-center gap-2 font-mono text-[11px] text-ink-faint"
                      role="status"
                      aria-live="polite"
                    >
                      <span
                        className="inline-block h-3 w-3 animate-spin rounded-full border border-line border-t-ink"
                        aria-hidden="true"
                      />
                      Generating title ideas from the selected template…
                    </p>
                  ) : titleSuggestions.length > 0 ? (
                    <>
                      {/* Trust claim, not copy: the server reports whether an
                          LLM actually wrote these or it fell back to
                          deterministic catalog-derived titles. Collapsing the
                          two labels would advertise AI output that never
                          happened — do not "simplify" this ternary away. */}
                      <p className="font-mono text-[11px] text-ink-faint">
                        {titleSuggestionSource === "llm"
                          ? "AI-generated title ideas — pick one or write your own."
                          : "Template-based title ideas — pick one or write your own."}
                      </p>
                      {titleSuggestions.map((suggestion, i) => (
                        <PlannerChip
                          key={suggestion}
                          index={i + 1}
                          label={suggestion}
                          // Answers the step outright, unlike the `description`
                          // starters below which only fill the composer: v1
                          // commits a picked title on click (page.tsx:5487).
                          // It still has to clear handleSetTitle's own bounds,
                          // so a too-short suggestion surfaces `stepError`
                          // rather than being written through unchecked.
                          onClick={() => void answerTitle(suggestion)}
                          busy={controlsBusy}
                        />
                      ))}
                    </>
                  ) : !catalogTypes.some((t) => t.id === datasetTypeId) ? (
                    // Custom/forked type still in platform review — the assist
                    // endpoint refuses it, so nothing was requested and nothing
                    // is promised. No retry control here on purpose: it could
                    // only ever 400.
                    <p className="font-mono text-[11px] text-ink-faint">
                      Type your own title below — AI ideas open once this template is approved.
                    </p>
                  ) : (
                    // Empty or failed result. Never leave a bare input: say what
                    // happened and let the sponsor re-run the same assist call.
                    <div
                      className={`flex flex-wrap items-center gap-2 font-mono text-[11px] ${
                        titleSuggestionError ? "text-amber-700" : "text-ink-faint"
                      }`}
                    >
                      <span>
                        {titleSuggestionError
                          ? "Couldn't generate title ideas."
                          : "No title ideas yet."}{" "}
                        You can type your own below.
                      </span>
                      <button
                        type="button"
                        onClick={() => fetchTitleSuggestions(datasetTypeId)}
                        disabled={controlsBusy}
                        className="cursor-pointer font-semibold underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {titleSuggestionError ? "Try again" : "Generate title ideas"}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Starter descriptions now come from the real
                  `POST /v1/planner/assist` (`intent: "description"`), with the
                  local `descriptionStarters()` helper kept as the instant and
                  offline fallback: it renders while the call is in flight and
                  after one fails, so this step is never a bare textarea. */}
              {step === "description" && (
                <div className="mb-3.5 flex flex-col gap-2">
                  {descriptionSuggestionsLoading && (
                    <p
                      className="flex items-center gap-2 font-mono text-[11px] text-ink-faint"
                      role="status"
                      aria-live="polite"
                    >
                      <span
                        className="inline-block h-3 w-3 animate-spin rounded-full border border-line border-t-ink"
                        aria-hidden="true"
                      />
                      Generating starter descriptions from the selected template…
                    </p>
                  )}
                  {/* Trust claim, not copy — the same rule as the title step
                      above. Only a result the SERVER marked `source: "llm"`
                      may be called AI-generated; the deterministic starters,
                      and any server fallback, get the template-based label.
                      There is no third label: while the call is in flight the
                      chips below really are the local ones, so the label is
                      accurate then too. Do not collapse this ternary. */}
                  <p className="font-mono text-[11px] text-ink-faint">
                    {descriptionSuggestionsAreAi
                      ? "AI-generated starter descriptions — pick one to fill the box below, then edit it."
                      : "Template-based starter descriptions — pick one to fill the box below, then edit it."}
                  </p>
                  {descriptionStarterList.map((starter, i) => (
                    <PlannerChip
                      key={i}
                      index={i + 1}
                      label={starter}
                      // Fills the composer rather than answering outright: a
                      // starter is a first draft the sponsor is meant to edit,
                      // never a finished description. `applyStarter` (not a
                      // bare `setDraft`) also moves focus/caret to the end —
                      // see its own comment for why that's required (C14).
                      onClick={() => applyStarter(starter)}
                      busy={controlsBusy}
                    />
                  ))}
                  {/* A failed or empty assist call is stated, never swallowed:
                      without this the template-based starters would silently
                      stand in for a result that never arrived. The retry
                      re-runs the same call — manual entry stays available
                      either way, and no branch here blocks the composer. */}
                  {!descriptionSuggestionsLoading && descriptionSuggestions.length === 0 && (
                    <div
                      className={`flex flex-wrap items-center gap-2 font-mono text-[11px] ${
                        descriptionSuggestionError ? "text-amber-700" : "text-ink-faint"
                      }`}
                    >
                      <span>
                        {descriptionSuggestionError
                          ? "Couldn't generate AI starter descriptions."
                          : "No AI starter descriptions yet."}{" "}
                        The template-based ones above still work, or write your own below.
                      </span>
                      <button
                        type="button"
                        onClick={() => fetchDescriptionSuggestions(datasetTypeId, title)}
                        disabled={controlsBusy}
                        className="cursor-pointer font-semibold underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {descriptionSuggestionError ? "Try again" : "Generate starter descriptions"}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Options come from the TEMPLATE's own `languageSupport`
                  (`GET /planner/catalog`), never from a global list. See
                  `FALLBACK_LANGUAGES` above for what the hardcoded list got
                  wrong. `fixed` and `none` templates are answered without
                  asking, so this block normally renders only for `choice`,
                  `any` and `unknown`; the `fixed` branch below still renders on
                  the resume path, where a draft was saved ON this step and the
                  walk that would have filled it in already happened, so the
                  step is never left with no options at all. */}
              {step === "language" && languageDecision.choices.length > 0 && (
                <div className="mb-3.5" aria-disabled={controlsBusy}>
                  {languageDecision.mode === "fixed" && (
                    <p className="mb-2 font-mono text-[11px] text-ink-faint">
                      This template verifies {languageDecision.choices[0]!.label} only — its harness
                      runs no other language.
                    </p>
                  )}
                  {/* V1's community planner renders language as small label-only
                      chips in a CAPPED wrapping list (page.tsx:5440-5459), not as
                      stacked cards. The cap is load-bearing: this footer is a flex
                      sibling of the transcript, so an uncapped 9-option column
                      starves the conversation to a single line. */}
                  <div className={`flex max-h-[38vh] flex-wrap gap-2 overflow-y-auto pr-1 ${controlsBusy ? "pointer-events-none opacity-60" : ""}`}>
                    {languageDecision.choices.map((choice) => (
                      <button
                        key={choice.id}
                        type="button"
                        onClick={() => void answerLanguage(choice.label)}
                        disabled={controlsBusy}
                        // An `unverifiable` language is a real, selectable
                        // option — the pipeline accepts those rows and routes
                        // them to human audit. It is MARKED, never hidden and
                        // never shown as equivalent to one the sandbox can
                        // actually execute (V1 page.tsx:5444-5459).
                        title={choice.status === "unverifiable" ? choice.reason : undefined}
                        className={`cursor-pointer rounded-lg border px-3 py-1.5 font-mono text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40 ${
                          choice.status === "unverifiable"
                            ? "border-amber-300 text-amber-700 hover:border-amber-500"
                            : `border-line hover:border-ink hover:text-ink ${
                                Boolean(language) && language !== choice.label ? "text-ink-faint" : "text-ink-soft"
                              }`
                        }`}
                      >
                        {choice.label}
                        {choice.status === "unverifiable" && <span aria-hidden="true"> ⚠</span>}
                      </button>
                    ))}
                  </div>
                  {languageDecision.choices.some((c) => c.status === "unverifiable") && (
                    <p className="mt-2 font-mono text-[11px] text-amber-700">
                      ⚠ marks a language the execution sandbox has no runtime for. You can still pick
                      it — those items go to human audit instead of being execution-verified.
                    </p>
                  )}
                </div>
              )}

              {step === "items" && (
                <div className={`mb-3.5 flex flex-wrap gap-2 ${controlsBusy ? "pointer-events-none opacity-60" : ""}`} aria-disabled={controlsBusy}>
                  {/* V1 community (page.tsx:5547-5557) uses small label-only
                      wrapping chips here. V1 carries no per-count hint, so ours
                      moves to a `title` tooltip rather than a stacked card that
                      would squeeze the transcript. */}
                  {ITEM_COUNT_OPTIONS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => answerWith(() => handleSetItems(n))}
                      disabled={controlsBusy}
                      title={ITEM_COUNT_HINTS[n.toLocaleString()]}
                      className="cursor-pointer rounded-lg border border-line px-3 py-1.5 font-mono text-[12px] text-ink-soft transition-colors hover:border-ink hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
                    >
                      {n.toLocaleString()}
                    </button>
                  ))}
                </div>
              )}

              {step === "difficulty" && (
                <div className="mb-3.5 flex flex-col gap-2">
                  {/* Options are the ones this TEMPLATE declares levels for, so
                      a type with no `expert` level is never offered a mix that
                      describes expert items. */}
                  {difficultyOptions.map((opt, i) => (
                    <PlannerChip
                      key={opt.key}
                      index={i + 1}
                      label={opt.label}
                      hint={opt.hint}
                      onClick={() => answerWith(() => handleSetDifficulty(opt.key, opt.label))}
                      busy={controlsBusy}
                    />
                  ))}
                </div>
              )}

              {step === "audit" && (
                <div className="mb-3.5 flex flex-col gap-2">
                  {auditOptions.map((opt, i) => (
                    <PlannerChip
                      key={opt.pct}
                      index={i + 1}
                      label={opt.label}
                      hint={opt.hint}
                      onClick={() => answerWith(() => handleSetAudit(opt.pct, opt.label))}
                      busy={controlsBusy}
                    />
                  ))}
                </div>
              )}

              {step === "license" && (
                <div className="mb-3.5 flex flex-col gap-2">
                  {LICENSE_OPTIONS.map((opt, i) => (
                    <PlannerChip
                      key={opt.value}
                      index={i + 1}
                      label={opt.label}
                      hint={opt.hint}
                      onClick={() => answerWith(() => handleSetLicense(opt.value, opt.label))}
                      busy={controlsBusy}
                    />
                  ))}
                </div>
              )}

            {step === "samples" && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="micro-label text-ink-soft">reference examples ({activeSamplesCount}/{sampleGate.min} required)</div>
                  {/* Always rendered, as V1's "Continue to review" chip is
                      (page.tsx:5671). Hiding it until the gate was met left the
                      step with no way to say WHY it could not continue; now the
                      same click either advances or names the shortfall on the
                      inline error surface. */}
                  {/* 173x28 measured at 640; height-only shortfall, so the
                      hit box grows vertically and keeps the button's width. */}
                  <Button size="sm" onClick={handleContinueToReview} disabled={controlsBusy} className={TOUCH_TARGET}>
                    Continue to review →
                  </Button>
                </div>

                {samples.length > 0 && (
                  <ul className="space-y-2">
                    {samples.map((s) => (
                      <li key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-white px-3 py-2 text-xs">
                        <div className="min-w-0 truncate">
                          <span className="font-mono font-semibold text-ink">{s.filename}</span>
                          <ArtifactScanStatus status={s.status} scanStatus={s.scanStatus} className="ml-2 text-[11px]" />
                        </div>
                        <button
                          type="button"
                          disabled={sampleBusy}
                          onClick={() => void handleRemoveSample(s.id)}
                          className={`shrink-0 font-mono text-xs text-rose-600 hover:text-rose-700 disabled:opacity-50 ${TOUCH_TARGET}`}
                        >
                          remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <SampleUploadField
                  accept={sampleContract.accept}
                  acceptLabel={sampleContract.label}
                  slotMax={sampleGate.max}
                  slotsUsed={activeSamplesCount}
                  slotsRequired={sampleGate.min}
                  disabled={sampleBusy}
                  externalError={sampleError}
                  onFiles={handleAddSampleFiles}
                />
              </div>
            )}

              {/* Carried through to the last screen on purpose: the sponsor is
                  about to submit, and "these answers were never AI-reviewed" is
                  exactly the kind of claim that must not quietly disappear from
                  the step it happened on. */}
              {step === "review" && unreviewedFields.length > 0 && (
                <p
                  role="status"
                  className="mb-3.5 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 font-mono text-[11px] text-ink"
                >
                  AI review was not available for your {unreviewedFields.join(" and ")}, so{" "}
                  {unreviewedFields.length === 1 ? "it has not" : "they have not"} been checked. A
                  reviewer reads your request before it is approved.
                </p>
              )}

              {/* "Ready for submission" is a claim, so it is gated on the same
                  `pendingAnswers` the submit guard uses. Reaching review does
                  not mean the spec is complete: a template change clears the
                  answers that template defined, and this block asserted
                  readiness for a spec still missing its title and description.
                  The incomplete case names exactly what is outstanding instead
                  of leaving the sponsor to press a disabled button. */}
              {step === "review" && pendingAnswers.length === 0 && (
                <div className="mb-3.5 rounded-xl border border-success-border bg-success-soft p-4">
                  <div className="flex items-center gap-2 text-sm font-bold text-ink">
                    <Icon name="check" size={16} className="text-success" aria-hidden="true" />
                    Ready for submission
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-soft">
                    Review the details on the right, then submit. A reviewer checks your
                    specification and samples before this opens as a contribution program.
                  </p>
                </div>
              )}
              {step === "review" && pendingAnswers.length > 0 && (
                <div
                  role="status"
                  className="mb-3.5 rounded-xl border border-warn/40 bg-warn/10 p-4"
                >
                  <div className="text-sm font-bold text-ink">Not ready to submit yet</div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-soft">
                    This template needs {pendingAnswers.length === 1 ? "one more answer" : `${pendingAnswers.length} more answers`}:{" "}
                    <span className="font-mono">{pendingAnswers.join(", ")}</span>. Use the{" "}
                    <span className="font-mono">edit</span> controls on the right, or answer below.
                  </p>
                </div>
              )}
            </div>

            {/* Composer. One send path for every step: free-text steps read
                the box, selection-only steps disable it, and `review` turns
                the button into submit. Guarding `onSubmit` and `disabled`
                with the same `canSend` keeps the two from drifting — the bug
                that let a blank answer post in V1. */}
            <div className="flex shrink-0 items-end gap-2.5 pt-3.5">
              <ChatInput
                ref={composerRef}
                value={draft}
                onChange={setDraft}
                onSubmit={() => {
                  if (canSend) send();
                }}
                ariaLabel="Your answer"
                placeholder={composerPlaceholder}
                disabled={controlsBusy || !isFreeTextStep || titleSuggestionsLoading}
              />
              <Button
                onClick={send}
                disabled={!canSend}
                // 82x35.5 measured at 640. The box grows to `min-w-[82px]`'s
                // width and 44px tall; the answer box sits to its left, not
                // above or below it, so nothing is covered.
                className={`min-w-[82px] font-mono text-[13px] ${TOUCH_TARGET}`}
              >
                {submitting ? (
                  <>
                    <span
                      className="inline-block h-3 w-3 animate-spin rounded-full border border-ink-soft border-t-lime"
                      aria-hidden="true"
                    />
                    wait
                  </>
                ) : step === "review" ? (
                  "submit ↵"
                ) : (
                  "send ↵"
                )}
              </Button>
            </div>
          </div>
        </div>

        {/* Right: Live Spec Panel */}
        {/* `max-lg:overflow-visible` releases the clip below `lg`, where the
            panel is content-sized under the chat card and the page scrolls
            (V1 page.tsx:5723). */}
        <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-white max-lg:overflow-visible">
          <div className="shrink-0 border-b border-line-soft px-[22px] py-5">
            <div className="mb-4">
              <span className="font-mono text-[13px] font-bold text-ink">Dataset spec</span>
            </div>
            {/* The hero metric is the sponsor's progress through the walk.
                
                It must never be V1's "estimated total" / pool split, which
                describe escrow that does not exist here. It is also no longer
                "cost to you · Free": D18 (AGENTS.md §1) bars money surfaces
                anywhere in this tree "and no financial mention in legal or
                marketing copy either", so a currency-framed hero — even one
                whose value is zero — is the wrong thing to make the largest
                text in the panel.
                
                Progress is the honest alternative here because it is the one
                number that is always true and never seeded: `answeredCount`
                counts only steps the sponsor genuinely answered (see the
                `answered` map), so unlike `targetItems` (seeded 500) it cannot
                render a default as a decision. It also absorbs the duplicate
                "N / M decided" chip this block used to carry alongside it. */}
            <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[.05em] text-ink-faint">
              steps decided
            </div>
            <div className="font-mono text-[30px] font-bold text-ink">
              {answeredCount}
              <span className="text-[18px] font-normal text-ink-faint"> / {askedSteps.length}</span>
            </div>
            <p className="mt-2 text-[12px] leading-snug text-ink-soft">
              Contributors earn karma for accepted items. An admin reviews your request before it
              goes live.
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pb-5 pt-2 max-lg:overflow-visible">
            {specRows.map((row) => {
              const canEdit = Boolean(row.editKey) && Boolean(row.value) && !submitting;
              return (
                <div key={row.label} className="border-b border-line-soft py-3.5 last:border-b-0">
                  {/* V1's COMMUNITY spec row (page.tsx:5742-5752): the status dot
                      sits inline in the label row with the edit control opposite
                      it, and the value sits underneath. The previous markup here
                      was V1's FUNDED variant (dot in its own left column,
                      py-[13px]) — out of scope for community parity. */}
                  <div className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[.05em] text-ink-faint">
                    <span className="flex items-center gap-2">
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          row.value ? "bg-lime-bright" : "bg-line-strong"
                        }`}
                      />
                      {row.label}
                    </span>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => enterEditStep(row.editKey!)}
                        disabled={controlsBusy}
                        // 11px type is right for this panel's density but
                        // measured 43x17 — under the 44x44 touch minimum, on
                        // the one control that drives the whole edit-any-step
                        // feature. `TOUCH_TARGET` grows only the hit area.
                        className={`inline-flex shrink-0 cursor-pointer items-center gap-1 border-none bg-transparent normal-case font-mono text-[11px] text-ink-soft transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 ${TOUCH_TARGET}`}
                      >
                        <Icon name="edit" size={11} aria-hidden="true" />
                        edit
                      </button>
                    )}
                  </div>
                  <div
                    className={`mt-[3px] break-words text-[13.5px] font-medium ${
                      row.value ? "text-ink" : "text-ink-faint"
                    }`}
                  >
                    {row.value || "—"}
                  </div>
                </div>
              );
            })}

            {/* The chosen contract, so the sponsor can see exactly what a
                contributor will be asked to fill before committing to it. */}
            {selectedType && (
              <div className="mt-5 rounded-xl border border-line-soft bg-panel p-4">
                <div className="font-mono text-[10px] uppercase tracking-[.05em] text-ink-faint">
                  selected dataset contract
                </div>
                <div className="mt-1 text-[13.5px] font-bold text-ink">{selectedType.name}</div>
                {selectedType.description && (
                  <p className="mt-1 text-[12px] leading-snug text-ink-soft">
                    {selectedType.description}
                  </p>
                )}
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-[.05em] text-ink-faint">
                      required fields
                    </div>
                    <div className="mt-1 font-mono text-[11px] leading-snug text-ink">
                      {selectedType.fields.filter((f) => f.required).map((f) => f.label).join(", ") ||
                        "—"}
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-[.05em] text-ink-faint">
                      duplicate identity
                    </div>
                    <div className="mt-1 font-mono text-[11px] leading-snug text-ink">
                      {selectedType.verification.dedupeFields?.join(" + ") || "—"}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Which validation stages this spec will run.
                `pipelineWithPlatformStages` does NOT simply echo the template:
                it strips `schema` (a config artifact that never produces a
                result), injects `ai_attribution` (always-on by owner decision
                in the API's validation service, and not configurable), and
                drops `llm` when the platform's `validation.llm.enabled` is
                off. So the honesty guarantee here comes from that helper plus
                the server-owned `llmEnabled` flag — not from the template
                declaring each stage.

                This is a PLAN, not a result. The leading glyph must not be a
                tick: a tick reads as "passed" and this list is only what is
                scheduled to run. Anything that will not actually run is shown
                explicitly and marked, never silently dropped. */}
            <div className="mt-5">
              <div className="font-mono text-[10px] uppercase tracking-[.05em] text-ink-faint">
                what your spec runs
              </div>
              {selectedType ? (
                <div className="mt-2 flex flex-col gap-2">
                  {pipelineWithPlatformStages(selectedType.verification.pipeline, {
                    llmEnabled,
                  }).map((stage) => {
                    // A 0% audit coverage means the validator-audit stage is
                    // declared by the contract but runs on no items. Listing it
                    // unqualified contradicted the "audit coverage: 0%" row a
                    // few lines above and claimed a check that never executes.
                    const inert = stage === "human_audit" && auditCoveragePct === 0;
                    return (
                      <div key={stage} className="flex items-start gap-2.5 text-[12px]">
                        <span
                          className={`mt-[3px] shrink-0 ${inert ? "text-ink-faint" : "text-accent-strong"}`}
                          aria-hidden="true"
                        >
                          →
                        </span>
                        <span className="min-w-0 font-mono font-medium text-ink">
                          {stageLabel(stage)}
                          {inert && (
                            <span className="font-normal text-ink-faint">
                              {" "}
                              — 0% coverage, not running
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="m-0 mt-2 text-[12px] leading-snug text-ink-faint">
                  Pick a dataset template and the exact validation stages it runs are listed here.
                </p>
              )}
            </div>
          </div>

          {/* Terminal CTA, mirroring V1's panel footer. It appears only at the
              review step so the primary action is never available before the
              spec is complete. */}
          {step === "review" && (
            <div className="shrink-0 border-t border-line-soft bg-panel px-[22px] py-4">
              <Button
                type="button"
                onClick={handleSubmitRequest}
                // Same three conditions the guard enforces, so the control is
                // never enabled for a spec `handleSubmitRequest` would refuse.
                disabled={submitting || pendingAnswers.length > 0 || activeSamplesCount < sampleGate.min}
                className="w-full py-[13px] font-mono text-[13px]"
              >
                {submitting ? "submitting request…" : "submit community request"}
              </Button>
            </div>
          )}
        </aside>
      </div>

      <ConfirmDialog
        open={showStartOverConfirm}
        title="Discard this draft and start over?"
        description="Your answers so far will be permanently lost."
        confirmLabel="Start over"
        confirmDisabled={startingOver}
        onConfirm={() => void handleStartOver()}
        onCancel={() => setShowStartOverConfirm(false)}
      />
    </div>
  );
}
