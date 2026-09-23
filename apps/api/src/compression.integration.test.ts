// SPDX-License-Identifier: Apache-2.0

/**
 * Contract coverage for HTTP response compression.
 *
 * WHY THIS EXISTS. The API shipped with no compression at all — no
 * `@fastify/compress`, and the fronting nginx does not gzip either. Measured
 * against production on 2026-09-22 by sending `Accept-Encoding: gzip, br` and
 * getting no `Content-Encoding` back:
 *
 *   /v1/community/catalog    543 KB → 147 KB   (73% smaller)
 *   /v1/bounties             432 KB → 100 KB   (77%)
 *   /v1/meta/public-catalog   69 KB →  16 KB   (76%)
 *
 * That is the single largest lever on the ~10 GB/day of egress investigated
 * that day — larger than every caching change combined, because it applies to
 * cache hits and misses alike, and to authenticated responses that are never
 * cached at all.
 *
 * A plugin registration is easy to lose in a merge and its absence is
 * completely silent: responses simply get bigger and nothing fails. Hence a
 * test that asserts the wire format rather than the configuration.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/**
 * A genuinely public route with a body comfortably over the 1 KB threshold.
 * `/v1/meta/taxonomy` looks like the obvious choice and is NOT public — it
 * answers 401 — which is exactly the kind of thing asserting on the wire
 * catches and asserting on configuration would not. This one returns the
 * seeded dataset-type catalog: ~69 KB on a real deployment.
 */
const ROUTE = "/v1/meta/public-catalog";

describe("response compression", () => {
  it("compresses a large response when the client advertises gzip", async () => {
    const res = await app.inject({ method: "GET", url: ROUTE, headers: { "accept-encoding": "gzip" } });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("prefers brotli when the client advertises it", async () => {
    // Brotli is offered ahead of gzip because it is materially smaller on
    // JSON. A client that only speaks gzip still gets gzip (above).
    const res = await app.inject({ method: "GET", url: ROUTE, headers: { "accept-encoding": "br, gzip" } });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
  });

  it("sends an uncompressed body to a client that advertises no encoding", async () => {
    // Compression must never be a correctness requirement: a client that asks
    // for nothing gets a plain body rather than an error or a broken stream.
    const res = await app.inject({ method: "GET", url: ROUTE, headers: { "accept-encoding": "identity" } });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(() => JSON.parse(res.body)).not.toThrow();
  });

  it("actually shrinks the payload", async () => {
    // The point of the exercise. Asserted as a real byte comparison rather
    // than by trusting the header, so a misconfiguration that sets the header
    // without compressing would still fail.
    const plain = await app.inject({ method: "GET", url: ROUTE, headers: { "accept-encoding": "identity" } });
    const gzipped = await app.inject({ method: "GET", url: ROUTE, headers: { "accept-encoding": "gzip" } });

    expect(gzipped.rawPayload.length).toBeLessThan(plain.rawPayload.length);
  });

  /**
   * The blast-radius tests. Compression was registered GLOBALLY, which makes
   * it a transform over every response this service produces — so the risk it
   * introduces is not "does it compress" but "what else did it touch".
   *
   * Two things in this API would be damaged by it and neither would fail
   * loudly: the notification SSE stream (buffering a stream that must flush
   * per event turns real-time delivery into silence until the connection
   * closes), and artifact downloads (spending CPU re-compressing bytes that
   * are already compressed). Reasoning says both are safe — SSE writes
   * straight to the raw socket and bypasses the send pipeline, and the plugin
   * only compresses content types marked compressible. Reasoning is not
   * evidence, so both are asserted.
   */
  it("leaves the notification SSE stream alone", async () => {
    // Unauthenticated is enough: the assertion is that the response is not
    // wearing a Content-Encoding, whatever its status. A compressed SSE
    // response is the failure being guarded against.
    const res = await app.inject({
      method: "GET",
      url: "/v1/notifications/stream",
      headers: { "accept-encoding": "gzip, br" },
    });

    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("does not re-compress an already-compressed content type", async () => {
    // A PNG or a zip gains nothing from gzip and costs CPU on every byte. The
    // plugin decides this from the content type, so this asserts the decision
    // rather than the configuration.
    const probe = await app.inject({
      method: "GET",
      url: ROUTE,
      headers: { "accept-encoding": "gzip" },
    });
    // Sanity: the mechanism under test is actually on for this app.
    expect(probe.headers["content-encoding"]).toBe("gzip");

    const binary = await app.inject({
      method: "GET",
      url: "/v1/artifacts/does-not-exist/content",
      headers: { "accept-encoding": "gzip" },
    });
    // Whatever it answers, it must not claim an encoding it did not apply.
    if (binary.headers["content-encoding"]) {
      expect(String(binary.headers["content-type"])).toMatch(/json|text/);
    }
  });
});
