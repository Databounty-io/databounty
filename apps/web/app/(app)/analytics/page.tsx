"use client";

// SPDX-License-Identifier: Apache-2.0

/**
 * Analytics — one place for the signed-in member's own weekly activity.
 *
 * Why this page exists: the same charts were only reachable as a section at the
 * bottom of `/contributor` and `/validator`, so a member who did both kinds of
 * work had to visit two pages and scroll to find either, and nothing in the
 * sidebar said the numbers existed at all. This route is the discoverable
 * entry point, and as of the 2026-09-07 owner instruction it is the ONLY one:
 * both workspaces dropped their embedded "Your activity" section, so these
 * retrospective charts live here and nowhere else. The workspaces keep their
 * own live signals (karma status bar, stat rails, queue counters) — those are
 * current state, not retrospective.
 *
 * Scope: D22 (approved parity deviation — Community member analytics) covers
 * exactly these member-owned retrospective charts and their accessible tables.
 * This page renders the SAME `WorkspaceAnalytics` component for both audiences
 * and adds no new series, no new collection and no cross-member view, so it
 * stays inside D22's narrow approval. V1 has no analytics surface at all, so
 * there is no parity shape to match here.
 *
 * `MEMBER_ANALYTICS_ENABLED=false` on the API unregisters `/v1/me/analytics`,
 * which is the documented rollback switch. When that happens the component
 * renders its own error state rather than this page pretending to have data.
 */

import { PageHeader } from "@/components/app-shell";
import { WorkspaceAnalytics } from "@/components/analytics";

export default function AnalyticsPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Analytics"
        sub="Your own weekly activity — what you submitted and how it was decided, and the audit calls you made. Contributor and validator views are separate because they answer different questions."
      />

      {/* Each section titles itself through the component's own SectionHeader,
          so there is exactly one heading per section rather than an outer
          label plus a second, identical "Your activity". */}
      <WorkspaceAnalytics audience="contributor" title="Your contributor activity" />
      <WorkspaceAnalytics audience="validator" title="Your validator activity" />
    </div>
  );
}
