// SPDX-License-Identifier: Apache-2.0

import type { Prisma } from "@prisma/client";
import type { prisma } from "../lib/prisma.js";

/**
 * Checks submitted items against their pool's field contract, on the server.
 *
 * Every dataset type declares its fields (key, role, required, and the allowed
 * `options` of an enum). The dashboard's form checks them in the browser
 * (apps/web components/dynamic-item-fields.tsx `requiredMissing`); this
 * applies the same rules on the server, on every way in (the REST routes, MCP
 * and bulk-file upload), so an item missing a required field, or using an
 * enum value its type does not allow, is refused with a message naming the
 * field instead of reaching a validator.
 *
 * Deliberately narrow: this checks presence and enum membership, the two rules
 * the contract states outright. Extra keys are allowed, because agents attach
 * their own metadata, and nothing here judges whether a value is good.
 */

export interface ContractField {
  key: string;
  label?: string;
  role?: string;
  required?: boolean;
  options?: unknown[];
  minCount?: number;
  maxCount?: number;
}

export interface ItemProblem {
  field: string;
  reason: "missing" | "not_an_option";
  allowed?: string[];
}

export interface InvalidItem {
  /** 0-based position in the request. */
  index: number;
  problems: ItemProblem[];
}

export const ITEM_FIELDS_INVALID = "ITEM_FIELDS_INVALID";
/** Upload-draft row code for a parsed row that breaks the contract. */
export const FIELD_CONTRACT_MISMATCH = "FIELD_CONTRACT_MISMATCH";

const LISTED_ITEMS = 5;

export class ItemContractError extends Error {
  readonly code = ITEM_FIELDS_INVALID;

  constructor(
    readonly items: InvalidItem[],
    readonly total: number,
  ) {
    super(describeInvalidItems(items, total));
  }
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return String(value).trim() === "";
}

/** The problems with one item, in contract order. Empty when it conforms. */
export function itemProblems(fields: ContractField[], payload: Record<string, unknown>): ItemProblem[] {
  const problems: ItemProblem[] = [];
  for (const field of fields) {
    const value = payload[field.key];
    if (field.required) {
      // A multi-file field holds an array of artifact ids and states how many
      // it needs; every other field just has to have a value.
      const missing =
        field.role === "file" && (field.maxCount ?? 1) > 1
          ? !Array.isArray(value) || value.length < (field.minCount ?? 1)
          : isBlank(value);
      if (missing) {
        problems.push({ field: field.key, reason: "missing" });
        continue;
      }
    }
    if (field.role === "enum" && Array.isArray(field.options) && field.options.length > 0 && !isBlank(value)) {
      const allowed = field.options.map((option) => String(option));
      if (!allowed.includes(String(value).trim())) {
        problems.push({ field: field.key, reason: "not_an_option", allowed });
      }
    }
  }
  return problems;
}

export function problemText(problem: ItemProblem): string {
  return problem.reason === "missing"
    ? `"${problem.field}" is required`
    : `"${problem.field}" must be one of ${(problem.allowed ?? []).map((option) => `"${option}"`).join(", ")}`;
}

function describeInvalidItems(items: InvalidItem[], total: number): string {
  if (total === 1 && items.length === 1) {
    return `This item does not match the pool's field contract: ${items[0]!.problems.map(problemText).join("; ")}.`;
  }
  const listed = items
    .slice(0, LISTED_ITEMS)
    .map((item) => `item ${item.index + 1}: ${item.problems.map(problemText).join("; ")}`)
    .join(" | ");
  const more = items.length > LISTED_ITEMS ? ` (and ${items.length - LISTED_ITEMS} more)` : "";
  return (
    `${items.length} of ${total} items do not match the pool's field contract, so none were submitted. ` +
    `${listed}${more}.`
  );
}

/**
 * The error recorded on an upload-draft row that parsed into an object but
 * breaks the contract, or null when it conforms. Rows with the same problems
 * get the same message, which is what the review page groups them by.
 */
export function contractRowError(
  fields: ContractField[],
  payload: Record<string, unknown>,
): { errorCode: string; errorMessage: string } | null {
  const problems = itemProblems(fields, payload);
  if (problems.length === 0) return null;
  return { errorCode: FIELD_CONTRACT_MISMATCH, errorMessage: problems.map(problemText).join("; ").slice(0, 500) };
}

/** Throws ItemContractError naming every non-conforming item. */
export function assertItemsMatchContract(fields: ContractField[], payloads: Record<string, unknown>[]): void {
  if (fields.length === 0) return;
  const invalid = payloads
    .map((payload, index) => ({ index, problems: itemProblems(fields, payload) }))
    .filter((item) => item.problems.length > 0);
  if (invalid.length > 0) throw new ItemContractError(invalid, payloads.length);
}

/**
 * The field contract of the dataset type a pool was minted from. Empty when the
 * pool declares no dataset type, in which case nothing is enforced rather than
 * a contract being invented for it.
 */
export async function contractFieldsForBounty(
  client: Prisma.TransactionClient | typeof prisma,
  bountyId: string,
): Promise<ContractField[]> {
  const bounty = await client.bounty.findUnique({
    where: { id: bountyId },
    select: { datasetType: { select: { fields: true } } },
  });
  const raw = bounty?.datasetType?.fields;
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter(
    (field): field is ContractField =>
      Boolean(field) && typeof field === "object" && typeof (field as ContractField).key === "string",
  );
}

/** The 400 body the REST intake routes send for an ItemContractError. */
export function itemContractErrorBody(err: ItemContractError) {
  return {
    statusCode: 400,
    error: "Bad Request",
    code: err.code,
    message: err.message,
    items: err.items,
  };
}
