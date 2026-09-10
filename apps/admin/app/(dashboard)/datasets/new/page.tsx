"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { adminAuthedFetch } from "@/lib/admin-auth";
import { useAdminToast } from "@/lib/admin-toast";
import { AdminErrorBanner, AdminPageHeader, AdminPill } from "@/components/admin-shell";
import { TypePreview } from "@/components/type-preview";
import {
  DOMAINS,
  TRUST_TIER_LABELS,
  typeToYaml,
  type DatasetType,
  type Domain,
  type DomainId,
  type FieldRole,
  type TrustTier,
  type TypeField,
  type VerificationCheck,
} from "@/lib/dataset-types";
import type { DatasetCategory } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Script                                                              */
/* ------------------------------------------------------------------ */

type Phase =
  | "domain"
  | "name"
  | "description"
  | "fields"
  | "env"
  | "audit"
  | "confirm"
  | "done";

const PHASE_ORDER: Phase[] = [
  "domain",
  "name",
  "description",
  "fields",
  "env",
  "audit",
  "confirm",
];

/** Shape of POST /v1/admin/dataset-types/propose. Only the parts the builder
 * consumes today — the endpoint also returns fields/pipeline/tier, which the
 * remaining steps still collect interactively. */
interface TypeProposal {
  name: string;
  description: string;
}

interface NameAvailability {
  id: string;
  available: boolean;
  reason?: string;
  suggestions: string[];
}

const STEP_LABELS: Record<Phase, string> = {
  domain: "Domain",
  name: "Name",
  description: "Description",
  fields: "Fields",
  env: "Sandbox",
  audit: "Audit coverage",
  confirm: "Review",
  done: "Done",
};

const ENV_OPTIONS = ["node:20", "python:3.11", "sqlite", "regex-engine", "none"];
const AUDIT_OPTIONS = ["0,25,100", "25,100", "100 only"];

const HINTS: Record<string, string> = {
  "node:20": "JS/TS sandbox — runs tests and benchmarks",
  "python:3.11": "Python sandbox — runs tests and scripts",
  sqlite: "executes SQL against a provided schema",
  "regex-engine": "millisecond positive/negative match verification",
  none: "no execution step — LLM / audit verified only",
  "0,25,100": "sponsor picks any coverage, including LLM-only",
  // Not "at least 1 in 4 items reviewed": coverage sampling of clean items
  // isn't live (every cleared item is a forced escalation today), so
  // picking 25% here currently reviews every item, same as 100%.
  "25,100": "audit always on — every item reviewed today at either pick",
  "100 only": "every item expert-reviewed ⇒ expert-audited tier",
};

/** Quick-add chips for the fields step. */
const QUICK_ADDS: { label: string; hint: string; field: TypeField }[] = [
  { label: "+ instruction", hint: "natural-language prompt / requirement", field: { key: "prompt", label: "Prompt", role: "instruction", required: true } },
  { label: "+ input code", hint: "code given to the contributor", field: { key: "input_code", label: "Input code", role: "input_code", lang: "ts", required: true } },
  { label: "+ solution code", hint: "code the contributor produces", field: { key: "solution_code", label: "Solution", role: "solution_code", lang: "ts", required: true } },
  { label: "+ tests", hint: "test code that gates acceptance", field: { key: "tests", label: "Tests", role: "tests", lang: "ts", required: true } },
  { label: "+ rationale", hint: "explanation / reasoning text", field: { key: "explanation", label: "Explanation", role: "rationale", required: true } },
  { label: "+ enum", hint: "pick-one metadata field", field: { key: "category", label: "Category", role: "enum", options: ["option_a", "option_b", "option_c"] } },
  { label: "+ list", hint: "array of short strings", field: { key: "items_list", label: "Items", role: "list" } },
  { label: "+ source file", hint: "uploaded artifact; configure its processing profile before activation", field: { key: "source_file", label: "Source file", role: "file", accept: ".txt" } },
];

