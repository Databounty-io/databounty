// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-app base URLs for DataBounty Community.
 */
export const LANDING_URL =
  process.env.NEXT_PUBLIC_LANDING_URL ?? "http://localhost:3001";
export const DASHBOARD_URL =
  (process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
export const DASHBOARD_HOME_URL = `${DASHBOARD_URL}/`;
/** One canonical client-facing MCP endpoint for every landing surface. */
export const MCP_URL = `${DASHBOARD_URL}/mcp`;
export const ADMIN_URL =
  process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:3002";
