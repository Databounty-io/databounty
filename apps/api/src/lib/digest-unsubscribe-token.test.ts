// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  createDigestUnsubscribeToken,
  digestUnsubscribeUrl,
  readDigestUnsubscribeToken,
} from "./digest-unsubscribe-token.js";

const NOW = Date.UTC(2026, 7, 13);
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

describe("routine digest unsubscribe capability token", () => {
  it("round-trips the user id it was issued for", () => {
    const token = createDigestUnsubscribeToken("user_private_id", NOW);
    expect(readDigestUnsubscribeToken(token, NOW)).toEqual({ userId: "user_private_id" });
  });

  it("is opaque — the link never carries the user id in readable form", () => {
    const token = createDigestUnsubscribeToken("user_private_id", NOW);
    expect(token).not.toContain("user_private_id");
    // ...and not merely base64-hidden either.
    expect(Buffer.from(token.slice("du1.".length), "base64url").toString("latin1")).not.toContain(
      "user_private_id"
    );
  });

  it("is non-deterministic per issue (random IV), so tokens are not a stable user identifier", () => {
    expect(createDigestUnsubscribeToken("u1", NOW)).not.toEqual(createDigestUnsubscribeToken("u1", NOW));
  });

  it("expires", () => {
    const token = createDigestUnsubscribeToken("u1", NOW);
    expect(readDigestUnsubscribeToken(token, NOW + YEAR_MS - 1000)).toEqual({ userId: "u1" });
    expect(readDigestUnsubscribeToken(token, NOW + YEAR_MS + 1000)).toBeNull();
  });

  // Fail-closed matrix. Every one of these must yield null — never a userId.
  it("fails closed on a tampered or malformed token", () => {
    const token = createDigestUnsubscribeToken("u1", NOW);
    const body = token.slice("du1.".length);
    const bytes = Buffer.from(body, "base64url");

    const flipped = Buffer.from(bytes);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1]! ^ 0xff) & 0xff;

    const flippedIv = Buffer.from(bytes);
    flippedIv[0] = (flippedIv[0]! ^ 0xff) & 0xff;

    const flippedTag = Buffer.from(bytes);
    flippedTag[13] = (flippedTag[13]! ^ 0xff) & 0xff;

    const cases: string[] = [
      "", // missing
      "   ", // blank
      token.slice(4), // prefix stripped
      `du2.${body}`, // wrong version prefix
      `du1.${body}tampered`, // appended garbage
      `du1.${flipped.toString("base64url")}`, // ciphertext bit flip
      `du1.${flippedIv.toString("base64url")}`, // IV bit flip
      `du1.${flippedTag.toString("base64url")}`, // auth-tag bit flip
      `du1.${bytes.subarray(0, 20).toString("base64url")}`, // truncated below iv+tag+1
      "du1.", // empty payload
      "du1.!!!not-base64!!!",
      // A session-style HMAC token must not be readable as an unsubscribe
      // capability (distinct key domain).
      `du1.${Buffer.from("u1.sig", "utf8").toString("base64url")}`,
    ];
    for (const candidate of cases) {
      expect(readDigestUnsubscribeToken(candidate, NOW), candidate.slice(0, 24)).toBeNull();
    }
  });

  it("does not accept a token issued for a different user id as another user", () => {
    const a = createDigestUnsubscribeToken("user_a", NOW);
    expect(readDigestUnsubscribeToken(a, NOW)).toEqual({ userId: "user_a" });
    expect(readDigestUnsubscribeToken(a, NOW)).not.toEqual({ userId: "user_b" });
  });

  it("builds an unsubscribe URL whose token verifies back to the same user", () => {
    const url = new URL(digestUnsubscribeUrl("user_x"));
    expect(url.pathname.endsWith("/notifications/unsubscribe-digest")).toBe(true);
    const token = url.searchParams.get("token");
    expect(token).toBeTruthy();
    expect(readDigestUnsubscribeToken(token!)).toEqual({ userId: "user_x" });
    expect(url.toString()).not.toContain("user_x");
  });
});
