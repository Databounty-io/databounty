// SPDX-License-Identifier: Apache-2.0

import { ImageResponse } from "next/og";
import { fetchPublicProfile } from "@/lib/public-data";

// Per-profile social-share card. When someone posts databounty.io/{handle} to
// Slack/X/LinkedIn, the unfurl shows the member's real name, tier, and karma
// rather than the generic site card — a meaningful share-CTR win. Brand colors
// match the Brandmark/Wordmark so it reads as first-party.
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "DataBounty public profile";

export default async function ProfileOgImage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  // Degrades to the handle alone when the profile can't be read, for either
  // reason. A social card is decorative — unlike the page itself, there is
  // nothing to be gained here from telling missing and unavailable apart.
  const result = await fetchPublicProfile(handle).catch(() => ({ status: "unavailable" }) as const);
  const profile = result.status === "ok" ? result.profile : null;
  const name = profile?.displayName ?? `@${handle}`;
  const tier = profile?.tier?.label ?? "";
  const tierColor = profile?.tier?.color ?? "#a3f60a";
  const karma = profile?.karma;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "80px",
          background: "#0a0c0a",
          color: "#f4f6ee",
          fontFamily: "sans-serif",
        }}
      >
        {/* Brand lockup */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 56, height: 56, borderRadius: "50%", background: "#a3f60a",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 34, fontWeight: 800, color: "#0a0c0a",
            }}
          >
            /
          </div>
          <div style={{ display: "flex", fontSize: 34, fontWeight: 800, letterSpacing: "0.02em" }}>
            <span>DATA</span>
            <span style={{ color: "#a3f60a" }}>/</span>
            <span>BOUNTY</span>
          </div>
        </div>

        {/* Identity */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 30, color: "#a9ad9f" }}>@{handle}</div>
          <div style={{ display: "flex", marginTop: 10, fontSize: 84, fontWeight: 800, lineHeight: 1.05, maxWidth: 1000 }}>
            {name}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 28, fontSize: 30 }}>
            {tier ? (
              <span
                style={{
                  display: "flex", padding: "6px 18px", borderRadius: 8,
                  border: `2px solid ${tierColor}`, color: tierColor, fontWeight: 700,
                  textTransform: "lowercase",
                }}
              >
                {tier}
              </span>
            ) : null}
            {karma !== undefined ? (
              <span style={{ display: "flex", color: "#a3f60a" }}>{karma.toLocaleString()} karma</span>
            ) : null}
          </div>
        </div>

        <div style={{ display: "flex", fontSize: 24, color: "#6f7a68" }}>
          Verified open-dataset contributions, built by the community.
        </div>
      </div>
    ),
    { ...size }
  );
}
