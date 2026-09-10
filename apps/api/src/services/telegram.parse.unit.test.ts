// SPDX-License-Identifier: Apache-2.0

/**
 * Untrusted-input parsing for the Telegram webhook body. Pure — no DB, no
 * network. `parseTelegramUpdate` is the first thing a webhook payload hits, so
 * it must never throw on a hostile shape and must never invent a chat id.
 */
import { describe, expect, it } from "vitest";
import { parseTelegramUpdate } from "./telegram.js";

describe("parseTelegramUpdate", () => {
  it("reads a real Telegram message update", () => {
    expect(
      parseTelegramUpdate({
        update_id: 1,
        message: { text: "/start abc", chat: { id: 4242 }, from: { id: 4242, username: "someone" } },
      })
    ).toEqual({ text: "/start abc", chatId: "4242", handle: "someone" });
  });

  it("tolerates edited_message", () => {
    expect(parseTelegramUpdate({ edited_message: { text: "/link abc", chat: { id: 7 } } })).toEqual({
      text: "/link abc",
      chatId: "7",
      handle: null,
    });
  });

  it("falls back to from.id when chat.id is absent", () => {
    expect(parseTelegramUpdate({ message: { text: "hi", from: { id: 9 } } })).toEqual({
      text: "hi",
      chatId: "9",
      handle: null,
    });
  });

  it("returns null (never throws) for anything that is not a usable text message", () => {
    for (const body of [
      null,
      undefined,
      "",
      "a string",
      42,
      [],
      {},
      { message: null },
      { message: "not an object" },
      { message: {} }, // no chat id at all
      { message: { text: "hi", chat: {} } },
      { message: { text: "hi", chat: { id: null } } },
      { message: { text: "hi", chat: { id: { nested: true } } } }, // object id is not an identity
      { edited_message: 5 },
    ]) {
      expect(parseTelegramUpdate(body), JSON.stringify(body) ?? "undefined").toBeNull();
    }
  });

  it("never coerces a non-string username into a handle", () => {
    expect(parseTelegramUpdate({ message: { text: "hi", chat: { id: 1 }, from: { id: 1, username: 99 } } })).toEqual({
      text: "hi",
      chatId: "1",
      handle: null,
    });
  });

  it("normalises a missing text to an empty string rather than dropping the update", () => {
    // A sticker/photo update still has a chat, and the caller decides it is
    // not a link command — silently returning null here would hide that.
    expect(parseTelegramUpdate({ message: { chat: { id: 3 } } })).toEqual({ text: "", chatId: "3", handle: null });
  });
});
