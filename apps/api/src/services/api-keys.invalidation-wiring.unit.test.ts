// SPDX-License-Identifier: Apache-2.0

/**
 * A wiring test: every route that can suspend an account must also drop that
 * account's cached API keys.
 *
 * WHY IT IS A SOURCE SCAN AND NOT A BEHAVIOUR TEST. The behaviour is already
 * covered — `api-keys.cache.integration.test.ts` proves `invalidateUserApiKeys`
 * does the right thing. What that cannot cover is the case this guards: someone
 * adds a FOURTH place that suspends an account (there are three today, in
 * admin.ts, admin-contributors.ts and admin-validators.ts, all doing the same
 * thing by hand) and does not know the cache exists. Every existing test still
 * passes, and suspended accounts keep authenticating through that one route for
 * up to the cache TTL.
 *
 * The underlying shape is the real problem — account suspension is copy-pasted
 * across three routes instead of living in one service — and the honest fix is
 * to consolidate them. Until that happens this is the cheap guard that makes
 * the omission loud instead of silent.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROUTES_DIR = new URL("../routes", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") && !entry.includes(".test.")) out.push(full);
  }
  return out;
}

/** A `user.update`/`updateMany` whose data block sets `status`. */
function writesUserStatus(src: string): boolean {
  const re = /\buser\.update(Many)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // The `data: { ... }` that follows, within a reasonable window.
    const window = src.slice(m.index, m.index + 400);
    if (/data:\s*\{[^}]*\bstatus\b/.test(window)) return true;
  }
  return false;
}

describe("API key cache invalidation wiring", () => {
  it("every route that writes User.status also invalidates that account's API keys", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(ROUTES_DIR)) {
      const src = readFileSync(file, "utf8");
      if (!writesUserStatus(src)) continue;
      if (!src.includes("invalidateUserApiKeys")) offenders.push(file.replace(ROUTES_DIR, "routes"));
    }

    expect(offenders).toEqual([]);
  });

  it("finds the three routes that suspend accounts today, so the scan is not vacuous", () => {
    // If this drops to zero the detector above has stopped matching anything
    // and would report success for a codebase it is no longer reading.
    const matched = sourceFiles(ROUTES_DIR).filter((f) => writesUserStatus(readFileSync(f, "utf8")));

    expect(matched.length).toBeGreaterThanOrEqual(3);
  });
});
