// SPDX-License-Identifier: Apache-2.0

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelKind } from "@prisma/client";

/**
 * Regression cover for the webhook SSRF/exfil finding recorded against
 * `notification-channels.ts`: `testChannel` and `postWebhook` both called
 * `fetch` with the default `redirect: "follow"` (up to 20 hops, no
 * re-validation, no body cap), and the destination allowlist was a
 * prefix-anchored regex over the RAW string, checked only at store time.
 *
 * NO external host is contacted. The transport seam rewrites an allowlisted
 * https URL to a loopback `http` listener created here and closed again, and
 * hands the module's own `init` (redirect / signal / body) to the REAL
 * `fetch`, so `redirect: "error"` is proved against undici, not a stub.
 * Prisma is mocked: nothing here touches a database.
 */

const upsert = vi.fn(async (args: unknown) => ({ id: "row", ...(args as object) }));
const update = vi.fn(async (args: unknown) => ({ id: "row", ...(args as object) }));
const findUnique = vi.fn(async () => null as unknown);
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    notificationChannel: {
      upsert: (args: unknown) => upsert(args),
      update: (args: unknown) => update(args),
      findUnique: () => findUnique(),
      deleteMany: async () => ({ count: 0 }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  },
}));
vi.mock("./notifications.js", () => ({ notifyEvent: async () => undefined }));

const {
  ChannelError,
  WEBHOOK_MAX_RESPONSE_BYTES,
  WEBHOOK_TIMEOUT_MS,
  WebhookTransportError,
  channelRegistry,
  connectChannel,
  isAllowedWebhookUrl,
  patchChannel,
  sendWebhook,
  setWebhookFetch,
  testChannel,
} = await import("./notification-channels.js");
const { NotificationDeliveryError } = await import("../lib/notification-mailer.js");

const DISCORD_OK = "https://discord.com/api/webhooks/1234567890/abcDEF";
const GCHAT_OK = "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t";
const TEAMS_OK = "https://contoso.webhook.office.com/webhookb2/uuid@uuid/IncomingWebhook/x/y";

/** Every request the loopback server saw: path, method, body. */
let seen: Array<{ path: string; method: string; body: string }>;
/** Per-test handler for what the loopback server should answer. */
let respond: (req: IncomingMessage, res: ServerResponse) => void;
/** Every `init` the transport was handed, so redirect/signal are observable. */
let transportInits: RequestInit[];
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      seen.push({ path: req.url ?? "", method: req.method ?? "", body });
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  transportInits = [];
  upsert.mockClear();
  update.mockClear();
  findUnique.mockReset();
  respond = (_req, res) => {
    res.statusCode = 204;
    res.end();
  };
  // Rewrite ONLY the origin: path/query and, crucially, `init` pass through
  // untouched to the real fetch.
  setWebhookFetch((url, init) => {
    transportInits.push(init);
    const parsed = new URL(url);
    return fetch(`${origin}${parsed.pathname}${parsed.search}`, init);
  });
});

afterEach(() => {
  setWebhookFetch(null);
});

async function rejection<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

// ── Redirects are never followed ──────────────────────────────────────────

