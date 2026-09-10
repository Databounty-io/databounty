// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { startOfUtcWeek, weekStarts, weekStartsBetween, MIN_WEEKS, MAX_WEEKS, DEFAULT_WEEKS } from "./analytics.js";

/**
 * Pure unit tests — no database. The bucket list is computed twice in this
 * feature, once here in TypeScript and once by `date_trunc('week', … AT TIME
 * ZONE 'UTC')` in SQL, and the whole series silently misaligns by a day if the
 * two disagree about when a week starts. These pin the TypeScript half:
 * Monday-start, UTC, and no drift across a DST change in the host's local
 * timezone (the aggregates are UTC, so the machine's zone must not matter).
 */
describe("startOfUtcWeek", () => {
  it("returns the Monday of the containing week", () => {
    // Wednesday 2026-09-02 → Monday 2026-08-31.
    expect(startOfUtcWeek(new Date("2026-09-02T13:45:00Z")).toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });

  it("treats Monday as the first day, not the last", () => {
    expect(startOfUtcWeek(new Date("2026-08-31T00:00:00Z")).toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });

  it("puts Sunday in the week that started six days earlier", () => {
    // The off-by-one this guards: getUTCDay() calls Sunday 0, so an unshifted
    // implementation would start Sunday's week on Sunday itself.
    expect(startOfUtcWeek(new Date("2026-09-06T23:59:59Z")).toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });

  it("ignores the time of day, including late-evening UTC", () => {
    expect(startOfUtcWeek(new Date("2026-09-02T23:59:59.999Z")).toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });
});

describe("weekStarts", () => {
  it("returns exactly `weeks` buckets ending with the current week", () => {
    const buckets = weekStarts(4, new Date("2026-09-02T10:00:00Z"));
    expect(buckets).toEqual(["2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31"]);
  });

  it("is strictly ascending and exactly seven days apart", () => {
    const buckets = weekStarts(MAX_WEEKS, new Date("2026-09-02T10:00:00Z"));
    expect(buckets).toHaveLength(MAX_WEEKS);
    for (let i = 1; i < buckets.length; i += 1) {
      const gap = Date.parse(`${buckets[i]}T00:00:00Z`) - Date.parse(`${buckets[i - 1]}T00:00:00Z`);
      expect(gap).toBe(7 * 24 * 60 * 60 * 1000);
    }
  });

  it("crosses a year boundary without repeating or skipping a week", () => {
    const buckets = weekStarts(6, new Date("2027-01-06T00:00:00Z"));
    expect(buckets).toEqual([
      "2026-11-30",
      "2026-12-07",
      "2026-12-14",
      "2026-12-21",
      "2026-12-28",
      "2027-01-04",
    ]);
    expect(new Set(buckets).size).toBe(buckets.length);
  });

  it("keeps every bucket on a Monday", () => {
    for (const day of weekStarts(DEFAULT_WEEKS, new Date("2026-03-29T12:00:00Z"))) {
      expect(new Date(`${day}T00:00:00Z`).getUTCDay()).toBe(1);
    }
  });

  it("serves the smallest supported window", () => {
    expect(weekStarts(MIN_WEEKS, new Date("2026-09-02T10:00:00Z"))).toHaveLength(MIN_WEEKS);
  });
});

// Owner instruction 2026-09-07: analytics is chosen by date range, so the
// bucket list has to be derivable from two explicit dates as well as from a
// trailing count.
describe("weekStartsBetween", () => {
  it("returns the weeks CONTAINING from and to, not the weeks after them", () => {
    // 2026-07-08 is a Wednesday, 2026-07-22 a Wednesday two weeks later.
    const buckets = weekStartsBetween(new Date("2026-07-08T12:00:00Z"), new Date("2026-07-22T12:00:00Z"));
    expect(buckets).toEqual(["2026-07-06", "2026-07-13", "2026-07-20"]);
  });

  it("returns exactly one bucket when both dates fall in the same week", () => {
    expect(weekStartsBetween(new Date("2026-07-07T00:00:00Z"), new Date("2026-07-11T23:59:59Z")))
      .toEqual(["2026-07-06"]);
  });

  it("returns one bucket for a single instant", () => {
    expect(weekStartsBetween(new Date("2026-07-09T09:00:00Z"), new Date("2026-07-09T09:00:00Z")))
      .toEqual(["2026-07-06"]);
  });

  it("starts every bucket on a Monday in UTC, like the trailing-window list", () => {
    for (const day of weekStartsBetween(new Date("2025-11-03T00:00:00Z"), new Date("2026-02-01T00:00:00Z"))) {
      expect(new Date(`${day}T00:00:00Z`).getUTCDay()).toBe(1);
    }
  });

  it("crosses a year boundary without gaps or repeats", () => {
    const buckets = weekStartsBetween(new Date("2026-12-20T00:00:00Z"), new Date("2027-01-10T00:00:00Z"));
    expect(new Set(buckets).size).toBe(buckets.length);
    for (let i = 1; i < buckets.length; i += 1) {
      const prev = new Date(`${buckets[i - 1]}T00:00:00Z`).getTime();
      const cur = new Date(`${buckets[i]}T00:00:00Z`).getTime();
      expect(cur - prev).toBe(7 * 24 * 60 * 60 * 1000);
    }
  });

  it("agrees with weekStarts when the range is the trailing window", () => {
    const now = new Date("2026-09-02T10:00:00Z");
    const trailing = weekStarts(6, now);
    const first = new Date(`${trailing[0]}T00:00:00Z`);
    expect(weekStartsBetween(first, now)).toEqual(trailing);
  });
});
