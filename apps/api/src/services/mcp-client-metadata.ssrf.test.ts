// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server, type Socket } from "node:net";
import { request as httpsRequest } from "node:https";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClientMetadataError,
  buildPinnedRequestOptions,
  clearClientMetadataCache,
  createPinnedLookup,
  fetchClientIdMetadataDocument,
  isForbiddenAddress,
  pinnedHttpsFetch,
  setClientMetadataDnsLookup,
  setClientMetadataFetch,
  type ClientMetadataFetchInit,
  type PinnedAddress,
} from "./mcp-client-metadata.js";

/**
 * Regression cover for the DNS-rebinding / TOCTOU gap recorded against
 * `mcp-client-metadata.ts`: the resolved address was range-checked, then the
 * ORIGINAL hostname was handed to `fetch`, which re-resolved it inside the
 * transport. An attacker-controlled DNS server could answer public on the
 * first lookup and private on the second.
 *
 * NO network and NO external host is contacted anywhere in this file. The two
 * tests that use a real socket create a loopback `net` listener, only ever
 * talk to it, and close it again. What is deliberately NOT proved here — and
 * cannot be, in this environment — is a real TLS handshake against a real
 * public host, and the deployed egress policy.
 */

const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";
const URL_OK = "https://client.example/oauth/client-metadata";

