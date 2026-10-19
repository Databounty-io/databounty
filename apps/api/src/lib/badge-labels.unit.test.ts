// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { awardLabel, catalogLabel, renderLabel } from "./badge-labels.js";

const itemsAccepted = { label: "{value} items accepted", metric: "accepted_items", threshold: 500 } as const;
const topTen = { label: "Top 10 all time", metric: "leaderboard_rank", threshold: 10 } as const;
const manualWithToken = { label: "{value} founding contributor", metric: "manual", threshold: 1 } as const;

describe("badge labels never show the {value} template", () => {
  it("fills an award with the amount measured when it was awarded", () => {
    expect(awardLabel(itemsAccepted, 1234)).toBe("1,234 items accepted");
  });

  it("falls back to the threshold for an award recorded without a measured value", () => {
    expect(awardLabel(itemsAccepted, null)).toBe("500 items accepted");
    expect(awardLabel(itemsAccepted, undefined)).toBe("500 items accepted");
  });

  it("shows a catalog entry with its threshold, matching its criteria text", () => {
    expect(catalogLabel(itemsAccepted)).toBe("500 items accepted");
  });

  it("leaves a label without the token exactly as written", () => {
    expect(awardLabel(topTen, 3)).toBe("Top 10 all time");
    expect(catalogLabel(topTen)).toBe("Top 10 all time");
  });

  it("drops a token that nothing can fill on a manual badge, rather than showing it", () => {
    expect(awardLabel(manualWithToken, null)).toBe("founding contributor");
    expect(catalogLabel(manualWithToken)).toBe("founding contributor");
  });

  it("still fills a manual badge that was granted with a value", () => {
    expect(awardLabel(manualWithToken, 7)).toBe("7 founding contributor");
  });

  it("keeps renderLabel's existing contract", () => {
    expect(renderLabel("{value} items accepted", 1234)).toBe("1,234 items accepted");
    expect(renderLabel("{value} items accepted", null)).toBe("{value} items accepted");
    expect(renderLabel("Founding contributor", null)).toBe("Founding contributor");
  });
});
