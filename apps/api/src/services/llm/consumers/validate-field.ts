// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { llm } from "../service.js";

/**
 * Requester helper — sanity-check a single free-text planner field typed by
 * hand (title / description / language / brief). Ported from v1's
 * `services/llm/consumers/validate-field.ts`.
 *
 * This is the entry-time guard for the free-text planner steps: a template is
 * chosen from a card, but these fields are open text. An "asdasdasd" title
 * must be caught here, not downstream.
 *
 * Advisory by construction: the LLM only returns a verdict; it never rewrites
 * the value and never touches economics or state.
 *
 * IT FAILS CLOSED. When no model answers, this does NOT report a pass — it
 * returns `ok: false` with an explicit "review unavailable" reason and
 * `source: "fallback"`, so the planner can hold the answer as a draft. The
 * deterministic `looksLikeGibberish` check below is the zero-key PRE-FILTER
 * (and is what decides the verdict a live model would have been asked about),
 * never a substitute AI pass.
 */

/** `brief` is the free text that DEFINES a custom or forked dataset contract —
 *  the highest-stakes input in the planner, since the model turns it into the
 *  field set every future contributor fills in. */
export type PlannerField = "title" | "description" | "language" | "brief";

const verdictSchema = z.object({
  verdict: z.enum(["ok", "reject"]),
  reason: z.string().max(240).optional().default(""),
});

const FIELD_LABEL: Record<PlannerField, string> = {
  title: "dataset title",
  description: "dataset description",
  language: "programming language / framework",
  brief:
    "description of the dataset contract to draft (what each item should contain, or what to change about the forked template)",
};

/** Conservative, deterministic "is this obvious junk?" check. Tuned to only
 * fire on clear keyboard-mashing / placeholder text so real (if terse) values
 * pass — it is both the zero-key pre-filter and a cheap gate before egress.
 *
 * The per-field asymmetry is deliberate, not an oversight: prose fields
 * (`description`, `brief`) are treated far more leniently than a `title` or a
 * `language`, because a real one-line brief ("add a difficulty label, drop the
 * rationale") is terse by nature and must not be rejected for it. */
export function looksLikeGibberish(field: PlannerField, raw: string): boolean {
  const value = raw.trim();
  if (!value) return true;
  const lower = value.toLowerCase();

  // Descriptions are prose — only reject if they are extremely short AND have
  // no spaces (a real "why it matters" sentence always has several words).
  if (field === "description" || field === "brief") {
    if (value.length < 12 && !value.includes(" ")) return maskLooksMashed(lower);
    // A brief is short by nature, so only reject when the whole thing reads as
    // mashed — never merely because it is terse.
    if (field === "brief" && !/\s/.test(value)) return maskLooksMashed(lower);
    return field === "brief" ? maskLooksMashed(lower.replace(/\s+/g, "")) : false;
  }

  // Common literal placeholders people type to skip a step.
  const PLACEHOLDERS = new Set([
    "test", "test123", "testing", "asdf", "qwerty", "abc", "abcd",
    "xxx", "none", "na", "n/a", "todo", "tbd", "foo", "bar", "foobar", "aaa",
  ]);
  const collapsed = lower.replace(/[^a-z0-9]/g, "");
  if (PLACEHOLDERS.has(lower) || PLACEHOLDERS.has(collapsed)) return true;

  return maskLooksMashed(lower);
}

/** True when the letters look mashed: very low character variety, a short
 * repeated cycle ("asdasdasd"), or a run of consonants with no vowel. */
export function maskLooksMashed(lower: string): boolean {
  const letters = lower.replace(/[^a-z]/g, "");
  if (letters.length < 4) return false; // too short to judge; let it through

  // Repeated short cycle: "asdasdasd" = "asd" x3, "abab" = "ab" x2.
  for (let unit = 1; unit <= 4; unit++) {
    if (letters.length >= unit * 3 && letters.length % unit === 0) {
      const seg = letters.slice(0, unit);
      if (seg.repeat(letters.length / unit) === letters) return true;
    }
  }

  const unique = new Set(letters).size;
  if (unique / letters.length <= 0.34) return true; // "asdasdasd" -> 3/9

  // A single long token with no vowel is almost never a real word.
  if (!lower.includes(" ") && !/[aeiou]/.test(letters) && letters.length >= 5) return true;

  return false;
}

export interface FieldVerdict {
  ok: boolean;
  reason: string;
  source: "llm" | "fallback";
}

/** Validate one requester-typed planner field. Returns a verdict the planner
 * uses to re-ask; never throws (the LLM layer guarantees no-throw). */
export async function validateSponsorField(
  field: PlannerField,
  value: string,
  opts: { userId?: string; accountId?: string; typeName?: string; typeDescription?: string } = {}
): Promise<FieldVerdict> {
  const trimmed = value.trim();
  const gibberish = looksLikeGibberish(field, trimmed);

  const res = await llm.complete({
    feature: "field_validate",
    accountId: opts.accountId,
    userId: opts.userId,
    idempotencyKey: `field-validate:v1:${field}:${trimmed.slice(0, 120)}`,
    schema: verdictSchema,
    messages: [
      {
        role: "user",
        content:
          `Field: ${FIELD_LABEL[field]}\n` +
          (opts.typeName ? `Dataset type: ${opts.typeName}\n` : "") +
          (opts.typeDescription ? `Dataset is: ${opts.typeDescription}\n` : "") +
          `Requester typed: ${JSON.stringify(trimmed)}`,
      },
    ],
    // Deterministic fallback when no model is configured. NOTE: this value is
    // NOT what the caller gets back on the fallback path — see below.
    fallback: {
      verdict: gibberish ? ("reject" as const) : ("ok" as const),
      reason: gibberish ? defaultRejectReason(field) : "",
    },
  });

  // Planner inputs must never receive a fabricated AI pass. A model outage
  // leaves the answer as a draft and the caller must show that review is
  // pending (or route it to a human), rather than silently advancing it.
  if (res.fallbackUsed) {
    return {
      ok: false,
      reason:
        "AI review is currently unavailable. This answer is saved as a draft and needs review before you can continue.",
      source: "fallback",
    };
  }

  const ok = res.data.verdict === "ok";
  return {
    ok,
    reason: ok ? "" : res.data.reason?.trim() || defaultRejectReason(field),
    source: "llm",
  };
}

export function defaultRejectReason(field: PlannerField): string {
  switch (field) {
    case "title":
      return "That looks like placeholder text. Give the dataset a specific, real title contributors can browse by.";
    case "description":
      return "That description looks like placeholder text. Say what the dataset should contain and why it matters.";
    case "language":
      return "That doesn't look like a real language or framework. Name the language the items target (e.g. Python, TypeScript · React).";
    case "brief":
      return "I couldn't tell what contract you want from that. Describe what one item should contain — or, for a fork, what to change about the template.";
  }
}
