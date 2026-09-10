// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-app base URLs for DataBounty Community.
 */
export const LANDING_URL =
  process.env.NEXT_PUBLIC_LANDING_URL ?? "http://localhost:3001";
export const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3000";
export const ADMIN_URL =
  process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:3002";
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
/** One canonical client-facing MCP endpoint for every dashboard surface. */
export const MCP_URL = `${DASHBOARD_URL.replace(/\/+$/, "")}/mcp`;
