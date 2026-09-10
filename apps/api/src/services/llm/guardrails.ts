// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { ZodType, ZodTypeDef } from "zod";
import type { LlmMessage } from "./types.js";

/**
 * Guardrails. Ported verbatim from v1's `services/llm/guardrails.ts`. Pure
 * functions, no I/O, so they are trivially testable. The service composes them
 * around every provider call.
 */

/** Redact obvious secrets/PII from OUTBOUND prompt text before it leaves us.
 * Defense-in-depth on top of data-class routing — not a substitute for it. */
const REDACTIONS: Array<[RegExp, string]> = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL]"],
  [/\bsk-[A-Za-z0-9]{16,}\b/g, "[KEY]"],
  [/\b(?:xox[baprs]-|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{10,}\b/g, "[TOKEN]"],
  [/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g, "[PRIVATE_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[JWT]"],
];

export function redact(text: string): string {
  return REDACTIONS.reduce((acc, [re, sub]) => acc.replace(re, sub), text);
}

export function redactMessages(messages: LlmMessage[]): LlmMessage[] {
  return messages.map((m) => ({ ...m, content: redact(m.content) }));
}

export class GuardrailError extends Error {}

/** Cap the total outbound prompt size (chars ~ a coarse token proxy). Content
 * under review is untrusted and can be huge; refuse rather than blow the bill. */
export function assertSizeWithin(messages: LlmMessage[], maxChars: number): void {
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total > maxChars) {
    throw new GuardrailError(`prompt exceeds ${maxChars} char cap (${total})`);
  }
}

/** Stable hash for audit/cache — we store hashes, never raw prompts. */
export function hashMessages(messages: LlmMessage[]): string {
  const h = createHash("sha256");
  for (const m of messages) h.update(`${m.role}:${m.content} `);
  return h.digest("hex");
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Extract the first JSON object/array from a possibly chatty model reply. */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.search(/[[{]/);
  if (start === -1) return text.trim();
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);
  return end > start ? text.slice(start, end + 1).trim() : text.trim();
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Parse + validate model JSON against the caller's schema. On failure the
 * service does ONE bounded repair round-trip before falling back; model output
 * is never trusted unvalidated downstream. */
export function parseSchema<T>(schema: ZodType<T, ZodTypeDef, unknown>, text: string): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(extractJson(text));
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { ok: true, value: parsed.data };
}