const DONE_FIELDS = "done with fields";

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "custom_type";

const LANG_MAP: Record<string, string> = {
  typescript: "ts", ts: "ts", javascript: "js", js: "js",
  python: "py", py: "py", go: "go", golang: "go", rust: "rs", rs: "rs",
  sql: "sql", shell: "sh", bash: "sh", sh: "sh", regex: "regex",
  yaml: "yaml", json: "json", java: "java", diff: "diff",
};

function uniqueKey(base: string, existing: TypeField[]): string {
  let key = base;
  let i = 2;
  while (existing.some((f) => f.key === key)) key = `${base}_${i++}`;
  return key;
}

/** Parse `broken_code — the code with the bug (code, typescript, required)`. */
function parseField(raw: string, existing: TypeField[]): TypeField {
  const parenMatch = raw.match(/\(([^)]*)\)/);
  const tokens = parenMatch
    ? parenMatch[1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];
  const body = raw.replace(/\([^)]*\)/g, "").trim();
  const [labelPart, ...rest] = body.split(/\s*(?:—|–|::|\s-\s)\s*/);
  const desc = rest.join(" ").trim();
  const rawLabel = (labelPart || "field").trim();
  const key = uniqueKey(slug(rawLabel), existing);
  const pretty = rawLabel.replace(/_/g, " ");
  const label = pretty.charAt(0).toUpperCase() + pretty.slice(1);

  const required = tokens.includes("required");
  const lang = tokens.map((t) => LANG_MAP[t]).find(Boolean);
  const all = raw.toLowerCase();

  let role: FieldRole;
  if (/\btests?\b/.test(all)) role = "tests";
  else if (/one[- ]of|enum|pick one/.test(all)) role = "enum";
  else if (/\blist\b|edge cases|examples/.test(all)) role = "list";
  else if (/expected|output/.test(all)) role = "expected_output";
  else if (/solution|fixed|corrected|optimi[sz]ed|migrated|secure/.test(all))
    role = "solution_code";
  else if (/explain|rationale|reason|why\b|analysis|docstring/.test(all))
    role = "rationale";
  else if (tokens.includes("code") || lang || /\bcode\b|snippet|broken|buggy|starter/.test(all))
    role = "input_code";
  else if (/instruction|prompt|requirement|request|task\b|question|goal|intent/.test(all))
    role = "instruction";
  else if (/reference|citation|link|cve/.test(all)) role = "reference";
  else role = "input_context";

  const f: TypeField = { key, label, role };
  if (required) f.required = true;
  if (lang && ["input_code", "solution_code", "tests"].includes(role)) f.lang = lang;
  if (desc) f.help = desc.charAt(0).toUpperCase() + desc.slice(1);
  if (role === "enum") {
    const opts = tokens
      .filter((t) => t !== "required" && t !== "code" && !LANG_MAP[t])
      .map((t) => t.replace(/^one of\s*/, ""));
    f.options = opts.length > 0 ? opts : ["option_a", "option_b", "option_c"];
  }
  return f;
}

/* ------------------------------------------------------------------ */
/* Draft assembly                                                      */
/* ------------------------------------------------------------------ */

interface Answers {
  domain?: DomainId;
  name?: string;
  description?: string;
  env?: string;
  audit?: string;
}

function auditPreset(audit: string | undefined): number[] {
  if (audit === "25,100") return [25, 100];
  if (audit === "100 only") return [100];
  return [0, 25, 100];
}

