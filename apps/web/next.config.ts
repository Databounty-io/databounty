// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import path from "node:path";

import type { NextConfig } from "next";

const HOISTED_ROOT = path.resolve(__dirname, "../../..");

const output = process.env.NEXT_OUTPUT === "standalone" ? "standalone" : process.env.NEXT_OUTPUT === "export" ? "export" : undefined;

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
  skipTrailingSlashRedirect: true,
  ...(output !== "export"
    ? {
        rewrites: async () => {
          const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
          return [
            // Proxies the MCP endpoint itself AND every OAuth endpoint beneath
            // it (`/mcp/oauth/authorize|token|register|revoke`).
            { source: "/mcp/:path*", destination: `${api}/mcp/:path*` },
            // RFC 8414 / RFC 9728 discovery. Without these, this origin serves
            // `/mcp` but 404s the metadata documents describing it, so a client
            // pointed here is sent cross-origin to the API's host to discover a
            // `resource` that does not match the endpoint it is calling —
            // lenient clients cope, strict ones reject the audience.
            //
            // The `:path*` form covers both the path-inserted documents
            // (`.../oauth-protected-resource/mcp`, the canonical URL that
            // WWW-Authenticate advertises) and the root, un-suffixed ones that
            // some clients try instead. The API registers both.
            //
            // These only take effect when the API names THIS origin as its own
            // resource — `MCP_PUBLIC_URL` must point at this host, or the
            // metadata served here still claims the API's hostname. The two
            // changes belong together.
            {
              source: "/.well-known/oauth-protected-resource/:path*",
              destination: `${api}/.well-known/oauth-protected-resource/:path*`,
            },
            {
              source: "/.well-known/oauth-authorization-server/:path*",
              destination: `${api}/.well-known/oauth-authorization-server/:path*`,
            },
          ];
        },
      }
    : {}),
  // Only applies to the served/standalone builds — `next build` cannot attach
  // headers to a static `export`, where the host (CloudFront) owns them.
  // This dashboard carries state-changing actions (claim a batch, submit
  // items, file a dispute, change profile visibility) behind a cookie that is
  // same-site with it in any real deployment, and it serves `/mcp/authorize`,
  // an OAuth consent screen — both are clickjackable when framed.
  // NOTE: a deliberate divergence from V1, whose `databounty-web` sets no
  // headers at all; needs a DECISION_REGISTER entry.
  //
  // Strict-Transport-Security and the frame-ancestors Content-Security-Policy
  // mirror apps/landing/next.config.ts exactly (same value, same scope). A
  // broader CSP (script-src/connect-src/etc.) is deliberately not attempted
  // here — this app makes live API calls and hosts the `/mcp/authorize`
  // consent screen, and a stricter policy needs testing against every
  // third-party/script surface before it's safe to add.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;
