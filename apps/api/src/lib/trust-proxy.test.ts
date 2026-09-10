// SPDX-License-Identifier: Apache-2.0

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { isPrivateOrLoopback, toFastifyTrustProxy } from "./trust-proxy.js";

describe("isPrivateOrLoopback", () => {
  it("accepts RFC 1918, loopback, link-local and unique-local addresses", () => {
    for (const ip of ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.1", "127.0.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1"]) {
      expect(isPrivateOrLoopback(ip), ip).toBe(true);
    }
  });

  it("rejects public addresses and garbage", () => {
    for (const ip of ["203.0.113.9", "8.8.8.8", "172.32.0.1", "2001:db8::1", "not-an-ip", ""]) {
      expect(isPrivateOrLoopback(ip), ip).toBe(false);
    }
  });

  it("unwraps IPv4-mapped IPv6 before judging", () => {
    expect(isPrivateOrLoopback("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopback("::ffff:203.0.113.9")).toBe(false);
  });
});

describe("toFastifyTrustProxy", () => {
  it("passes booleans and allowlists through unchanged", () => {
    expect(toFastifyTrustProxy(false)).toBe(false);
    expect(toFastifyTrustProxy(true)).toBe(true);
    expect(toFastifyTrustProxy("loopback, 10.0.0.0/8")).toBe("loopback, 10.0.0.0/8");
  });

  it("turns a hop count into a function — never a bare number Fastify would ignore", () => {
    const fn = toFastifyTrustProxy(2);
    expect(typeof fn).toBe("function");
  });
});

describe("req.ip behind TRUST_PROXY=2 (CloudFront -> ALB)", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => {
    await Promise.all(apps.map((a) => a.close()));
    apps.length = 0;
  });

  async function build(hops: number) {
    const app = Fastify({ trustProxy: toFastifyTrustProxy(hops) });
    app.get("/ip", async (req) => ({ ip: req.ip }));
    await app.ready();
    apps.push(app);
    return app;
  }

  it("resolves the real client through two trusted hops when the peer is the in-VPC load balancer", async () => {
    const app = await build(2);
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "10.0.12.34",
      headers: { "x-forwarded-for": "203.0.113.9, 130.176.0.1" },
    });
    expect(res.json()).toEqual({ ip: "203.0.113.9" });
  });

  it("a direct public client cannot forge its way to a different req.ip", async () => {
    const app = await build(2);
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "198.51.100.7",
      headers: { "x-forwarded-for": "203.0.113.9, 130.176.0.1" },
    });
    expect(res.json()).toEqual({ ip: "198.51.100.7" });
  });

  it("does not walk past the configured hop count", async () => {
    const app = await build(2);
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "10.0.12.34",
      headers: { "x-forwarded-for": "192.0.2.1, 203.0.113.9, 130.176.0.1" },
    });
    // Three forwarded entries but only two trusted hops: the third-from-right
    // entry is the client, the leftmost is attacker-supplied noise.
    expect(res.json()).toEqual({ ip: "203.0.113.9" });
  });

  it("with no proxy configured req.ip is the socket peer regardless of headers", async () => {
    const app = Fastify({ trustProxy: toFastifyTrustProxy(false) });
    app.get("/ip", async (req) => ({ ip: req.ip }));
    await app.ready();
    apps.push(app);
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "10.0.12.34",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(res.json()).toEqual({ ip: "10.0.12.34" });
  });
});
