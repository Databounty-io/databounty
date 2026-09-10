// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { planMultipartParts, S3_MAX_PARTS, S3_MIN_PART_BYTES } from "./types.js";

const MB = 1024 * 1024;

describe("planMultipartParts", () => {
  it("splits an exact multiple into equal parts numbered from 1", () => {
    const parts = planMultipartParts(32 * MB, 16 * MB);
    expect(parts).toEqual([
      { partNumber: 1, sizeBytes: 16 * MB, offset: 0 },
      { partNumber: 2, sizeBytes: 16 * MB, offset: 16 * MB },
    ]);
  });

  it("makes only the final part smaller and the offsets contiguous", () => {
    const total = 40 * MB;
    const parts = planMultipartParts(total, 16 * MB);
    expect(parts.map((p) => p.sizeBytes)).toEqual([16 * MB, 16 * MB, 8 * MB]);
    // Offsets tile the object with no gap or overlap, summing to the total.
    expect(parts[0]!.offset).toBe(0);
    expect(parts[2]!.offset).toBe(32 * MB);
    expect(parts.reduce((n, p) => n + p.sizeBytes, 0)).toBe(total);
  });

  it("produces a single part for an object at or below the part size", () => {
    expect(planMultipartParts(5 * MB, 16 * MB)).toEqual([{ partNumber: 1, sizeBytes: 5 * MB, offset: 0 }]);
  });

  it("rejects a non-positive total", () => {
    expect(() => planMultipartParts(0, 16 * MB)).toThrow(/positive integer/);
    expect(() => planMultipartParts(-1, 16 * MB)).toThrow(/positive integer/);
  });

  it("rejects a part size below the S3 5 MB floor", () => {
    expect(() => planMultipartParts(100 * MB, S3_MIN_PART_BYTES - 1)).toThrow(/partSizeBytes must be between/);
  });

  it("rejects a plan that would exceed the 10,000-part limit", () => {
    // 10,001 parts at the 5 MB floor.
    expect(() => planMultipartParts((S3_MAX_PARTS + 1) * S3_MIN_PART_BYTES, S3_MIN_PART_BYTES)).toThrow(/exceeding the 10000-part limit/);
  });

  it("allows exactly the 10,000-part boundary", () => {
    const parts = planMultipartParts(S3_MAX_PARTS * S3_MIN_PART_BYTES, S3_MIN_PART_BYTES);
    expect(parts).toHaveLength(S3_MAX_PARTS);
    expect(parts.at(-1)!.partNumber).toBe(S3_MAX_PARTS);
  });
});
