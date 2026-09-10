// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { SETTINGS_CATALOG, validateAdminSettingValue } from "./admin-settings.js";

/**
 * Write-path validation for `PUT /v1/admin/settings/:key`.
 *
 * Pure unit test — imports only the catalog module, which touches no database.
 */
describe("validateAdminSettingValue", () => {
  it("rejects a key that is not in the catalog", () => {
    const result = validateAdminSettingValue("notifications.digest.schedule", "09:00");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("unknown_key");
    expect(result.message).toContain("notifications.digest.schedule");
  });

  it("rejects an arbitrary typo'd key rather than persisting a row nothing reads", () => {
    const result = validateAdminSettingValue("launch.comunity.enabled", true);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("unknown_key");
  });

  it("rejects a value that fails its key's schema", () => {
    // Known key, wrong type.
    const wrongType = validateAdminSettingValue("launch.community.enabled", "yes");
    expect(wrongType.ok).toBe(false);
    if (wrongType.ok) throw new Error("unreachable");
    expect(wrongType.reason).toBe("invalid_value");

    // Known key, right type, out of the range the reader would accept anyway.
    const outOfRange = validateAdminSettingValue("notifications.delivery.max_attempts", 0);
    expect(outOfRange.ok).toBe(false);

    // Known key, structurally valid, but violates the cross-field invariant.
    const auditOutEarnsContributor = validateAdminSettingValue("karma.rules", {
      acceptedItem: { beginner: 10, intermediate: 25, advanced: 60 },
      auditItem: 10,
      confirmedFlag: 25,
      requestApproved: 25,
      publishBonus: 150,
      bountyPublished: 50,
    });
    expect(auditOutEarnsContributor.ok).toBe(false);
    if (auditOutEarnsContributor.ok) throw new Error("unreachable");
    expect(auditOutEarnsContributor.message).toContain("auditItem");
  });

  it("accepts valid values for the notification delivery keys notifications.ts reads", () => {
    expect(validateAdminSettingValue("notifications.delivery.max_attempts", 3)).toEqual({ ok: true, value: 3 });
    expect(validateAdminSettingValue("notifications.delivery.lease_seconds", 120)).toEqual({ ok: true, value: 120 });
    expect(validateAdminSettingValue("notifications.delivery.backoff_seconds", [5, 10])).toEqual({ ok: true, value: [5, 10] });
    expect(validateAdminSettingValue("notifications.digest.time", "09:00")).toEqual({ ok: true, value: "09:00" });
    expect(validateAdminSettingValue("notifications.digest.timezone", "Asia/Kolkata")).toEqual({
      ok: true,
      value: "Asia/Kolkata",
    });
    expect(validateAdminSettingValue("notifications.digest.time", "9am").ok).toBe(false);
    expect(validateAdminSettingValue("notifications.digest.timezone", "Mars/Olympus").ok).toBe(false);
  });

  it("every catalog default validates against its own schema", () => {
    for (const entry of SETTINGS_CATALOG) {
      const result = validateAdminSettingValue(entry.key, entry.defaultValue);
      expect(result, `default for ${entry.key} must satisfy its schema`).toMatchObject({ ok: true });
    }
  });

  it("has no duplicate catalog keys", () => {
    const keys = SETTINGS_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
