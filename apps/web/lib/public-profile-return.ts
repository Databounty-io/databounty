// SPDX-License-Identifier: Apache-2.0

import { LANDING_URL } from "./urls";

/**
 * Query key shared with landing public-profile calls to action. The value is
 * a handle, never a URL, so the dashboard can safely return a new member to
 * the profile that introduced them to DataBounty without becoming an open
 * redirect.
 */
export const PUBLIC_PROFILE_RETURN_PARAM = "returnToPublicProfile";

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$/;

export function readPublicProfileReturnHandle(value: string | null): string | null {
  const handle = value?.trim().toLowerCase();
  return handle && HANDLE_RE.test(handle) && !handle.includes("--") ? handle : null;
}

export function publicProfileReturnUrl(handle: string): string {
  return `${LANDING_URL}/${encodeURIComponent(handle)}`;
}