function derive(a: Answers, fields: TypeField[]) {
  const domain = a.domain ?? "coding";
  const hasExec = !!a.env && a.env !== "none";
  const auditOptions = auditPreset(a.audit);
  const pipeline: VerificationCheck[] = [
    "dedupe",
    ...(hasExec ? (["execution"] as VerificationCheck[]) : []),
    "llm",
    ...(auditOptions.some((o) => o > 0)
      ? (["human_audit"] as VerificationCheck[])
      : []),
  ];
  const trustTier: TrustTier = hasExec
    ? "execution_verified"
    : a.audit === "100 only"
      ? "expert_audited"
      : "llm_verified";
  const roles = new Set(fields.map((f) => f.role));
  const category: DatasetCategory =
    roles.has("tests") && roles.has("input_code") && roles.has("solution_code")
      ? "debugging"
      : roles.has("solution_code") || roles.has("tests")
        ? "implementation"
        : roles.has("rationale")
          ? "error_diagnosis"
          : "implementation";
  return { domain, pipeline, trustTier, auditOptions, category, hasExec };
}

function buildDraft(a: Answers, fields: TypeField[], id: string): DatasetType {
  const d = derive(a, fields);
  return {
    id,
    version: 1,
    domain: d.domain,
    name: a.name?.trim() || "Untitled type",
    description: a.description?.trim() || "—",
    status: "draft",
    origin: "platform",
    category: d.category,
    fields,
    verification: {
      pipeline: d.pipeline,
      executionEnv: d.hasExec ? a.env : undefined,
      dedupeFields: fields.slice(0, 2).map((f) => f.key),
      auditOptions: d.auditOptions,
    },
    trustTier: d.trustTier,
    difficultyLevels: ["beginner", "intermediate", "expert"],
    usageCount: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

type Msg = { role: "a" | "u"; text: string };

const FIELD_PROMPT =
  "Now the schema — this is what makes the type real. Describe the fields, one per message, like `broken_code — the code with the bug (code, typescript, required)`. I'll parse the key, role, language, and required flag. Use the quick-add chips for common roles, and say “done with fields” when you have at least two.";

function promptFor(phase: Phase, a: Answers): string {
  switch (phase) {
    case "domain":
      return "Let's define a new dataset type. Which domain does it belong to? Coming-soon domains are fine — the type seeds the domain teaser.";
    case "name":
      return `${a.domain === "coding" ? "Coding it is — execution verification is on the table." : "Noted — non-coding domains skip execution verification."} What should the type be called?`;
    case "description":
      return "Give me a one-or-two sentence description — sponsors see this in the catalog, contributors see it on task cards.";
    case "fields":
      return FIELD_PROMPT;
    case "env":
      return "Which execution environment should verify submissions? Pick “none” if items can't be mechanically executed — the pipeline then leans on LLM review and validator audit.";
    case "audit":
      return "Last decision: which validator-audit coverage options can sponsors choose from for this type?";
    default:
      return "";
  }
}

export default function NewDatasetTypePage() {
  const [phase, setPhase] = useState<Phase>("domain");
  const [answers, setAnswers] = useState<Answers>({});
  const [fields, setFields] = useState<TypeField[]>([]);
  const [draft, setDraft] = useState("");
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { pushToast } = useAdminToast();
  const [messages, setMessages] = useState<Msg[]>([
    { role: "a", text: promptFor("domain", {}) },
  ]);
  // Live domains from /v1/meta/taxonomy — the DB-driven source onboarding and
  // sponsor-intake already use. `DOMAINS` remains only as the pre-load shape
  // so the first paint isn't empty; it is replaced as soon as the fetch lands.
  const [domains, setDomains] = useState<Domain[]>(DOMAINS);
  // AI draft from POST /v1/admin/dataset-types/propose. `source` records
  // whether the text is real model output or the endpoint's deterministic
  // fallback, so the UI never labels a canned string as AI-suggested.
  const [proposal, setProposal] = useState<TypeProposal | null>(null);
  const [proposalSource, setProposalSource] = useState<"llm" | "fallback" | null>(null);
  const [proposing, setProposing] = useState(false);
  const [availability, setAvailability] = useState<NameAvailability | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    let alive = true;
    adminAuthedFetch("/v1/meta/taxonomy")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { domains?: Domain[] }) => {
        if (!alive || !Array.isArray(data.domains) || data.domains.length === 0) return;
        setDomains(data.domains);
      })
      .catch(() => {
        // Non-fatal: the builder still works off the bundled shape. Surfaced
        // in the domain step's hint rather than as a blocking error.
      })
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Ask the API to suggest a name + description once the domain is known.
   * Advisory only — both values stay fully editable.
   *
   * Uses `/dataset-types/suggest` (two fields) rather than
   * `/dataset-types/propose` (twelve): the latter fails its schema on every
   * model and burns ~99s before falling back to "Untitled dataset type".
   * `suggestion: null` means the model failed, and we then show no chip at all
   * rather than passing a placeholder off as a suggestion.
   */
  const requestProposal = async (domain: DomainId, brief?: string) => {
    setProposing(true);
    setProposal(null);
    setProposalSource(null);
    try {
      const res = await adminAuthedFetch("/v1/admin/dataset-types/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain, ...(brief?.trim() ? { brief: brief.trim() } : {}) }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { suggestion: TypeProposal | null; source: "llm" | "fallback" };
      setProposalSource(data.source);
      if (data.suggestion) setProposal(data.suggestion);
    } catch {
      // Leave `proposal` null — the name/description steps then offer no
      // suggestion at all rather than a fabricated one.
    } finally {
      setProposing(false);
    }
  };

  /**
   * Live id-collision check so a clash surfaces at the name step, not as a 409
   * after the final one. Resolves to the conflict when the name is taken, or
   * null when it is free — or when the check itself could not run, so a failed
   * lookup never blocks an admin (the server-side unique constraint is still
   * the authority at create time).
   */
  const checkAvailability = async (name: string): Promise<NameAvailability | null> => {
    if (!name.trim()) {
      setAvailability(null);
      return null;
    }
    try {
      const res = await adminAuthedFetch(
        `/v1/admin/dataset-types/availability?name=${encodeURIComponent(name)}`
      );
      if (!res.ok) {
        setAvailability(null);
        return null;
      }
      const data = (await res.json()) as NameAvailability;
      setAvailability(data);
      return data.available ? null : data;
    } catch {
      setAvailability(null);
      return null;
    }
  };

  /* ---- unique id for the draft ---- */
  // Named so the useMemo dependency below is a simple identifier, not a
  // computed expression — same value, same recompute behavior either way.
  const typeId = useMemo(() => {
    return slug(answers.name ?? "new_type");
  }, [answers.name]);

  const draftType = useMemo(
    () => buildDraft(answers, fields, createdId ?? typeId),
    [answers, fields, typeId, createdId]
  );
  const d = derive(answers, fields);

  const push = (msgs: Msg[]) => setMessages((m) => [...m, ...msgs]);

  const advance = (next: Phase, a: Answers) => {
    setPhase(next);
    if (next === "confirm") {
      push([
        {
          role: "a",
          text: `Here's the full picture: “${a.name}” in ${
            domains.find((x) => x.id === a.domain)?.name ?? a.domain
          } · ${fields.length} fields · ${
            a.env === "none" ? "no execution sandbox" : `sandbox ${a.env}`
          } · audit options ${auditPreset(a.audit).join("/")}% ⇒ ${
            TRUST_TIER_LABELS[derive(a, fields).trustTier]
          } tier. The three surfaces and YAML are on the right. Create it?`,
        },
      ]);
    } else {
      push([{ role: "a", text: promptFor(next, a) }]);
    }
  };

  /**
   * Jump back to an already-answered step and re-ask it. Previously the script
   * only ever moved forward, so a typo in step 2 meant abandoning the session
   * and starting over.
   *
   * Downstream answers are cleared rather than kept: they were derived from the
   * value being changed (the pipeline and trust tier are computed from domain +
   * env + audit), so silently retaining them would produce a draft that never
   * matches what the admin was shown. Fields survive a domain/name/description
   * edit because they are independent of those three.
   */
  const editStep = (target: Phase) => {
    const targetIndex = PHASE_ORDER.indexOf(target);
    if (targetIndex < 0 || phase === "done") return;

    const next: Answers = { ...answers };
    if (targetIndex <= PHASE_ORDER.indexOf("domain")) delete next.domain;
    if (targetIndex <= PHASE_ORDER.indexOf("name")) delete next.name;
    if (targetIndex <= PHASE_ORDER.indexOf("description")) delete next.description;
    if (targetIndex <= PHASE_ORDER.indexOf("env")) delete next.env;
    if (targetIndex <= PHASE_ORDER.indexOf("audit")) delete next.audit;
    if (targetIndex <= PHASE_ORDER.indexOf("fields")) setFields([]);
    if (targetIndex <= PHASE_ORDER.indexOf("name")) setAvailability(null);

    setAnswers(next);
    setPhase(target);
    setSaveError(null);
    push([
      { role: "a", text: `Editing “${STEP_LABELS[target]}” — later answers were cleared so the draft stays consistent.` },
      { role: "a", text: promptFor(target, next) },
    ]);
  };

  const confirmCreate = async () => {
    if (saving) return;
    setSaving(true);
    const full = buildDraft(answers, fields, typeId);
    const { version: _v, usageCount: _u, ...toAdd } = full;
    void _v;
    void _u;
    let id = typeId;
    try {
      const response = await adminAuthedFetch("/v1/admin/dataset-types", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toAdd),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Could not save dataset type");
      }
      const data = (await response.json()) as { datasetType?: { id: string } };
      if (!data.datasetType?.id) throw new Error("Dataset type was saved without an id");
      setSaveError(null);
      id = data.datasetType.id;
      setCreatedId(id);
      pushToast({ variant: "success", title: "Dataset type saved as draft", body: full.name });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save dataset type";
      setSaveError(message);
      pushToast({ variant: "error", title: "Couldn't save dataset type", body: message });
      setSaving(false);
      return;
    }
    setSaving(false);
    setPhase("done");
    push([
      {
        role: "a",
        text: `Saved as draft — “${full.name}” (${id}, v1) is in the catalog. Activate it from the catalog or the type's detail page when it's ready for sponsors.`,
      },
    ]);
  };

  const answer = (label: string) => {
    const text = label.trim();
    if (!text) return;
    setDraft("");
    push([{ role: "u", text }]);

    switch (phase) {
      case "domain": {
        const dom =
          domains.find((x) => x.name.toLowerCase() === text.toLowerCase()) ??
          domains.find((x) => text.toLowerCase().includes(x.id)) ??
          domains[0];
        if (!dom) break;
        const a = { ...answers, domain: dom.id };
        setAnswers(a);
        void requestProposal(dom.id);
        advance("name", a);
        break;
      }
      case "name": {
        // Genuinely blocks on a collision: without this the admin answers five
        // more questions and only then hits the 409 from POST /dataset-types,
        // losing the session. Stay on this step until the name is free.
        void (async () => {
          const taken = await checkAvailability(text);
          if (taken) {
            push([
              {
                role: "a",
                text: `${taken.reason} Pick one of the alternatives below, or type a different name.`,
              },
            ]);
            return;
          }
          const a = { ...answers, name: text };
          setAnswers(a);
          advance("description", a);
        })();
        break;
      }
      case "description": {
        const a = { ...answers, description: text };
        setAnswers(a);
        advance("fields", a);
        break;
      }
      case "fields": {
        if (new RegExp(DONE_FIELDS, "i").test(text)) {
          if (fields.length < 2) {
            push([
              {
                role: "a",
                text: `A type needs at least 2 fields — you have ${fields.length}. Add ${
                  fields.length === 0 ? "a couple" : "one"
                } more (an input and an output is the usual minimum).`,
              },
            ]);
          } else {
            advance("env", answers);
          }
          break;
        }
        const quick = QUICK_ADDS.find((q) => q.label === text);
        const f = quick
          ? {
              ...quick.field,
              key: uniqueKey(quick.field.key, fields),
            }
          : parseField(text, fields);
        const nextFields = [...fields, f];
        setFields(nextFields);
        push([
          {
            role: "a",
            text: `Added ${f.key} — role ${f.role}${f.lang ? ` · ${f.lang}` : ""}${
              f.required ? " · required" : ""
            }. That's ${nextFields.length} field${
              nextFields.length > 1 ? "s" : ""
            }. Next field, or “${DONE_FIELDS}”.`,
          },
        ]);
        break;
      }
      case "env": {
        const env = ENV_OPTIONS.includes(text) ? text : "none";
        const a = { ...answers, env };
        setAnswers(a);
        advance("audit", a);
        break;
      }
      case "audit": {
        const audit = AUDIT_OPTIONS.includes(text) ? text : "0,25,100";
        const a = { ...answers, audit };
        setAnswers(a);
        advance("confirm", a);
        break;
      }
      case "confirm": {
        if (/create/i.test(text)) confirmCreate();
        else
          push([
            {
              role: "a",
              text: "No problem — choose “create type as draft” when you're ready.",
            },
          ]);
        break;
      }
      default:
        break;
    }
  };

  /* ---- options for the current phase ---- */
  // Only offer a suggestion when one actually came back from the API, and label
  // it by its real provenance. A deterministic fallback must never read as an
  // AI suggestion, and when nothing is available we show no chip at all rather
  // than inventing one.
  const suggestionHint = proposalSource === "llm" ? "AI-suggested — pick it or type your own" : "default draft — pick it or type your own";
  const options: { label: string; hint?: string }[] =
    phase === "domain"
      ? domains.map((x) => ({
          label: x.name,
          hint: `${x.status === "live" ? "live" : "coming soon"} · ${x.tagline}`,
        }))
      : phase === "name"
        ? [
            ...(proposal?.name ? [{ label: proposal.name, hint: suggestionHint }] : []),
            ...(availability && !availability.available
              ? availability.suggestions.map((s) => ({ label: s.replace(/_/g, " "), hint: "available alternative" }))
              : []),
          ]
        : phase === "description"
          ? proposal?.description
            ? [{ label: proposal.description, hint: suggestionHint }]
            : []
          : phase === "fields"
            ? [
                ...QUICK_ADDS.map((q) => ({ label: q.label, hint: q.hint })),
                ...(fields.length >= 2
                  ? [
                      {
                        label: DONE_FIELDS,
                        hint: `${fields.length} fields defined — continue to verification`,
                      },
                    ]
                  : []),
              ]
            : phase === "env"
              ? ENV_OPTIONS.map((e) => ({ label: e, hint: HINTS[e] }))
              : phase === "audit"
                ? AUDIT_OPTIONS.map((x) => ({ label: x, hint: HINTS[x] }))
                : phase === "confirm"
                  ? [
                      {
                        label: "create type as draft",
                        hint: "saved to the catalog — activate when ready",
                      },
                    ]
                  : [];

  const stepNo = Math.min(PHASE_ORDER.indexOf(phase) + 1, PHASE_ORDER.length);
  const done = phase === "done";
  const tierTone: Record<TrustTier, "lime" | "info" | "violet"> = {
    execution_verified: "lime",
    llm_verified: "info",
    expert_audited: "violet",
  };

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/datasets"
          className="font-mono text-[11px] text-dark-soft transition-colors hover:text-dark-text"
        >
          ← dataset types
        </Link>
        <div className="mt-2">
          <AdminPageHeader
            title="New dataset type"
            sub="Answer a few questions — the type's three surfaces and YAML build live on the right."
          />
        </div>
      </div>
      {saveError && <AdminErrorBanner message={`${saveError} Nothing was added to the catalog. Retry after correcting the issue.`} />}

      <div className="grid grid-cols-[1.25fr_1fr] items-start gap-5 max-lg:grid-cols-1">
        {/* ===== chat ===== */}
        <div className="flex h-[calc(100dvh-9rem)] min-h-[480px] flex-col overflow-hidden rounded-xl border border-dark-line bg-dark-card lg:h-[620px]">
          <div className="flex shrink-0 items-center gap-2.5 border-b border-dark-line px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[13px] font-bold text-dark-text">
                type_builder
              </div>
              <div className="font-mono text-[10px] text-dark-dim">
                {proposing
                  ? "drafting a suggestion…"
                  : proposalSource === "llm"
                    ? "drafts the type definition as you talk · AI suggestions on"
                    : proposalSource === "fallback"
                      ? "drafts the type definition as you talk · AI unavailable, showing defaults"
                      : "drafts the type definition as you talk"}
              </div>
            </div>
            <span className="rounded-full border border-dark-line-soft px-2.5 py-1 font-mono text-[10px] text-dark-soft">
              {done ? "complete" : `step ${stepNo} / ${PHASE_ORDER.length}`}
            </span>
          </div>

          {/* Answered steps stay reachable — click one to correct it instead of
              restarting the whole session. Hidden once the type is created,
              since edits then belong on the type's detail page. */}
          {!done && stepNo > 1 && (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-dark-line px-5 py-2.5">
              <span className="font-mono text-[10px] text-dark-dim">edit:</span>
              {PHASE_ORDER.slice(0, PHASE_ORDER.indexOf(phase)).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => editStep(p)}
                  className="rounded-full border border-dark-line-soft px-2.5 py-1 font-mono text-[10px] text-dark-soft transition-colors hover:border-lime hover:text-lime"
                >
                  {STEP_LABELS[p]}
                </button>
              ))}
            </div>
          )}

          <div
            ref={transcriptRef}
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5"
          >
            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === "u" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={
                    m.role === "u"
                      ? "max-w-[80%] rounded-[13px] rounded-br-[4px] bg-lime px-3.5 py-2.5 text-[13px] leading-normal text-dark"
                      : "max-w-[86%] rounded-[13px] rounded-bl-[4px] border border-dark-line bg-[#12160f] px-3.5 py-2.5 text-[13px] leading-normal text-dark-text"
                  }
                >
                  {m.text}
                </div>
              </div>
            ))}
            {done && createdId && (
              <div className="flex gap-2 pl-1 pt-1">
                <Link
                  href={`/datasets/view?id=${encodeURIComponent(createdId)}`}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-lime px-3.5 py-2 font-mono text-xs font-medium text-dark transition-colors hover:bg-lime-bright"
                >
                  open {createdId} →
                </Link>
                <Link
                  href="/datasets"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-dark-line-soft px-3.5 py-2 font-mono text-xs text-dark-text transition-colors hover:border-dark-hover"
                >
                  back to catalog
                </Link>
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-dark-line px-4 py-4">
            {options.length > 0 && (
              <div
                className={`mb-3 max-h-[45vh] overflow-y-auto ${
                  phase === "fields"
                    ? "flex flex-wrap gap-1.5"
                    : "flex flex-col gap-1.5"
                }`}
              >
                {options.map((o, i) =>
                  phase === "fields" && o.label !== DONE_FIELDS ? (
                    <button
                      key={o.label}
                      onClick={() => answer(o.label)}
                      disabled={saving}
                      title={o.hint}
                      className="cursor-pointer rounded-full border border-dark-line px-3 py-1.5 font-mono text-[11px] text-dark-soft transition-colors hover:border-dark-hover hover:text-lime"
                    >
                      {o.label}
                    </button>
                  ) : (
                    <button
                      key={o.label}
                      onClick={() => answer(o.label)}
                      disabled={saving}
                      className={`group flex cursor-pointer items-start gap-2.5 rounded-[9px] border px-3 py-2.5 text-left transition-colors ${
                        o.label === DONE_FIELDS
                          ? "w-full border-lime/40 bg-lime/5 hover:bg-lime/10"
                          : "border-dark-line hover:border-dark-hover hover:bg-dark-row-hover"
                      }`}
                    >
                      <span className="mt-0.5 shrink-0 rounded-[5px] bg-dark-nav-hover px-1.5 py-0.5 font-mono text-[10px] text-dark-dim group-hover:text-lime">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium leading-tight text-dark-text">
                          {o.label}
                        </span>
                        {o.hint && (
                          <span className="mt-0.5 block font-mono text-[10px] leading-snug text-dark-dim">
                            {o.hint}
                          </span>
                        )}
                      </span>
                    </button>
                  )
                )}
              </div>
            )}
            <div className="flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && answer(draft)}
                placeholder={
                  done
                    ? "Type created"
                    : phase === "fields"
                      ? "field_key — what it is (code, typescript, required)…"
                      : "Type your answer…"
                }
                disabled={done}
                className="min-w-0 flex-1 rounded-[9px] border border-dark-line-soft bg-dark-field px-3.5 py-2.5 font-mono text-xs text-dark-text transition-colors focus:border-dark-hover focus:outline-none disabled:opacity-50"
              />
              <button
                onClick={() => answer(draft)}
                disabled={done}
                className="cursor-pointer rounded-[9px] bg-lime px-4 font-mono text-xs font-medium text-dark transition-colors hover:bg-lime-bright disabled:cursor-not-allowed disabled:opacity-50"
              >
                send ↵
              </button>
            </div>
          </div>
        </div>

        {/* ===== live draft panel ===== */}
        <div className="space-y-4">
          <div className="rounded-xl border border-dark-line bg-dark-card p-[18px]">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-mono text-[13px] font-bold text-dark-text">
                Type draft
              </span>
              {/* A draft type has verified nothing yet — its tier is only a
                  projection from the config so far, not an earned trust claim.
                  Label it "proposed" so a draft never reads as already verified;
                  the target tier is shown as plain text in the grid below. */}
              {draftType.status === "draft" ? (
                <AdminPill tone="neutral">proposed · unverified</AdminPill>
              ) : (
                <AdminPill tone={tierTone[d.trustTier]}>{TRUST_TIER_LABELS[d.trustTier]}</AdminPill>
              )}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 font-mono text-[11px]">
              {[
                ["id", draftType.id],
                ["domain", domains.find((x) => x.id === d.domain)?.name ?? "—"],
                ["fields", `${fields.length}`],
                ["sandbox", answers.env ? (answers.env === "none" ? "none" : answers.env) : "—"],
                ["audit options", answers.audit ? `${d.auditOptions.join("/")}%` : "—"],
                ["target tier", `${TRUST_TIER_LABELS[d.trustTier]} (once verified)`],
                ["pipeline", d.pipeline.join(" → ")],
              ].map(([k, v]) => (
                <div key={k} className={k === "pipeline" ? "col-span-2" : ""}>
                  <div className="text-[9px] uppercase tracking-[0.05em] text-dark-dim">
                    {k}
                  </div>
                  <div className="mt-0.5 break-words text-dark-text">{v}</div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.05em] text-dark-dim">
              live surfaces preview
            </div>
            <TypePreview type={draftType} dark />
          </div>

          <div>
            <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.05em] text-dark-dim">
              yaml — what the platform stores
            </div>
            <pre className="overflow-x-auto rounded-xl border border-dark-line bg-dark p-4 font-mono text-[10.5px] leading-relaxed text-dark-soft">
              {typeToYaml(draftType)}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
