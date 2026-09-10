// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { telegramWebhookSecret, verifyTelegramWebhookSecret } from "./telegram-webhook-secret.js";

const SECRET = "s3cr3t-webhook-token";

describe("telegram webhook secret configuration", () => {
  it("treats unset, empty and whitespace-only as NOT configured", () => {
    expect(telegramWebhookSecret({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(telegramWebhookSecret({ TELEGRAM_WEBHOOK_SECRET: "" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(telegramWebhookSecret({ TELEGRAM_WEBHOOK_SECRET: "   " } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("returns the configured secret verbatim", () => {
    expect(telegramWebhookSecret({ TELEGRAM_WEBHOOK_SECRET: SECRET } as NodeJS.ProcessEnv)).toBe(SECRET);
  });
});

describe("telegram webhook secret verification fails closed", () => {
  it("accepts only an exact match", () => {
    expect(verifyTelegramWebhookSecret(SECRET, SECRET)).toBe(true);
  });

  it("rejects when no secret is configured, whatever is presented", () => {
    expect(verifyTelegramWebhookSecret(SECRET, undefined)).toBe(false);
    expect(verifyTelegramWebhookSecret("", undefined)).toBe(false);
    expect(verifyTelegramWebhookSecret(undefined, undefined)).toBe(false);
  });

  it("rejects a missing, empty or non-string header", () => {
    for (const presented of [undefined, null, "", 0, 1, true, {}, [], [SECRET]]) {
      expect(verifyTelegramWebhookSecret(presented, SECRET), JSON.stringify(presented) ?? "undefined").toBe(false);
    }
  });

  it("rejects near-miss values without throwing on length mismatch", () => {
    for (const presented of [
      "wrong",
      SECRET.slice(0, -1), // truncated
      `${SECRET}x`, // extended
      SECRET.toUpperCase(), // case differs
      ` ${SECRET}`, // padded
      `${SECRET}\n`,
      "x".repeat(4096), // very long
    ]) {
      expect(verifyTelegramWebhookSecret(presented, SECRET), presented.slice(0, 24)).toBe(false);
    }
  });
});
