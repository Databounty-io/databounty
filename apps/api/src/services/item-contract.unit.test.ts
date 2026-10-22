// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  assertItemsMatchContract,
  contractRowError,
  FIELD_CONTRACT_MISMATCH,
  ITEM_FIELDS_INVALID,
  ItemContractError,
  itemContractErrorBody,
  itemProblems,
  type ContractField,
} from "./item-contract.js";

const FIELDS: ContractField[] = [
  { key: "instruction", label: "Instruction", role: "instruction", required: true },
  { key: "difficulty", label: "Difficulty", role: "enum", options: ["easy", "hard"] },
  { key: "notes", label: "Notes", role: "rationale" },
];

function caught(fn: () => void): ItemContractError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ItemContractError) return err;
    throw err;
  }
  throw new Error("expected an ItemContractError");
}

describe("itemProblems", () => {
  it("accepts an item that fills every required field, and ignores keys the contract does not declare", () => {
    expect(itemProblems(FIELDS, { instruction: "Sort the list", difficulty: "easy", agentRunId: "r1" })).toEqual([]);
  });

  it("treats a missing, null, blank or whitespace-only required value as missing", () => {
    for (const instruction of [undefined, null, "", "   \n"]) {
      expect(itemProblems(FIELDS, { instruction })).toEqual([{ field: "instruction", reason: "missing" }]);
    }
  });

  it("treats an empty list or empty object as missing, the same as the dashboard form", () => {
    expect(itemProblems(FIELDS, { instruction: [] })).toEqual([{ field: "instruction", reason: "missing" }]);
    expect(itemProblems(FIELDS, { instruction: {} })).toEqual([{ field: "instruction", reason: "missing" }]);
    expect(itemProblems(FIELDS, { instruction: ["step one"] })).toEqual([]);
  });

  it("counts false and 0 as values, not as missing", () => {
    expect(itemProblems(FIELDS, { instruction: false })).toEqual([]);
    expect(itemProblems(FIELDS, { instruction: 0 })).toEqual([]);
  });

  it("refuses an enum value the type does not list, and names the allowed values", () => {
    expect(itemProblems(FIELDS, { instruction: "x", difficulty: "medium" })).toEqual([
      { field: "difficulty", reason: "not_an_option", allowed: ["easy", "hard"] },
    ]);
    expect(itemProblems(FIELDS, { instruction: "x", difficulty: " hard " })).toEqual([]);
  });

  it("leaves an optional enum alone when it is left empty", () => {
    expect(itemProblems(FIELDS, { instruction: "x", difficulty: "" })).toEqual([]);
    expect(itemProblems(FIELDS, { instruction: "x" })).toEqual([]);
  });

  it("reports every problem with an item, in contract order", () => {
    expect(itemProblems(FIELDS, { difficulty: "extreme" })).toEqual([
      { field: "instruction", reason: "missing" },
      { field: "difficulty", reason: "not_an_option", allowed: ["easy", "hard"] },
    ]);
  });

  it("needs a multi-file field to hold at least minCount file ids", () => {
    const files: ContractField[] = [{ key: "images", role: "file", required: true, minCount: 2, maxCount: 4 }];
    expect(itemProblems(files, { images: ["a", "b"] })).toEqual([]);
    expect(itemProblems(files, { images: ["a"] })).toEqual([{ field: "images", reason: "missing" }]);
    expect(itemProblems(files, { images: "a" })).toEqual([{ field: "images", reason: "missing" }]);
    expect(itemProblems(files, {})).toEqual([{ field: "images", reason: "missing" }]);
  });

  it("needs a single-file field to hold a file id", () => {
    const file: ContractField[] = [{ key: "audio", role: "file", required: true }];
    expect(itemProblems(file, { audio: "art_123" })).toEqual([]);
    expect(itemProblems(file, { audio: "" })).toEqual([{ field: "audio", reason: "missing" }]);
  });
});

describe("assertItemsMatchContract", () => {
  it("enforces nothing when the pool has no declared contract", () => {
    expect(() => assertItemsMatchContract([], [{}, { anything: 1 }])).not.toThrow();
  });

  it("passes when every item conforms", () => {
    expect(() => assertItemsMatchContract(FIELDS, [{ instruction: "a" }, { instruction: "b" }])).not.toThrow();
  });

  it("names the field when a single item is refused", () => {
    const err = caught(() => assertItemsMatchContract(FIELDS, [{ difficulty: "medium" }]));
    expect(err.code).toBe(ITEM_FIELDS_INVALID);
    expect(err.message).toBe(
      'This item does not match the pool\'s field contract: "instruction" is required; "difficulty" must be one of "easy", "hard".',
    );
    expect(err.items).toEqual([
      {
        index: 0,
        problems: [
          { field: "instruction", reason: "missing" },
          { field: "difficulty", reason: "not_an_option", allowed: ["easy", "hard"] },
        ],
      },
    ]);
  });

  it("lists only the failing items of a batch, by 1-based position, and says nothing was submitted", () => {
    const err = caught(() =>
      assertItemsMatchContract(FIELDS, [{ instruction: "fine" }, { instruction: "" }, { instruction: "ok", difficulty: "x" }]),
    );
    expect(err.items.map((item) => item.index)).toEqual([1, 2]);
    expect(err.total).toBe(3);
    expect(err.message).toBe(
      '2 of 3 items do not match the pool\'s field contract, so none were submitted. item 2: "instruction" is required | item 3: "difficulty" must be one of "easy", "hard".',
    );
  });

  it("keeps the message short for a large batch but still returns every failing item", () => {
    const payloads = Array.from({ length: 8 }, () => ({}));
    const err = caught(() => assertItemsMatchContract(FIELDS, payloads));
    expect(err.items).toHaveLength(8);
    expect(err.message).toContain("8 of 8 items");
    expect(err.message).toContain("item 5:");
    expect(err.message).not.toContain("item 6:");
    expect(err.message).toContain("(and 3 more)");
  });

  it("produces the REST error body the intake routes send", () => {
    const err = caught(() => assertItemsMatchContract(FIELDS, [{}]));
    expect(itemContractErrorBody(err)).toEqual({
      statusCode: 400,
      error: "Bad Request",
      code: ITEM_FIELDS_INVALID,
      message: err.message,
      items: [{ index: 0, problems: [{ field: "instruction", reason: "missing" }] }],
    });
  });
});

describe("contractRowError", () => {
  it("returns null for a conforming upload row", () => {
    expect(contractRowError(FIELDS, { instruction: "a" })).toBeNull();
  });

  it("returns the same code and message for rows with the same problems, so the review page can group them", () => {
    const first = contractRowError(FIELDS, { instruction: " " });
    const second = contractRowError(FIELDS, {});
    expect(first).toEqual({ errorCode: FIELD_CONTRACT_MISMATCH, errorMessage: '"instruction" is required' });
    expect(second).toEqual(first);
  });
});
