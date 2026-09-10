// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  decodeDateCursor,
  filterKeyOf,
  takePage,
  InvalidCursorError,
  CursorFilterMismatchError,
} from "./keyset-cursor.js";

/**
 * The shared keyset cursor replaced four hand-rolled implementations that used
 * three different encodings, only one of which bound the cursor to its filter
 * set. These tests lock in the two properties that motivated the extraction:
 * a cursor cannot be replayed under a different filter, and `hasMore` is
 * truthful at the exact-multiple boundary where the naive length check lies.
 */
describe("keyset cursor", () => {
  const FK = filterKeyOf(["open", "widgets", null]);

  it("round-trips a date key and its tiebreaker id", () => {
    const at = new Date("2026-09-07T10:00:00.000Z");
    const { createdAt, id } = decodeDateCursor(encodeCursor(at, "row_1", FK), FK);
    expect(createdAt.toISOString()).toBe(at.toISOString());
    expect(id).toBe("row_1");
  });

  it("round-trips a non-date key, so score-ordered queries share the envelope", () => {
    // services/karma.ts orders by karmaTotal, not createdAt.
    expect(decodeCursor(encodeCursor(4200, "user_9", FK), FK).key).toBe("4200");
  });

  it("REFUSES a cursor minted under a different filter instead of paging the wrong set", () => {
    // The bug this exists to prevent: caller pages with status=open, switches
    // to status=closed, replays nextCursor. An unbound cursor would return
    // closed rows positioned by an open-row offset — wrong rows, 200 OK.
    const token = encodeCursor(new Date(), "row_1", FK);
    expect(() => decodeCursor(token, filterKeyOf(["closed", "widgets", null]))).toThrow(CursorFilterMismatchError);
  });

  it("distinguishes filter sets that differ only by field position", () => {
    // A naive concatenation would collide these two.
    expect(filterKeyOf(["a", "b"])).not.toBe(filterKeyOf(["b", "a"]));
  });

  it("does not let a value containing the separator forge another filter key", () => {
    // Without escaping, ["a|b", ""] and ["a", "b"] would both render "a|b".
    expect(filterKeyOf(["a|b", ""])).not.toBe(filterKeyOf(["a", "b"]));
  });

  it("treats null and undefined as the same empty slot, so an omitted filter is stable", () => {
    expect(filterKeyOf(["x", null])).toBe(filterKeyOf(["x", undefined]));
  });

  it.each([
    ["not base64", "!!!not-base64!!!"],
    ["base64 of non-JSON", Buffer.from("plain text", "utf8").toString("base64url")],
    ["a JSON array", Buffer.from(JSON.stringify([1, 2]), "utf8").toString("base64url")],
    ["a wrong version", Buffer.from(JSON.stringify({ v: 99, c: "x", i: "y", f: "" }), "utf8").toString("base64url")],
    ["a missing field", Buffer.from(JSON.stringify({ v: 1, c: "x" }), "utf8").toString("base64url")],
  ])("rejects %s as an invalid cursor rather than an empty page", (_label, token) => {
    // An empty 200 is byte-identical to "you have no rows" — the failure mode
    // v1's own route comment says must never ship.
    expect(() => decodeCursor(token, "")).toThrow(InvalidCursorError);
  });

  it("rejects a well-formed cursor carrying an unparseable date", () => {
    const token = Buffer.from(JSON.stringify({ v: 1, c: "not-a-date", i: "row_1", f: FK }), "utf8").toString(
      "base64url",
    );
    expect(() => decodeDateCursor(token, FK)).toThrow(InvalidCursorError);
  });

  it("reports hasMore=false when the total is an EXACT multiple of the page size", () => {
    // The regression the over-fetch prevents: with `rows.length === limit` a
    // 10-row table paged at 5 advertises a third page that does not exist, and
    // a client that trusts hasMore loops on an empty result.
    expect(takePage([1, 2, 3, 4, 5], 5)).toEqual({ items: [1, 2, 3, 4, 5], hasMore: false });
  });

  it("trims the sentinel row and reports hasMore=true when one more exists", () => {
    expect(takePage([1, 2, 3, 4, 5, 6], 5)).toEqual({ items: [1, 2, 3, 4, 5], hasMore: true });
  });

  it("handles a short and an empty page", () => {
    expect(takePage([1, 2], 5)).toEqual({ items: [1, 2], hasMore: false });
    expect(takePage([], 5)).toEqual({ items: [], hasMore: false });
  });
});