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
