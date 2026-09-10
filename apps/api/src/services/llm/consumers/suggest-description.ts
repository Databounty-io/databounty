// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import type { DatasetType } from "@prisma/client";
import { llm } from "../service.js";

/**
 * Requester helper — starter DESCRIPTIONS for the planner's free-text
 * description step.
 *
 * PARITY STATUS: DEVIATION FROM V1, deliberately and narrowly.
 *
 * v1 (`databounty-api`) has no description consumer and no description
 * assist intent. Its four `/assist` intents are `title`, `planner_copy`,
 * `draft_type` and `validate_field`; `description` appears in v1 only as a
 * `validate_field` FIELD, i.e. a value a model may JUDGE but never write.
 * v1's description step is served entirely client-side by a deterministic
 * `descriptionStarters(type, title)` helper, whose own doc comment states
 * the starters are "never model-generated, so they render instantly and
 * offline".
 *
 * This consumer therefore ADDS a capability v1 does not have. It is built to
 * be the smallest honest version of it:
 *  - `fallbackDescriptions` is a faithful server-side port of that v1 helper
 *    (title + required-field-label grounded), so the zero-key path returns
 *    exactly the class of copy v1 renders. The step never regresses.
 *  - A model may only propose ALTERNATIVE STARTER TEXT for one free-text
 *    field the requester then edits. It cannot set the field, cannot touch
 *    any chip value, karma rate, audit coverage, license or session state,
 *    and writes nothing — `POST /assist` persists no answer.
 *  - The same `enabled` / governor / cache / redaction / failover path every
 *    other consumer uses, via `llm.complete`, so an admin routing or prompt
 *    override on the console's /llm page really applies to it.
 *  - `source` is honest: `"fallback"` whenever no live model answered, and a
 *    fallback is never labelled as an LLM result.
 *
 * A model answer is accepted ONLY if every string it returns is a value the
 * planner would itself accept for `description` — see `DESCRIPTION_MIN` /
 * `DESCRIPTION_MAX` below. Anything shorter, longer, or malformed fails the
 * schema and the whole answer is discarded in favour of the deterministic
 * starters, because a "suggestion" the sponsor cannot actually submit is
 * worse than no suggestion.
 */

/**
 * The description bounds this consumer must satisfy, stated as code rather
 * than prose so a model answer that could not be submitted is never offered.
 *
 * The floor is 30, not the server's own `answersSchema.description.min(20)`
 * (`services/planner.ts`): the planner's description step refuses anything
 * under 30 characters, matching v1's client floor, so a 25-character
 * "suggestion" would be rejected the moment the requester clicked it. The
 * ceiling is the server's real `max(2000)`.
 */
export const DESCRIPTION_MIN = 30;
export const DESCRIPTION_MAX = 2_000;

const descriptionsSchema = z.object({
  descriptions: z.array(z.string().trim().min(DESCRIPTION_MIN).max(DESCRIPTION_MAX)).min(1).max(3),
});

export interface DescriptionSuggestion {
  descriptions: string[];
  /** Honest provenance. `"fallback"` means no live model answered. */
  source: "llm" | "fallback";
}

/** The minimum a caller must know about a type to get starters for it. */
export type DescriptionType = Pick<DatasetType, "name"> & {
  id?: string;
  version?: number;
  domain?: string | null;
  description?: string | null;
  /** Prisma `Json` — read defensively, never trusted to be the right shape. */
  fields?: unknown;
};

/** Required-field labels off a type's stored `fields` blob, mirroring the web
 * app's `descriptionStarters` (which reads the same contract client-side) so
 * the server fallback and the client starters describe the same template. */
export function requiredFieldLabels(fields: unknown): string[] {
  if (!Array.isArray(fields)) return [];
  const labels: string[] = [];
  for (const field of fields) {
    if (!field || typeof field !== "object" || Array.isArray(field)) continue;
    const row = field as { label?: unknown; key?: unknown; required?: unknown };
    if (row.required !== true) continue;
    const label = typeof row.label === "string" && row.label.trim() ? row.label.trim() : null;
    const key = typeof row.key === "string" && row.key.trim() ? row.key.trim() : null;
    const name = label ?? key;
    if (name) labels.push(name);
  }
  return labels;
}

/**
 * Deterministic starter descriptions — the safe default and the shape a model
 * must match. Server-side port of v1's client-only
 * `descriptionStarters(type, title)`; grounded in the chosen template's own
 * required fields and the requester's title, so it works with zero keys and
 * no egress. Every string here clears `DESCRIPTION_MIN` for any real type
 * name (the shortest variant is ~180 characters of fixed copy).
 */
export function fallbackDescriptions(type: DescriptionType, title?: string): string[] {
  const subject = title?.trim() || type.name.toLowerCase();
  const labels = requiredFieldLabels(type.fields);
  const fieldList = labels.length ? labels.join(", ") : "the fields defined by the template";
  return [
    `Each item covers ${subject}. Contributors fill ${fieldList}. A strong submission is self-contained, reproducible, and specific — avoid near-duplicates of earlier items and anything copied from a public benchmark.`,
    `We need broad coverage of ${subject}, not variations on one example. Every item must populate ${fieldList} and stand on its own. Reject-worthy: vague prompts, untested solutions, and content lifted from tutorials.`,
    `Goal: a clean, permissively licensed corpus on ${subject}. Fill ${fieldList} for every item, keep one concern per item, and make sure the expected result is verifiable rather than a matter of opinion.`,
  ].map((starter) => starter.slice(0, DESCRIPTION_MAX));
}

/**
 * Up to three starter descriptions for a community dataset request, scoped to
 * one dataset type + the requester's own working title.
 *
 * Routed through `services/llm/` as the `suggest_description` feature, which
 * guarantees no-throw and hands back the deterministic fallback below on ANY
 * failure (no key, disabled feature, network error, bad response shape,
 * budget/rate block). A model failure is therefore never a 500 and never an
 * empty step.
 */
export async function suggestRequestDescriptions(
  type: DescriptionType,
  opts: { title?: string; userId?: string; accountId?: string } = {}
): Promise<DescriptionSuggestion> {
  const title = opts.title?.trim();
  const fallback = fallbackDescriptions(type, title);
  const labels = requiredFieldLabels(type.fields);

  const res = await llm.complete({
    feature: "suggest_description",
    userId: opts.userId,
    accountId: opts.accountId,
    idempotencyKey: `suggest-description:v1:${type.id ?? type.name}:${type.version ?? 0}:${title ?? "none"}`,
    schema: descriptionsSchema,
    // No system message: the service injects the admin-editable system prompt
    // for the "suggest_description" feature. The consumer supplies only data,
    // JSON-encoded so a title containing prose cannot read as an instruction.
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          dataset_type: type.name,
          domain: type.domain ?? null,
          what_it_is: type.description ?? null,
          required_fields: labels.length ? labels : null,
          working_title: title ?? null,
          min_characters: DESCRIPTION_MIN,
          max_characters: DESCRIPTION_MAX,
        }),
      },
    ],
    fallback: { descriptions: fallback },
  });

  return {
    descriptions: res.data.descriptions.slice(0, 3),
    source: res.fallbackUsed ? "fallback" : "llm",
  };
}
