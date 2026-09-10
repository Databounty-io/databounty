// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { poolCapacityFor } from "./pool-capacity.js";
import { config } from "../config.js";

const base = { bulkThresholdItems: 20, acceptingContributions: true };

describe("poolCapacityFor", () => {
  it("reports a full pool as a dead end with somewhere to go", () => {
    const c = poolCapacityFor({ ...base, targetItems: 100, capacityReserved: 100 });
    expect(c).toMatchObject({ poolRemaining: 0, yourRemaining: 0, maxItemsThisCall: 0, recommendedPath: "none" });
    expect(c.nextStep).toContain("This pool is full");
    // Never a dead end: both escape hatches are absolute URLs.
    expect(c.alternatives.browsePoolsUrl).toBe(`${config.appUrl.replace(/\/+$/, "")}/community`);
    expect(c.alternatives.sponsorDatasetUrl).toBe(`${config.appUrl.replace(/\/+$/, "")}/sponsor/create`);
  });

  it("never reports negative room when the counter overshoots the target", () => {
    expect(poolCapacityFor({ ...base, targetItems: 10, capacityReserved: 25 }).poolRemaining).toBe(0);
  });

  it("routes a large remainder to the bulk path, capped at the advisory threshold", () => {
    const c = poolCapacityFor({ ...base, targetItems: 500, capacityReserved: 0 });
    expect(c.recommendedPath).toBe("bulk_upload");
    // Advisory ceiling, NOT the reject cap (submitLimits.maxItemsPerRequest is 100).
    expect(c.maxItemsThisCall).toBe(20);
    expect(c.nextStep).toContain("500 more items");
    expect(c.nextStep).toContain("above 20");
  });

  it("routes a small remainder to a single inline call", () => {
    const c = poolCapacityFor({ ...base, targetItems: 100, capacityReserved: 95 });
    expect(c).toMatchObject({ poolRemaining: 5, maxItemsThisCall: 5, recommendedPath: "submit_pool_items" });
  });

  it("says 'item', not 'items', when exactly one slot is left", () => {
    const c = poolCapacityFor({ ...base, targetItems: 100, capacityReserved: 99 });
    expect(c.nextStep).toContain("1 more item here");
    expect(c.nextStep).not.toContain("1 more items");
  });

  it("treats the threshold boundary as inline, not bulk", () => {
    expect(poolCapacityFor({ ...base, targetItems: 20, capacityReserved: 0 }).recommendedPath).toBe("submit_pool_items");
    expect(poolCapacityFor({ ...base, targetItems: 21, capacityReserved: 0 }).recommendedPath).toBe("bulk_upload");
  });

  it("refuses to invite a submit into a pool that is not accepting contributions", () => {
    // A paused pool with plenty of room: v1 would still have said
    // "submit_pool_items" and the route would then have rejected it.
    const c = poolCapacityFor({ ...base, targetItems: 500, capacityReserved: 0, acceptingContributions: false });
    expect(c).toMatchObject({ poolRemaining: 500, maxItemsThisCall: 0, recommendedPath: "none" });
    expect(c.nextStep).toContain("not accepting contributions");
  });

  it("keeps yourRemaining equal to poolRemaining — it is not a per-contributor allowance", () => {
    const c = poolCapacityFor({ ...base, targetItems: 300, capacityReserved: 40 });
    expect(c.yourRemaining).toBe(c.poolRemaining);
  });
});
