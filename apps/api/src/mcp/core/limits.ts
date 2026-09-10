// SPDX-License-Identifier: Apache-2.0

/**
 * Per-request item-count ceiling for a single inline contribution call.
 *
 * v1 declares this in `lib/submission-item-limits.ts` and binds
 * `submit_pool_items`' `items` array with it (`.min(1).max(
 * SUBMISSION_ITEMS_HARD_MAX)`). Community's tool had NO bound at all, so an
 * agent could hand `submit_pool_items` an array of any length: the whole array
 * is written inside one transaction, so an oversized call does not fail
 * cleanly — it times out, having burned a tool call and told the caller
 * nothing. Bounding it at the schema boundary is the same "reject at the edge
 * with the operative limit named" behaviour v1 has.
 *
 * The value mirrors the live figure this API already advertises to
 * contributors as `submitLimits.maxItemsPerRequest`
 * (`services/bounties.ts` — the pool contract's own submit limits), so the
 * schema bound and the number the contract tells an agent to respect cannot
 * disagree.
 */
export const SUBMISSION_ITEMS_HARD_MAX = 100;

/**
 * Above this count an inline submit is the wrong tool and the browser
 * hand-off (`create_upload_review_link`) is the right one. Advisory — it is
 * the number quoted in tool copy, not a reject boundary.
 * Mirrors `submitLimits.bulkThresholdItems` in `services/bounties.ts`.
 */
export const MCP_BULK_THRESHOLD_ITEMS = 20;
