// SPDX-License-Identifier: Apache-2.0

/**
 * Which sections of a public profile the member has chosen to show.
 *
 * `User.publicProfilePrefs` is free-form JSON written from the dashboard's
 * profile page. Every section defaults to shown, and a stored value that is
 * not a real boolean is read as that default rather than as hidden, which is
 * the rule `routes/v1/profiles.ts` has applied since SEC-10. Both anonymous
 * profile reads (`/v1/profiles/handle/:handle` and
 * `/v1/community/members/:handle`) go through this one function, so the two
 * cannot disagree about what a member hid.
 */
export interface PublicProfileVisibility {
  /** The "karma & tier" toggle: the balance and everything derived from it. */
  showKarma: boolean;
  showBadges: boolean;
  showDatasets: boolean;
  showActivity: boolean;
}

export function publicProfileVisibility(prefs: unknown): PublicProfileVisibility {
  const stored = prefs && typeof prefs === "object" && !Array.isArray(prefs) ? (prefs as Record<string, unknown>) : {};
  const shown = (key: keyof PublicProfileVisibility) => {
    const value = stored[key];
    return typeof value === "boolean" ? value : true;
  };
  return {
    showKarma: shown("showKarma"),
    showBadges: shown("showBadges"),
    showDatasets: shown("showDatasets"),
    showActivity: shown("showActivity"),
  };
}