describe("redirects", () => {
  it("a 3xx from an allowlisted host is refused and the second hop is NEVER contacted", async () => {
    respond = (req, res) => {
      if (req.url?.startsWith("/api/webhooks/")) {
        res.statusCode = 302;
        res.setHeader("Location", "/second-hop");
        res.end();
        return;
      }
      res.statusCode = 200;
      res.end("should never be reached");
    };
    const err = await rejection(sendWebhook(ChannelKind.discord, DISCORD_OK, "hello"));
    expect(err).toBeInstanceOf(WebhookTransportError);
    expect((err as InstanceType<typeof WebhookTransportError>).redirected).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/api/webhooks/1234567890/abcDEF");
    expect(seen.some((r) => r.path === "/second-hop")).toBe(false);
    expect(transportInits[0]!.redirect).toBe("error");
  });

  it("an absolute cross-host Location is not followed either (the classic exfil shape)", async () => {
    respond = (_req, res) => {
      res.statusCode = 307;
      res.setHeader("Location", "http://127.0.0.1:1/exfil"); // a port nothing listens on: a follow would error differently
      res.end();
    };
    const err = await rejection(sendWebhook(ChannelKind.google_chat, GCHAT_OK, "hello"));
    expect(err).toBeInstanceOf(WebhookTransportError);
    expect((err as InstanceType<typeof WebhookTransportError>).redirected).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("through the dispatcher registry a redirect is a PERMANENT failure, not a retry", async () => {
    respond = (_req, res) => {
      res.statusCode = 301;
      res.setHeader("Location", "/elsewhere");
      res.end();
    };
    const err = await rejection(channelRegistry.discord(DISCORD_OK, { title: "t", body: "b" }, { userId: "u1" }));
    expect(err).toBeInstanceOf(NotificationDeliveryError);
    expect((err as InstanceType<typeof NotificationDeliveryError>).retryable).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("an injected transport that hands back a 3xx Response directly is refused too", async () => {
    setWebhookFetch(async () => new Response(null, { status: 302, headers: { location: "https://attacker.example/" } }));
    const err = await rejection(sendWebhook(ChannelKind.discord, DISCORD_OK, "hello"));
    expect(err).toBeInstanceOf(WebhookTransportError);
    expect((err as InstanceType<typeof WebhookTransportError>).redirected).toBe(true);
  });

  it("testChannel records the refused redirect as a failure and never marks the channel verified", async () => {
    respond = (_req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", "/second-hop");
      res.end();
    };
    findUnique.mockResolvedValue({ id: "row", address: DISCORD_OK, connected: true, verified: false, verifiedAt: null });
    const result = await testChannel("u1", ChannelKind.discord);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/redirect/i);
    expect(seen).toHaveLength(1);
    expect(update).toHaveBeenCalledTimes(1);
    const data = (update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.verified).toBeUndefined();
    expect(data.lastError).toMatch(/redirect/i);
  });
});

// ── The happy path still works ────────────────────────────────────────────

describe("allowlisted destinations", () => {
  it("an allowlisted Discord URL still posts the JSON payload with a timeout signal", async () => {
    const result = await sendWebhook(ChannelKind.discord, DISCORD_OK, "hello world");
    expect(result).toEqual({ status: 204, bodyBytes: 0, bodyTruncated: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(JSON.parse(seen[0]!.body)).toEqual({ content: "hello world" });
    expect(transportInits[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(transportInits[0]!.redirect).toBe("error");
    expect(WEBHOOK_TIMEOUT_MS).toBe(8_000);
  });

  it("Google Chat keeps its query string (key/token live there) and Teams tenant hosts are accepted", async () => {
    respond = (_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ name: "spaces/AAAA/messages/x" }));
    };
    const gchat = await sendWebhook(ChannelKind.google_chat, GCHAT_OK, "hi");
    expect(gchat.status).toBe(200);
    expect(gchat.bodyTruncated).toBe(false);
    expect(seen[0]!.path).toBe("/v1/spaces/AAAA/messages?key=k&token=t");
    expect(JSON.parse(seen[0]!.body)).toEqual({ text: "hi" });

    const teams = await sendWebhook(ChannelKind.microsoft_teams, TEAMS_OK, "hi");
    expect(teams.status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  it("the registry adapter resolves on 2xx and classifies non-2xx exactly as before", async () => {
    await expect(channelRegistry.discord(DISCORD_OK, { title: "t", body: "b" }, { userId: "u1" })).resolves.toBeUndefined();

    respond = (_req, res) => {
      res.statusCode = 404;
      res.end();
    };
    const gone = await rejection(channelRegistry.discord(DISCORD_OK, { title: "t", body: "b" }, { userId: "u1" }));
    expect((gone as InstanceType<typeof NotificationDeliveryError>).retryable).toBe(false);

    respond = (_req, res) => {
      res.statusCode = 429;
      res.end();
    };
    const limited = await rejection(channelRegistry.discord(DISCORD_OK, { title: "t", body: "b" }, { userId: "u1" }));
    expect((limited as InstanceType<typeof NotificationDeliveryError>).retryable).toBe(true);
  });
});

// ── Host allowlist is by parsed hostname, not raw-string prefix ───────────

describe("destination validation", () => {
  const LOOKALIKES: Array<[ChannelKind, string]> = [
    // Hostname merely STARTS with the allowlisted string, on a different host.
    [ChannelKind.discord, "https://discord.com.attacker.example/api/webhooks/1/x"],
    [ChannelKind.discord, "https://discord.comattacker.example/api/webhooks/1/x"],
    [ChannelKind.google_chat, "https://chat.googleapis.com.attacker.example/v1/spaces/x"],
    [ChannelKind.microsoft_teams, "https://contoso.webhook.office.com.attacker.example/hook"],
    // Allowlisted string in userinfo — the real host is the attacker's.
    [ChannelKind.discord, "https://discord.com@attacker.example/api/webhooks/1/x"],
    [ChannelKind.discord, "https://discord.com:443@attacker.example/api/webhooks/1/x"],
    // Allowlisted string only in the path.
    [ChannelKind.discord, "https://attacker.example/https://discord.com/api/webhooks/1/x"],
    // Right host, wrong path prefix / wrong provider's host.
    [ChannelKind.discord, "https://discord.com/api/not-webhooks/1/x"],
    [ChannelKind.discord, "https://chat.googleapis.com/v1/spaces/x"],
    [ChannelKind.google_chat, "https://discord.com/api/webhooks/1/x"],
    // Teams: tenant is exactly one label, and only under webhook.office.com.
    [ChannelKind.microsoft_teams, "https://a.b.webhook.office.com/hook"],
    [ChannelKind.microsoft_teams, "https://webhook.office.com/hook"],
    [ChannelKind.microsoft_teams, "https://contoso.webhook.office.com.evil/hook"],
    [ChannelKind.microsoft_teams, "https://contoso.office.com/hook"],
    // Non-default port, literal IP, garbage.
    [ChannelKind.discord, "https://discord.com:8443/api/webhooks/1/x"],
    [ChannelKind.discord, "https://127.0.0.1/api/webhooks/1/x"],
    [ChannelKind.discord, "not a url"],
    [ChannelKind.discord, ""],
  ];

  it("refuses a hostname that merely starts with an allowlisted string, and every other look-alike, without fetching", async () => {
    for (const [channel, url] of LOOKALIKES) {
      expect(isAllowedWebhookUrl(channel, url), url).toBe(false);
      const err = await rejection(sendWebhook(channel, url, "x"));
      expect(err, url).toBeInstanceOf(ChannelError);
    }
    expect(seen).toHaveLength(0);
    expect(transportInits).toHaveLength(0);
  });

  it("refuses a non-https URL for every provider, without fetching", async () => {
    const plain: Array<[ChannelKind, string]> = [
      [ChannelKind.discord, "http://discord.com/api/webhooks/1/x"],
      [ChannelKind.google_chat, "http://chat.googleapis.com/v1/spaces/x"],
      [ChannelKind.microsoft_teams, "http://contoso.webhook.office.com/hook"],
      [ChannelKind.discord, "ftp://discord.com/api/webhooks/1/x"],
      [ChannelKind.discord, "javascript:alert(1)//discord.com/api/webhooks/"],
    ];
    for (const [channel, url] of plain) {
      expect(isAllowedWebhookUrl(channel, url), url).toBe(false);
      expect(await rejection(sendWebhook(channel, url, "x")), url).toBeInstanceOf(ChannelError);
    }
    expect(transportInits).toHaveLength(0);
  });

  it("accepts the genuine provider shapes, case-insensitively on the host", () => {
    expect(isAllowedWebhookUrl(ChannelKind.discord, DISCORD_OK)).toBe(true);
    expect(isAllowedWebhookUrl(ChannelKind.discord, "https://DISCORD.COM/api/webhooks/1/x")).toBe(true);
    expect(isAllowedWebhookUrl(ChannelKind.discord, "https://discordapp.com/api/webhooks/1/x")).toBe(true);
    expect(isAllowedWebhookUrl(ChannelKind.google_chat, GCHAT_OK)).toBe(true);
    expect(isAllowedWebhookUrl(ChannelKind.microsoft_teams, TEAMS_OK)).toBe(true);
    expect(isAllowedWebhookUrl(ChannelKind.microsoft_teams, "https://Contoso-1.webhook.office.com/x")).toBe(true);
    // Non-webhook channels never validate as a webhook destination.
    expect(isAllowedWebhookUrl(ChannelKind.email, DISCORD_OK)).toBe(false);
    expect(isAllowedWebhookUrl(ChannelKind.slack, DISCORD_OK)).toBe(false);
  });

  it("is enforced at STORE time: connectChannel and patchChannel refuse before touching the database", async () => {
    await expect(connectChannel("u1", ChannelKind.discord, "https://discord.com.attacker.example/api/webhooks/1/x")).rejects.toBeInstanceOf(ChannelError);
    await expect(patchChannel("u1", ChannelKind.microsoft_teams, { address: "https://a.b.webhook.office.com/hook" })).rejects.toBeInstanceOf(ChannelError);
    expect(upsert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();

    await connectChannel("u1", ChannelKind.discord, DISCORD_OK);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("is enforced again at SEND time: a stored address that is no longer allowed is refused, permanently, unsent", async () => {
    // Simulates a row written before the allowlist tightened (or by any other path).
    const stale = "https://discord.com.attacker.example/api/webhooks/1/x";
    const err = await rejection(channelRegistry.discord(stale, { title: "t", body: "b" }, { userId: "u1" }));
    expect(err).toBeInstanceOf(NotificationDeliveryError);
    expect((err as InstanceType<typeof NotificationDeliveryError>).retryable).toBe(false);
    expect((err as Error).message).toMatch(/refused/);
    expect(transportInits).toHaveLength(0);

    findUnique.mockResolvedValue({ id: "row", address: stale, connected: true, verified: true, verifiedAt: new Date() });
    const result = await testChannel("u1", ChannelKind.discord);
    expect(result.ok).toBe(false);
    expect(transportInits).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });
});

// ── Response body cap ─────────────────────────────────────────────────────

describe("response body cap", () => {
  it("drains at most WEBHOOK_MAX_RESPONSE_BYTES of an oversized body and reports the truncation", async () => {
    const oversized = Buffer.alloc(WEBHOOK_MAX_RESPONSE_BYTES * 16, 0x41); // 1 MiB of "A"
    respond = (_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-length", String(oversized.length));
      res.end(oversized);
    };
    const result = await sendWebhook(ChannelKind.discord, DISCORD_OK, "hi");
    // The provider DID accept the message, so this is still a success — the
    // body is simply not read past the cap (a refusal here would re-send).
    expect(result.status).toBe(200);
    expect(result.bodyTruncated).toBe(true);
    expect(result.bodyBytes).toBe(WEBHOOK_MAX_RESPONSE_BYTES);
    expect(WEBHOOK_MAX_RESPONSE_BYTES).toBe(64 * 1024);
  });

  it("a body under the cap is read in full and not flagged", async () => {
    const small = "x".repeat(1000);
    respond = (_req, res) => {
      res.statusCode = 200;
      res.end(small);
    };
    const result = await sendWebhook(ChannelKind.discord, DISCORD_OK, "hi");
    expect(result).toEqual({ status: 200, bodyBytes: 1000, bodyTruncated: false });
  });

  it("an oversized body on a streamed injected Response is cancelled after the cap", async () => {
    let pulls = 0;
    const chunk = new Uint8Array(16 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk); // endless 16 KiB chunks
      },
    });
    setWebhookFetch(async () => new Response(stream, { status: 200 }));
    const result = await sendWebhook(ChannelKind.discord, DISCORD_OK, "hi");
    expect(result.bodyTruncated).toBe(true);
    expect(result.bodyBytes).toBe(WEBHOOK_MAX_RESPONSE_BYTES);
    // 64 KiB cap / 16 KiB chunks → the 5th chunk trips it; a small allowance for read-ahead.
    expect(pulls).toBeLessThanOrEqual(8);
  });
});
