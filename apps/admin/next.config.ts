// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import path from "node:path";

import type { NextConfig } from "next";

const HOISTED_ROOT = path.resolve(__dirname, "../../..");

// Served Next.js app by default. `output` is opt-in via NEXT_OUTPUT, matching
// apps/web and apps/landing, so the same source can still be built as a
// standalone server image (NEXT_OUTPUT=standalone) or as a static site
// (NEXT_OUTPUT=export) without editing this file.
//
// This app was previously pinned to `output: "export"` unconditionally. That
// forced every page to be pre-rendered with no server runtime, which is why
// the three detail pages read their id from a `?id=` query param instead of a
// real dynamic segment — `/users/[id]` would have needed generateStaticParams,
// which cannot enumerate ids that do not exist at build time. Defaulting to a
// served app removes that constraint; the query-param routes still work
// unchanged, so this is a strictly less restrictive change.
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
  // Only applies to the served/standalone builds — `next build` cannot attach
  // headers to a static `export`, where the host is responsible for them.
  // This console carries destructive controls (restrict account, resolve
  // dispute, pause pool) whose API cookie is same-site with it in any real
  // deployment, so a framed console is clickjackable.
  //
  // Strict-Transport-Security and the frame-ancestors Content-Security-Policy
  // mirror apps/landing/next.config.ts exactly (same value, same scope). A
  // broader CSP (script-src/connect-src/etc.) is deliberately not attempted
  // here — this admin console makes live API calls and a stricter policy
  // needs testing against every third-party/script surface before it's safe
  // to add.
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
