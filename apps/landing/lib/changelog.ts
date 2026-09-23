// SPDX-License-Identifier: Apache-2.0

/**
 * Public product changelog.
 *
 * Single source of truth for BOTH the /changelog page and the repository-root
 * CHANGELOG.md at ../../../CHANGELOG.md (Keep a Changelog format). When you add a
 * release here, mirror it into that file in the same commit so the two never drift.
 *
 * The mirror lived at apps/landing/CHANGELOG.md while landing was its own repository;
 * it moved to the monorepo root on 2026-09-01. There is exactly one mirror — do not
 * reintroduce a second copy inside this app.
 *
 * Keep entries user-facing and honest: describe what a sponsor, contributor,
 * or validator can now see or do — never internal refactors or unshipped work.
 */

export type ChangeKind = "added" | "changed" | "fixed";

export type ChangeEntry = {
  kind: ChangeKind;
  text: string;
};

export type Release = {
  /** Semver-ish tag shown as the headline, e.g. "2026.08.0". */
  version: string;
  /**
   * ISO date (YYYY-MM-DD) the release went live. Omit for an unreleased entry —
   * the page renders no date rather than inventing one.
   */
  date?: string;
  /** Short human title for the release. */
  title: string;
  /** One-line summary shown under the title. */
  summary?: string;
  entries: ChangeEntry[];
};

export const CHANGELOG_KIND_LABEL: Record<ChangeKind, string> = {
  added: "Added",
  changed: "Changed",
  fixed: "Fixed",
};

/** Newest first. */
export const CHANGELOG: Release[] = [
  {
    version: "2026.09.22",
    date: "2026-09-22",
    title: "Notification delivery and connector reliability",
    summary: "Email notifications now reach every member, duplicates are gone, and connectors recover on their own.",
    entries: [
      {
        kind: "fixed",
        text: "Some members were not receiving email notifications at all. Their account had no delivery destination, so digests and alerts were recorded but never sent.",
      },
      {
        kind: "fixed",
        text: "The same event could appear more than once in your notifications.",
      },
      {
        kind: "fixed",
        text: "Daily digest entries older than seven days were never delivered, and could stop a member's digest being sent at all.",
      },
      {
        kind: "fixed",
        text: "Turning the daily digest off could not be undone. You can switch it back on from notification settings.",
      },
      {
        kind: "fixed",
        text: "A connector whose session had expired kept retrying that session instead of reconnecting. Connectors now reconnect on their own.",
      },
      {
        kind: "changed",
        text: "An email destination is now added when you verify your address, rather than when you create the account, so notifications are never sent to an address that has not been confirmed.",
      },
      {
        kind: "changed",
        text: "API responses are now compressed, cutting transfer size by roughly three quarters.",
      },
      {
        kind: "changed",
        text: "The community catalogue list no longer returns each dataset type's field contract, verification settings and sample assets. Request a single dataset type to retrieve them.",
      },
      {
        kind: "changed",
        text: "The connector token endpoint now applies a rate limit. A client repeatedly presenting an expired credential is asked to slow down instead of retrying without limit.",
      },
    ],
  },
  {
    version: "2026.09.09",
    date: "2026-09-09",
    title: "Public changelog",
    summary: "A short, public record of product updates.",
    entries: [
      {
        kind: "added",
        text: "The public DataBounty changelog is live.",
      },
    ],
  },
];