function doc(url: string) {
  return {
    client_id: url,
    client_name: "Example Agent CLI",
    redirect_uris: ["https://client.example/cb"],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

function jsonResponse(url: string) {
  return new Response(JSON.stringify(doc(url)), { status: 200, headers: { "content-type": "application/json" } });
}

async function expectReason(promise: Promise<unknown>, reason: ClientMetadataError["reason"]) {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ClientMetadataError);
  expect((caught as ClientMetadataError).reason).toBe(reason);
  return caught as ClientMetadataError;
}

/** Every `init` the transport was handed, so pinning is directly observable. */
let transportCalls: Array<{ url: string; init: ClientMetadataFetchInit }>;

beforeEach(() => {
  clearClientMetadataCache();
  transportCalls = [];
  setClientMetadataDnsLookup(async () => [{ address: PUBLIC_V4, family: 4 }]);
  setClientMetadataFetch(async (url, init) => {
    transportCalls.push({ url, init });
    return jsonResponse(url);
  });
});

afterEach(() => {
  setClientMetadataDnsLookup(null);
  setClientMetadataFetch(null);
  clearClientMetadataCache();
});

// ── The rebinding answer itself ───────────────────────────────────────────

describe("DNS rebinding", () => {
  it("pins the FIRST, validated answer and never consults the second (private) one", async () => {
    const answers = [
      [{ address: PUBLIC_V4, family: 4 }],
      [{ address: "169.254.169.254", family: 4 }], // cloud metadata, the classic second answer
    ];
    let lookups = 0;
    setClientMetadataDnsLookup(async () => answers[Math.min(lookups++, answers.length - 1)]!);

    const document = await fetchClientIdMetadataDocument(URL_OK);

    expect(document.client_id).toBe(URL_OK);
    // Exactly one resolution happened, and the connection was pinned to it.
    expect(lookups).toBe(1);
    expect(transportCalls).toHaveLength(1);
    expect(transportCalls[0]!.init.pinnedAddresses).toEqual([{ address: PUBLIC_V4, family: 4 }]);
    // The URL handed to the transport is still the original hostname.
    expect(transportCalls[0]!.url).toBe(URL_OK);
  });

  it("refuses when the rebinding answer arrives on the first lookup, and re-validates every fetch", async () => {
    let lookups = 0;
    setClientMetadataDnsLookup(async () => {
      lookups += 1;
      return lookups === 1 ? [{ address: "169.254.169.254", family: 4 }] : [{ address: PUBLIC_V4, family: 4 }];
    });
    await expectReason(fetchClientIdMetadataDocument("https://rebinder.example/meta"), "forbidden_host");
    expect(transportCalls).toHaveLength(0);

    // A later, honest answer is validated afresh rather than trusted from
    // the negative cache forever.
    clearClientMetadataCache();
    await fetchClientIdMetadataDocument("https://rebinder.example/meta");
    expect(lookups).toBe(2);
    expect(transportCalls[0]!.init.pinnedAddresses).toEqual([{ address: PUBLIC_V4, family: 4 }]);
  });

  it("a pinned address that has since become forbidden is refused at connect time, not dialled", async () => {
    // Simulates the transport being reached with a stale/poisoned pin: the
    // default transport re-checks before opening a socket.
    await expectReason(
      pinnedHttpsFetch("https://rebinder.example/meta", { pinnedAddresses: [{ address: "169.254.169.254", family: 4 }] }),
      "forbidden_host",
    );
  });

  it("createPinnedLookup ignores the hostname entirely, so a second resolution cannot substitute an address", async () => {
    const lookup = createPinnedLookup({ address: PUBLIC_V4, family: 4 });
    const seen = await new Promise<{ address: unknown; family: number | undefined }>((resolve, reject) => {
      // The hostname a rebinding resolver would now map to 127.0.0.1.
      lookup("rebinder.example", {}, (err, address, family) => (err ? reject(err) : resolve({ address, family })));
    });
    expect(seen.address).toBe(PUBLIC_V4);
    expect(seen.family).toBe(4);
  });

  it("createPinnedLookup fails closed on a forbidden pin and supports the all:true and 2-arg forms", async () => {
    const bad = createPinnedLookup({ address: "127.0.0.1", family: 4 });
    await expect(
      new Promise((resolve, reject) => bad("anything", {}, (err, address) => (err ? reject(err) : resolve(address)))),
    ).rejects.toThrow(/Refusing to connect/);

    const all = await new Promise<unknown>((resolve, reject) => {
      createPinnedLookup({ address: PUBLIC_V6, family: 6 })("x.example", { all: true }, (err, address) => (err ? reject(err) : resolve(address)));
    });
    expect(all).toEqual([{ address: PUBLIC_V6, family: 6 }]);

    const twoArg = await new Promise<unknown>((resolve, reject) => {
      createPinnedLookup({ address: PUBLIC_V4, family: 4 })("x.example", (err, address) => (err ? reject(err) : resolve(address)));
    });
    expect(twoArg).toBe(PUBLIC_V4);
  });
});

// ── Fail closed ───────────────────────────────────────────────────────────

describe("the default transport fails closed", () => {
  it("refuses a request carrying no pinned address rather than resolving the hostname itself", async () => {
    const err = await expectReason(pinnedHttpsFetch(URL_OK, {}), "forbidden_host");
    expect(err.message).toMatch(/without a pre-validated pinned address/);
    await expectReason(pinnedHttpsFetch(URL_OK, { pinnedAddresses: [] }), "forbidden_host");
  });

  it("refuses a non-https URL", async () => {
    await expectReason(pinnedHttpsFetch("http://client.example/meta", { pinnedAddresses: [{ address: PUBLIC_V4, family: 4 }] }), "forbidden_host");
  });

  it("opens NO socket at all for a loopback pin — proved against a real local listener", async () => {
    let connections = 0;
    const server: Server = createServer((socket: Socket) => {
      connections += 1;
      socket.destroy();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    try {
      await expectReason(
        pinnedHttpsFetch(`https://sni-probe.example:${port}/meta`, { pinnedAddresses: [{ address: "127.0.0.1", family: 4 }] }),
        "forbidden_host",
      );
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ── Literal and mapped addresses ──────────────────────────────────────────

describe("literal, mapped and multi-address answers", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "172.20.0.1", "0.0.0.0", "100.100.100.200"])(
    "refuses the literal IPv4 host %s with no lookup and no fetch",
    async (address) => {
      let lookups = 0;
      setClientMetadataDnsLookup(async () => {
        lookups += 1;
        return [{ address: PUBLIC_V4, family: 4 }];
      });
      await expectReason(fetchClientIdMetadataDocument(`https://${address}/meta`), "forbidden_host");
      expect(lookups).toBe(0);
      expect(transportCalls).toHaveLength(0);
    },
  );

  it.each(["[::1]", "[fc00::1]", "[fe80::1]", "[::ffff:169.254.169.254]"])("refuses the literal IPv6 host %s", async (host) => {
    await expectReason(fetchClientIdMetadataDocument(`https://${host}/meta`), "forbidden_host");
    expect(transportCalls).toHaveLength(0);
  });

  it("refuses a PUBLIC literal IP too — a client_id must name a host, not an address", async () => {
    await expectReason(fetchClientIdMetadataDocument(`https://${PUBLIC_V4}/meta`), "forbidden_host");
  });

  it.each([
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:192.168.0.1",
    "::10.0.0.1",
    "64:ff9b::a00:1",
    "2002:a00:1::",
  ])("refuses the IPv4-mapped / embedded IPv6 answer %s at resolution AND at the pin re-check", async (address) => {
    setClientMetadataDnsLookup(async () => [{ address, family: 6 }]);
    await expectReason(fetchClientIdMetadataDocument("https://mapped.example/meta"), "forbidden_host");
    expect(transportCalls).toHaveLength(0);
    // Same address arriving at the transport is refused there as well.
    expect(isForbiddenAddress(address)).toBe(true);
    await expectReason(pinnedHttpsFetch("https://mapped.example/meta", { pinnedAddresses: [{ address, family: 6 }] }), "forbidden_host");
  });

  it("refuses the WHOLE answer when only one of several addresses is private", async () => {
    setClientMetadataDnsLookup(async () => [
      { address: PUBLIC_V4, family: 4 },
      { address: PUBLIC_V6, family: 6 },
      { address: "10.1.2.3", family: 4 },
    ]);
    await expectReason(fetchClientIdMetadataDocument("https://mixed.example/meta"), "forbidden_host");
    expect(transportCalls).toHaveLength(0);
  });

  it("pins every address of an all-public multi-address answer, families preserved", async () => {
    setClientMetadataDnsLookup(async () => [
      { address: PUBLIC_V6, family: 6 },
      { address: PUBLIC_V4, family: 4 },
    ]);
    await fetchClientIdMetadataDocument("https://dual.example/meta");
    expect(transportCalls[0]!.init.pinnedAddresses).toEqual([
      { address: PUBLIC_V6, family: 6 },
      { address: PUBLIC_V4, family: 4 },
    ]);
  });

  it("still fetches a genuinely public answer", async () => {
    const document = await fetchClientIdMetadataDocument(URL_OK);
    expect(document.client_name).toBe("Example Agent CLI");
    expect(transportCalls).toHaveLength(1);
    expect(transportCalls[0]!.init.pinnedAddresses).toEqual([{ address: PUBLIC_V4, family: 4 }]);
  });
});

// ── The original hostname survives the pinning ────────────────────────────

describe("the pinned request still names the original hostname", () => {
  const pinned: PinnedAddress = { address: PUBLIC_V4, family: 4 };

  it("dials the IP literal while Host, SNI and identity-checking keep the hostname", () => {
    const options = buildPinnedRequestOptions(new URL("https://client.example/oauth/client-metadata"), pinned, {
      headers: { accept: "application/json" },
    });
    expect(options.host).toBe(PUBLIC_V4); // the connection target is the validated address
    expect(options.servername).toBe("client.example"); // TLS SNI keeps the hostname
    expect((options.headers as Record<string, string>).host).toBe("client.example");
    expect((options.headers as Record<string, string>).accept).toBe("application/json");
    expect(options.setHost).toBe(false); // Node must not rewrite Host to the IP
    expect(options.agent).toBe(false); // never a shared, host-keyed pool
    expect(options.port).toBe(443);
    expect(options.path).toBe("/oauth/client-metadata");
    expect(options.family).toBe(4);
    expect(typeof options.checkServerIdentity).toBe("function");
    expect(typeof options.lookup).toBe("function");
  });

  it("carries a non-default port into both the Host header and the connection", () => {
    const options = buildPinnedRequestOptions(new URL("https://client.example:8443/meta"), pinned);
    expect(options.port).toBe(8443);
    expect((options.headers as Record<string, string>).host).toBe("client.example:8443");
    expect(options.servername).toBe("client.example");
  });

  it("verifies the certificate against the hostname, not the pinned literal", () => {
    const options = buildPinnedRequestOptions(new URL("https://client.example/meta"), pinned);
    // A certificate valid for the pinned IP but not the hostname must fail.
    expect(options.checkServerIdentity?.(PUBLIC_V4, { subject: { CN: PUBLIC_V4 }, subjectaltname: `IP Address:${PUBLIC_V4}` } as never)).toBeInstanceOf(Error);
    // One valid for the hostname must pass.
    expect(options.checkServerIdentity?.(PUBLIC_V4, { subject: { CN: "client.example" }, subjectaltname: "DNS:client.example" } as never)).toBeUndefined();
  });

  it("puts the ORIGINAL hostname on the wire as TLS SNI — captured from a real loopback socket", async () => {
    const hostname = "sni-probe-hostname.example";
    let firstChunk: Buffer | null = null;
    let connections = 0;
    const server: Server = createServer((socket: Socket) => {
      connections += 1;
      socket.once("data", (chunk: Buffer) => {
        firstChunk = chunk;
        socket.destroy();
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    try {
      // `buildPinnedRequestOptions` is the wire-shaping layer, below the
      // range check (which `pinnedHttpsFetch` applies and which refuses
      // 127.0.0.1 — see the fail-closed test above). Driving it directly is
      // what lets the ClientHello be inspected without a public host.
      const options = buildPinnedRequestOptions(new URL(`https://${hostname}:${port}/meta`), { address: "127.0.0.1", family: 4 });
      await new Promise<void>((resolve) => {
        const req = httpsRequest(options);
        // The handshake cannot complete against a bare TCP listener; the
        // ClientHello has already been sent by then, which is the point.
        req.on("error", () => resolve());
        req.on("response", () => resolve());
        req.end();
      });
      expect(connections).toBe(1);
      expect(firstChunk).not.toBeNull();
      const hello = firstChunk as unknown as Buffer;
      expect(hello[0]).toBe(0x16); // TLS handshake record
      expect(hello.includes(Buffer.from(hostname, "ascii"))).toBe(true); // SNI = original hostname
      expect(hello.includes(Buffer.from("127.0.0.1", "ascii"))).toBe(false); // never the pinned literal
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ── Redirects ─────────────────────────────────────────────────────────────

describe("redirects", () => {
  it("asks an injected WHATWG transport for redirect:error", async () => {
    await fetchClientIdMetadataDocument(URL_OK);
    expect(transportCalls[0]!.init.redirect).toBe("error");
  });

  it("the pinned transport rejects a 3xx itself, so no second destination is ever pinned", async () => {
    // node:https never follows a redirect, so the 3xx surfaces as a refusal
    // rather than as a silently-followed, unvalidated hop.
    setClientMetadataFetch(async (_url, init) => {
      expect(init.pinnedAddresses).toEqual([{ address: PUBLIC_V4, family: 4 }]);
      throw new ClientMetadataError("fetch_failed", "Client metadata document responded with a redirect (HTTP 302); redirects are never followed.");
    });
    await expectReason(fetchClientIdMetadataDocument(URL_OK), "fetch_failed");
  });
});
