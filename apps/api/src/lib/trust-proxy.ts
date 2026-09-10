// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";
import type { FastifyServerOptions } from "fastify";

export type FastifyTrustProxy = FastifyServerOptions["trustProxy"];

/**
 * RFC 1918 / loopback / link-local / unique-local check, with IPv4-mapped
 * IPv6 (`::ffff:10.0.0.1`) unwrapped first so it cannot slip past the v4 rules.
 */
export function isPrivateOrLoopback(address: string): boolean {
  let candidate = address.trim();
  if (candidate.toLowerCase().startsWith("::ffff:")) candidate = candidate.slice(7);
  const version = isIP(candidate);
  if (version === 4) {
    const [a, b] = candidate.split(".").map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (version === 6) {
    const lower = candidate.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
  }
  return false;
}

/**
 * Translate the parsed `TRUST_PROXY` config into what Fastify will actually
 * honour.
 *
 * Fastify 5.12 deliberately treats a bare NUMBER as "trust nothing"
 * (`lib/request.js#getTrustProxyFn`): a hop count alone cannot validate the
 * immediate peer, so a client connecting directly could forge enough
 * `X-Forwarded-For` entries to pick its own `req.ip`. That makes the deploy
 * script's `TRUST_PROXY=2` (CloudFront -> ALB) silently inert, and every
 * request then shares the load balancer's address as its rate-limit key.
 *
 * The documented topology is still exactly a two-hop chain, so we express the
 * hop count as a trust FUNCTION — the shape Fastify does accept — and close the
 * spoofing hole the runtime was worried about ourselves: hop 0 (the TCP peer)
 * is only trusted when it is a private/loopback address, i.e. an in-VPC load
 * balancer. A direct public connection therefore keeps its real socket address
 * as `req.ip` no matter what headers it sends.
 *
 * Booleans and address allowlists (`"loopback, 10.0.0.0/8"`) pass through
 * unchanged — Fastify handles those correctly on its own.
 */
export function toFastifyTrustProxy(value: boolean | number | string): FastifyTrustProxy {
  if (typeof value !== "number") return value;
  const hops = value;
  return (address: string, hop: number): boolean => {
    if (hop === 0) return isPrivateOrLoopback(address);
    return hop < hops;
  };
}
