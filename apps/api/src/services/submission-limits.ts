// SPDX-License-Identifier: Apache-2.0

import { getAdminSetting } from "./admin-settings.js";
import { MCP_BULK_THRESHOLD_ITEMS, SUBMISSION_ITEMS_HARD_MAX } from "../mcp/core/limits.js";

const MAX_ITEMS_KEY = "submissions.max_items_per_request";
const BULK_THRESHOLD_KEY = "submissions.mcp_bulk_threshold_items";

function boundedInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= SUBMISSION_ITEMS_HARD_MAX
    ? value
    : fallback;
}

/** The broad server ceiling. The pool-specific ceiling below is deliberately
 * stricter: an open pool always has the reviewed bulk-upload alternative. */
export async function getMaxItemsPerRequest(): Promise<number> {
  try {
    return boundedInt(await getAdminSetting<unknown>(MAX_ITEMS_KEY, SUBMISSION_ITEMS_HARD_MAX), SUBMISSION_ITEMS_HARD_MAX);
  } catch {
    return SUBMISSION_ITEMS_HARD_MAX;
  }
}

/** The live handoff threshold. Invalid/missing settings fail safely to the
 * deployed default instead of silently widening one transaction. */
export async function getBulkThresholdItems(): Promise<number> {
  const [configured, maxItems] = await Promise.all([
    getAdminSetting<unknown>(BULK_THRESHOLD_KEY, MCP_BULK_THRESHOLD_ITEMS).catch(() => MCP_BULK_THRESHOLD_ITEMS),
    getMaxItemsPerRequest(),
  ]);
  return Math.min(boundedInt(configured, MCP_BULK_THRESHOLD_ITEMS), maxItems);
}

/** On a community pool, the inline ceiling is the live bulk threshold. Work
 * above it must use the browser's parse-and-review handoff, never a long DB
 * transaction disguised as a normal MCP submission. */
export async function getPoolSubmitLimits(): Promise<{ maxItemsPerRequest: number; bulkThresholdItems: number }> {
  const bulkThresholdItems = await getBulkThresholdItems();
  return { maxItemsPerRequest: bulkThresholdItems, bulkThresholdItems };
}

export class SubmissionItemLimitError extends Error {
  constructor(count: number, max: number) {
    super(
      `This pool accepts at most ${max} inline item${max === 1 ? "" : "s"}; ` +
        `${count} items should be submitted through create_upload_review_link so the user can review the parsed rows first.`,
    );
  }
}
