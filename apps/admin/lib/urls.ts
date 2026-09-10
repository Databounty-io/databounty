// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-app base URLs. The app is split into separately-deployed Next.js
 * apps (landing, web/dashboard, admin) — internal Next <Link>/router.push
 * works for same-app routes, while cross-app transitions use full-page
 * navigation to one of these origins.
 */
export const LANDING_URL =
  process.env.NEXT_PUBLIC_LANDING_URL ?? "http://localhost:3001";
export const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3000";
export const ADMIN_URL =
  process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:3002";
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
