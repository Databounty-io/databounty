// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import path from "node:path";

import type { NextConfig } from "next";

const HOISTED_ROOT = path.resolve(__dirname, "../../..");

const output = process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined;

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
];

const nextConfig: NextConfig = {
  output,
  // Local-dev only, and a no-op anywhere else. In this checkout the apps sit in
  // an npm workspace whose `node_modules` is hoisted to a parity-rebuild root
  // ABOVE `community/` — but `community/` is its own git repository, so
  // Turbopack stops its workspace-root search at that boundary and never
  // reaches the hoisted tree, leaving `next` itself unresolvable.
  //
  // The guard matters: in the published standalone repo there is no ancestor
  // workspace, so `../../..` would point outside the repository. We only take
  // the override when that ancestor really is the tree holding `next`, which is
  // true in the monorepo checkout and false everywhere else.
  ...(existsSync(path.join(HOISTED_ROOT, "node_modules", "next")) ? { turbopack: { root: HOISTED_ROOT } } : {}),
  images: { unoptimized: true },
  trailingSlash: true,
  headers: async () => [{ source: "/:path*", headers: securityHeaders }],
  // The public dataset listing moved /bounties -> /pools (owner-ratified
  // vocabulary change, see the decision register). These are permanent (308)
  // rather than a silent 404: the old paths were public, linked from
  // /domains and the footer, listed in sitemap.xml and llms.txt, and may be
  // indexed or bookmarked. A 308 also transfers ranking signal to the new
  // path, which a 404 or a client-side rewrite would discard.
  redirects: async () => [
    // Destinations carry the trailing slash to match `trailingSlash: true`
    // above; without it each hit pays an extra 308 (/pools -> /pools/).
    { source: "/bounties", destination: "/pools/", permanent: true },
    { source: "/bounties/:id", destination: "/pools/:id/", permanent: true },
  ],
};

export default nextConfig;
