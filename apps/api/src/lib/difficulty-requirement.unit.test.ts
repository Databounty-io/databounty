// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { difficultyRequirement } from "./difficulty-requirement.js";

describe("difficultyRequirement", () => {
  it("returns the canned guidance for a canonical level", () => {
    const r = difficultyRequirement("advanced");
    expect(r.selectedDifficulty).toBe("advanced");
    expect(r.guidance).toContain("multiple interacting constraints");
  });

  it("resolves the historical `expert` spelling to advanced rather than mispricing it", () => {
    const r = difficultyRequirement("expert");
    // The label is echoed as written; the GUIDANCE is the advanced one.
    expect(r.selectedDifficulty).toBe("expert");
    expect(r.guidance).toBe(difficultyRequirement("advanced").guidance);
  });

  it("is case- and whitespace-insensitive on the way in, exact on the way out", () => {
    const r = difficultyRequirement("  Beginner  ");
    expect(r.selectedDifficulty).toBe("Beginner");
    expect(r.guidance).toBe(difficultyRequirement("beginner").guidance);
  });

  it("quotes an unrecognized label verbatim instead of silently substituting a level", () => {
    const r = difficultyRequirement("wizard");
    expect(r.guidance).toContain('"wizard"');
    expect(r.guidance).not.toBe(difficultyRequirement("intermediate").guidance);
  });

  it("says 'none declared' for an absent difficulty rather than defaulting to a middle level", () => {
    for (const absent of [null, undefined, "", "   "]) {
      const r = difficultyRequirement(absent);
      expect(r.selectedDifficulty).toBeNull();
      expect(r.guidance).toContain("no selected difficulty");
      expect(r.guidance).not.toBe(difficultyRequirement("intermediate").guidance);
    }
  });

  it("never lets a sample lower the requirement", () => {
    for (const d of ["beginner", "advanced", null]) {
      expect(difficultyRequirement(d).sampleRule).toMatch(/never lower|not a substitute/i);
    }
  });

  it("does not resolve a prototype-chain key as a difficulty level", () => {
    const r = difficultyRequirement("constructor");
    expect(r.guidance).toContain('"constructor"');
  });
});
