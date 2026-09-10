// SPDX-License-Identifier: Apache-2.0

import { config } from "../config.js";

/**
 * Pool room, computed for the READ side so an agent or a browser can plan a
 * contribution before spending a submit call.
 *
 * WHY THIS IS A READ-SIDE SURFACE. Pool-wide capacity is enforced inside the
 * submit path's locked transaction. Exposing the same snapshot here keeps MCP
 * and browser guidance aligned with the real remaining room without inventing
 * a per-contributor share cap.
 *
 * It is a SNAPSHOT, not a reservation: another contributor can take the last
 * slot between this read and a submit, and the locked transaction remains the
 * only authority. Present it as "room right now", never as a promise.
 *
 * THREE DELIBERATE DIVERGENCES FROM V1, each recorded because a later "restore
 * the v1 version" would silently break something here:
 *
 *  1. NO SEPARATE COUNT QUERY. V1 issues its own `submission.count` over a
 *     twelve-status held set. Here the reserved figure is `Bounty.acceptedItems`,
 *     which `recomputeAcceptedItemCounters` maintains from `POOL_CAPACITY_STATUSES`
 *     (services/submission-acceptance.ts) — the SAME four statuses the submit
 *     path gates on. Deriving from it makes `capacity.poolRemaining` equal
 *     `poolSummary.remainingToTarget` by construction; a fresh count could
 *     disagree with the counter inside a single response.
 *
 *  2. NO `userId`. V1's parameter is unused (`_userId`) and its `yourRemaining`
 *     is documented there as a pool-wide compatibility alias. The contract
 *     route here is deliberately unauthenticated, so there is no user in scope
 *     and nothing may claim to be per-contributor.
 *
 *  3. `maxItemsThisCall` IS ADVISORY, NOT THE REJECT CAP. On v1's pool path the
 *     bulk threshold and the reject cap are the same number. Here they are not:
 *     the threshold is 20 and the hard cap is 100. `maxItemsThisCall` keeps
 *     v1's meaning — the most one call SHOULD carry — while `submitLimits.
 *     maxItemsPerRequest` remains the most it MAY carry.
 */

export interface PoolCapacity {
  /** Slots left in the pool overall, across every contributor. */
  poolRemaining: number;
  /**
   * Kept for client compatibility; equals `poolRemaining`. Contributors are not
   * share-capped, and this surface has no authenticated user, so it is
   * pool-wide room and must never be presented as one person's allowance.
   */
  yourRemaining: number;
  /**
   * Largest item count one submit call SHOULD carry right now: bounded by the
   * pool's room and by the count above which the bulk-source file path is the
   * better tool. Not the reject cap — see `submitLimits.maxItemsPerRequest`.
   */
  maxItemsThisCall: number;
  /** Which path to take. `bulk_upload` when the set is larger than one call should carry. */
  recommendedPath: "submit_pool_items" | "bulk_upload" | "none";
  /** Plain-language next step, safe to relay verbatim. Never a dead end. */
  nextStep: string;
  /** Where to go when this pool has no room left. */
  alternatives: { browsePoolsUrl: string; sponsorDatasetUrl: string };
}

function appUrl(path: string): string {
  return `${config.appUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function poolCapacityFor(params: {
  /** `Number(bounty.targetItems)`. */
  targetItems: number;
  /** `Number(bounty.acceptedItems)` — the cleared/occupied counter. */
  capacityReserved: number;
  /** `submitLimits.bulkThresholdItems`. */
  bulkThresholdItems: number;
  /** Live pool status. A pool that is not open cannot be submitted to at all. */
  acceptingContributions: boolean;
}): PoolCapacity {
  const { targetItems, capacityReserved, bulkThresholdItems, acceptingContributions } = params;
  const poolRemaining = Math.max(0, targetItems - capacityReserved);

  const alternatives = {
    browsePoolsUrl: appUrl("community"),
    sponsorDatasetUrl: appUrl("sponsor/create"),
  };

  // Not in v1: v1's capacity block knows only "full", so a paused pool with
  // room left still returned `recommendedPath: "submit_pool_items"` and invited
  // a submit the route then rejected on status. The status is already loaded
  // here, so the dead end is closed rather than reproduced.
  if (!acceptingContributions) {
    return {
      poolRemaining,
      yourRemaining: poolRemaining,
      maxItemsThisCall: 0,
      recommendedPath: "none",
      nextStep:
        "This pool is not accepting contributions right now, so a submission would be refused regardless of the room left. " +
        "Try another open pool, or sponsor a dataset of your own from the dashboard if none of them fit what you want to work on.",
      alternatives,
    };
  }

  if (poolRemaining === 0) {
    return {
      poolRemaining: 0,
      yourRemaining: 0,
      maxItemsThisCall: 0,
      recommendedPath: "none",
      nextStep:
        "This pool is full — every slot is held by an item in review or already accepted. " +
        "Try another open pool, or sponsor a dataset of your own from the dashboard if none of them fit what you want to work on.",
      alternatives,
    };
  }

  const maxItemsThisCall = Math.min(poolRemaining, bulkThresholdItems);
  const recommendedPath = poolRemaining > bulkThresholdItems ? "bulk_upload" : "submit_pool_items";
  return {
    poolRemaining,
    yourRemaining: poolRemaining,
    maxItemsThisCall,
    recommendedPath,
    nextStep:
      recommendedPath === "bulk_upload"
        ? `You can contribute up to ${poolRemaining} more items here. That's more than one submit call should carry ` +
          `(above ${bulkThresholdItems}), so upload the whole set as one bulk-source file instead of looping submit_pool_items.`
        : `You can contribute up to ${poolRemaining} more item${poolRemaining === 1 ? "" : "s"} here, in a single submit call.`,
    alternatives,
  };
}
