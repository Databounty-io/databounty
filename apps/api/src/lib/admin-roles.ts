// SPDX-License-Identifier: Apache-2.0

export const ADMIN_ROLES = ["admin", "member", "support"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
