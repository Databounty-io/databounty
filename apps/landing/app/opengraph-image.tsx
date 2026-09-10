// SPDX-License-Identifier: Apache-2.0

import { ImageResponse } from "next/og";

// This app builds with `output: "export"` (static export) — dynamic routes
// like this one must opt into force-static or the build fails.
export const dynamic = "force-static";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Matches the actual brand: ink background (#0a0c0a-ish), lime accent
// (#a3f60a) — same colors as the Brandmark/Wordmark components, so the
// social-share card looks like it came from the same app rather than a
// generic template.
//
// Copy is kept in sync with the live hero (`app/(site)/page.tsx`) and the
// site DESCRIPTION (`app/layout.tsx`) on purpose: this card is the first
// thing anyone sees when a link is shared, so a stale pitch here is a public
// claim the product no longer makes. It previously carried the pre-D18
// pitch and mark, which survived the karma-only pivot untouched — karma and
// named credit are the only reward in this product. If the hero headline
// changes, change it here too.
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "#0a0c0a",
          color: "#f4f6ee",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              background: "#a3f60a",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 34,
              fontWeight: 800,
              color: "#0a0c0a",
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
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 48,
            fontSize: 56,
            fontWeight: 800,
            lineHeight: 1.15,
            maxWidth: 980,
          }}
        >
          <span style={{ color: "#a9ad9f" }}>Build datasets that matter.</span>
          <span>Earn karma and the credit.</span>
        </div>
        <div style={{ display: "flex", marginTop: 28, fontSize: 26, color: "#a9ad9f", maxWidth: 900 }}>
          Claim a dataset spec · submit verified items · earn karma and named credit · finished
          datasets publish to Hugging Face.
        </div>
      </div>
    ),
    { ...size }
  );
}
