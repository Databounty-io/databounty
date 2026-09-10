// SPDX-License-Identifier: Apache-2.0

import type { Persona } from "./store";

/**
 * Single source of truth for "where does a signed-in user land?".
 *
 * `/overview` is retired as a destination — it is no longer in the sidebar
 * and the route itself now redirects here. Every entry point that used to
 * push `/overview` (root redirect, end of onboarding, the retired overview
 * route) resolves through this instead, so they can never drift apart.
 *
 * Every login lands on `/analytics` regardless of persona preference.
 *
 * Owner instruction 2026-09-07: Analytics is the starting page, and a member
 * finishing sign-up lands there too. Onboarding itself is unaffected — it runs
 * first and only calls through here once it completes, so the sequence is
 * sign up -> onboarding -> Analytics. The one deliberate exception is the
 * onboarding MCP-client path, which passes its own `/developers` destination
 * because the member explicitly asked to connect an agent; an explicit
 * destination always beats this default (see components/auth.tsx `finish()`).
 *
 * Note for whoever reads this next: a brand-new account has no submissions and
 * no audits, so its first view of Analytics is empty by definition. That is
 * handled honestly — `WorkspaceAnalytics` renders real zero buckets and an
 * empty state rather than implying activity — but it is the trade-off this
 * choice accepts, and `/profile` (the previous landing route) is still one
 * click away in the sidebar.
 */
export function resolveHomeRoute(_persona?: Persona): string {
  return "/analytics";
}
