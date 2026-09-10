// SPDX-License-Identifier: Apache-2.0

/**
 * Shared bulk-item parsing for contributor submissions. Used by the
 * community open-pool submit page so JSON/JSONL/CSV/TSV ingestion, field
 * normalisation, and readiness checks stay consistent.
 */
import { requiredMissing } from "@/components/dynamic-item-fields";
import type { DatasetType } from "@/lib/dataset-types";
import type { GenerationMethod, Submission } from "@/lib/types";

export interface ParsedItem {
  raw?: Record<string, unknown>;
  title: string;
  prompt: string;
  brokenCode: string;
  fixedCode: string;
  tests: string;
  explanation: string;
  generationMethod: GenerationMethod;
  bugType: string;
}

export const MAX_BULK_SOURCE_BYTES = 10 * 1024 * 1024;

const GEN_VALUES: GenerationMethod[] = ["human", "ai_assisted", "ai_generated"];

function coerceGeneration(v: unknown): GenerationMethod {
  const s = String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]/g, "_");
  return (GEN_VALUES as string[]).includes(s) ? (s as GenerationMethod) : "human";
}

/** Read a value from an object accepting camelCase or snake_case keys. */
function pick(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== "") return String(row[k]);
  }
  return "";
}

/** Label for a row in the bulk review list. `title` is only ever populated from
 * a literal `title` key, and most contracts don't have one, so fall back to the
 * first meaningful field so rows are distinguishable (mirrors the API's own
 * titleFromPayload behaviour). */
export function rowLabel(item: ParsedItem): string {
  const candidate = item.title || item.prompt || item.explanation || "";
  const oneLine = candidate.replace(/\s+/g, " ").trim();
  return oneLine.length > 90 ? `${oneLine.slice(0, 89)}…` : oneLine;
}

function normalizeItem(row: Record<string, unknown>): ParsedItem {
  return {
    raw: row,
    title: pick(row, "title"),
    prompt: pick(row, "prompt"),
    brokenCode: pick(row, "brokenCode", "broken_code"),
    fixedCode: pick(row, "fixedCode", "fixed_code"),
    tests: pick(row, "tests"),
    explanation: pick(row, "explanation"),
    generationMethod: coerceGeneration(pick(row, "generationMethod", "generation_method")),
    bugType: pick(row, "bugType", "bug_type"),
  };
}

export function payloadForDataset(
  type: DatasetType | null,
  input: Partial<Submission> | ParsedItem
): Record<string, unknown> {
  const raw = ("raw" in input && input.raw ? input.raw : input) as Record<string, unknown>;
  const get = (...keys: string[]) => {
    for (const key of keys) {
      const value = (raw as Record<string, unknown>)[key] ?? (input as Record<string, unknown>)[key];
      if (value != null && String(value).trim() !== "") return value;
    }
    return "";
  };
  // Data-driven: build the payload from the dataset type's OWN field schema, so
  // ANY type submits the right shape with no per-type code. Each field is read
  // by its key, tolerating a camelCase alias from the form state.
  if (type?.fields?.length) {
    const out: Record<string, unknown> = {};
    for (const field of type.fields) {
      const camel = field.key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      out[field.key] = get(field.key, camel);
    }
    return out;
  }

  // No schema available (offline/unknown) — a minimal generic fallback.
  return {
    title: get("title"),
    prompt: get("prompt"),
    broken_code: get("broken_code", "brokenCode"),
    fixed_code: get("fixed_code", "fixedCode"),
    tests: get("tests", "test_code"),
    explanation: get("explanation"),
    bug_type: get("bug_type", "bugType"),
  };
}

export function itemReady(it: ParsedItem, type: DatasetType | null = null): boolean {
  return requiredMissing(type, payloadForDataset(type, it)).length === 0;
}

/** RFC-4180-style parsing preserves delimiters and newlines inside quoted fields. */
function parseDelimited(text: string, delimiter: "," | "\t", format: "CSV" | "TSV"): ParsedItem[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (quoted) throw new Error(`${format} contains an unterminated quoted value.`);
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  if (rows.length < 2) throw new Error(`${format} needs a header row and at least one data row.`);
  const headers = rows[0].map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, "") : value).trim());
  if (headers.some((header) => !header)) throw new Error(`Every ${format} column needs a non-empty header.`);
  if (new Set(headers).size !== headers.length) throw new Error(`${format} headers must be unique.`);
  return rows.slice(1).map((cells, rowIndex) => {
    if (cells.length !== headers.length) {
      throw new Error(`${format} row ${rowIndex + 2} has ${cells.length} columns; expected ${headers.length}.`);
    }
    const record: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      record[h] = cells[i];
    });
    return normalizeItem(record);
  });
}

function parseJson(text: string): ParsedItem[] {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (cause) {
    throw new Error(`Invalid JSON: ${cause instanceof Error ? cause.message : "could not parse the document"}`);
  }
  if (!Array.isArray(data)) throw new Error("JSON must be an array of item objects.");
  return data.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`JSON item ${index + 1} must be an object.`);
    }
    return normalizeItem(row as Record<string, unknown>);
  });
}

function parseJsonLines(text: string): ParsedItem[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  const items: ParsedItem[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index].trim();
    if (!source) continue;
    let row: unknown;
    try {
      row = JSON.parse(source);
    } catch (cause) {
      throw new Error(`Invalid JSONL on line ${index + 1}: ${cause instanceof Error ? cause.message : "could not parse the object"}`);
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`JSONL line ${index + 1} must contain one JSON object.`);
    }
    items.push(normalizeItem(row as Record<string, unknown>));
  }
  if (items.length === 0) throw new Error("JSONL needs at least one non-empty object line.");
  return items;
}

export function parseFile(name: string, text: string): ParsedItem[] {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return parseJson(text);
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return parseJsonLines(text);
  if (lower.endsWith(".csv")) return parseDelimited(text, ",", "CSV");
  if (lower.endsWith(".tsv")) return parseDelimited(text, "\t", "TSV");
  // Files without a recognized suffix may still be ingested when their content is unambiguous.
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return parseJson(text);
  if (trimmed.startsWith("{")) return parseJsonLines(text);
  const header = trimmed.split(/\r?\n/, 1)[0] ?? "";
  if (header.includes("\t")) return parseDelimited(text, "\t", "TSV");
  if (header.includes(",")) return parseDelimited(text, ",", "CSV");
  throw new Error("Unsupported bulk file. Choose JSON, JSONL/NDJSON, CSV, or TSV.");
}
