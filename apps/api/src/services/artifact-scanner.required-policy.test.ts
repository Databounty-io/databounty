// SPDX-License-Identifier: Apache-2.0

/**
 * SEC-08 regression: a required-but-unavailable malware-scan policy, or an
 * UNKNOWN required policy, must never resolve to `not_required`.
 *
 * Pure unit test. Every external edge (admin-setting read, object storage,
 * scanner HTTP call, clock/abort) is an explicit double supplied through
 * `scanArtifact`'s deps seam, so this file needs NO PostgreSQL, NO network and
 * NO scanner endpoint. Nothing here uses malicious bytes.
 */

import type { Readable } from "node:stream";
import { Readable as NodeReadable } from "node:stream";
import type { Artifact } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  ArtifactScanUnavailableError,
  type ArtifactScanDeps,
  resolveArtifactScanPolicy,
  scanArtifact,
} from "./artifact-scanner.js";

const DUMMY_BYTES = Buffer.from("Harmless unit-test text.");

const artifact = {
  id: "artifact_sec08",
  filename: "dummy.txt",
  contentType: "text/plain",
  storageKey: "unit/dummy.txt",
  checksumSha256: "a".repeat(64),
} as unknown as Artifact;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Deps with every real edge replaced; individual tests override what matters. */
function deps(over: Partial<ArtifactScanDeps> = {}): Partial<ArtifactScanDeps> {
  return {
    readMalwareScanSetting: async () => undefined,
    isProd: false,
    endpoint: undefined,
    token: undefined,
    timeoutMs: 50,
    readObject: async (): Promise<Readable> => NodeReadable.from(DUMMY_BYTES),
    fetch: async () => {
      throw new Error("no scanner endpoint should have been contacted");
    },
    ...over,
  };
}

describe("SEC-08 — malware scan policy resolution fails closed", () => {
  it("explicitly disabled is the ONLY policy that resolves to not_required", async () => {
    const policy = await resolveArtifactScanPolicy(deps({ readMalwareScanSetting: async () => false }));
    expect(policy.state).toBe("optional");

    const outcome = await scanArtifact(artifact, deps({ readMalwareScanSetting: async () => false }));
    expect(outcome.status).toBe("not_required");
  });

  it("enabled with NO scanner endpoint is required_unavailable, never not_required", async () => {
    const policy = await resolveArtifactScanPolicy(
      deps({ readMalwareScanSetting: async () => true, endpoint: undefined })
    );
    expect(policy.state).toBe("required_unavailable");

    const call = scanArtifact(artifact, deps({ readMalwareScanSetting: async () => true, endpoint: undefined }));
    await expect(call).rejects.toBeInstanceOf(ArtifactScanUnavailableError);
    await expect(call).rejects.toThrow(/ARTIFACT_SCAN_URL is not configured/);
  });

  it("absent setting row in production is OPTIONAL (owner decision: default off everywhere) and resolves not_required", async () => {
    const absentProd = deps({ readMalwareScanSetting: async () => undefined, isProd: true, endpoint: undefined });
    const policy = await resolveArtifactScanPolicy(absentProd);
    expect(policy.state).toBe("optional");
    await expect(scanArtifact(artifact, absentProd)).resolves.toMatchObject({ status: "not_required" });
  });

  it("non-boolean stored value (corrupt policy) with no endpoint is required_unavailable", async () => {
    const unknownProd = deps({ readMalwareScanSetting: async () => "yes", isProd: true, endpoint: undefined });

    const policy = await resolveArtifactScanPolicy(unknownProd);
    expect(policy.state).toBe("required_unavailable");
    expect(policy.reason).toMatch(/unknown/);

    await expect(scanArtifact(artifact, unknownProd)).rejects.toBeInstanceOf(ArtifactScanUnavailableError);
  });

  it("absent setting row WITH an endpoint still does not scan — default is off, the switch must be turned on explicitly", async () => {
    let calls = 0;
    const outcome = await scanArtifact(
      artifact,
      deps({
        readMalwareScanSetting: async () => undefined,
        isProd: true,
        endpoint: "http://scanner.invalid/scan",
        fetch: async () => {
          calls += 1;
          return jsonResponse({ status: "clean" });
        },
      })
    );
    expect(outcome).toMatchObject({ status: "not_required" });
    expect(calls).toBe(0);
  });

  it("explicitly enabled WITH an endpoint runs the real scan", async () => {
    let calls = 0;
    const outcome = await scanArtifact(
      artifact,
      deps({
        readMalwareScanSetting: async () => true,
        isProd: true,
        endpoint: "http://scanner.invalid/scan",
        fetch: async () => {
          calls += 1;
          return jsonResponse({ status: "clean" });
        },
      })
    );
    expect(outcome).toEqual({ status: "clean" });
    expect(calls).toBe(1);
  });

  it("a non-boolean stored value is not silently read as off", async () => {
    const policy = await resolveArtifactScanPolicy(
      deps({ readMalwareScanSetting: async () => "true", isProd: true, endpoint: undefined })
    );
    expect(policy.state).toBe("required_unavailable");
  });

  it("an unreadable setting fails closed by throwing, not by returning not_required", async () => {
    await expect(
      scanArtifact(
        artifact,
        deps({
          readMalwareScanSetting: async () => {
            throw new Error("db down");
          },
        })
      )
    ).rejects.toThrow(/could not be read — failing closed/);
  });
});

describe("SEC-08 — scanner outcomes when a scan really runs", () => {
  const enabled = { readMalwareScanSetting: async () => true, endpoint: "http://scanner.invalid/scan" };

  it("clean result returns clean", async () => {
    const outcome = await scanArtifact(artifact, deps({ ...enabled, fetch: async () => jsonResponse({ status: "clean" }) }));
    expect(outcome).toEqual({ status: "clean" });
  });

  it("infected result returns infected with the reported threats", async () => {
    const outcome = await scanArtifact(
      artifact,
      deps({ ...enabled, fetch: async () => jsonResponse({ status: "infected", threats: ["Test.Signature.Dummy"] }) })
    );
    expect(outcome).toEqual({ status: "infected", detail: "Test.Signature.Dummy" });
  });

  it("an invalid scanner response throws instead of resolving to a verdict", async () => {
    await expect(
      scanArtifact(artifact, deps({ ...enabled, fetch: async () => jsonResponse({ status: "maybe" }) }))
    ).rejects.toThrow(/invalid response/);
  });

  it("a scanner HTTP error throws instead of resolving to a verdict", async () => {
    await expect(
      scanArtifact(artifact, deps({ ...enabled, fetch: async () => new Response("nope", { status: 502 }) }))
    ).rejects.toThrow(/HTTP 502/);
  });

  it("a timeout aborts and throws — never a clean or not_required verdict", async () => {
    let aborted = false;
    const outcome = scanArtifact(
      artifact,
      deps({
        ...enabled,
        timeoutMs: 10,
        fetch: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = (init as RequestInit).signal!;
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      })
    );
    await expect(outcome).rejects.toThrow(/abort/i);
    expect(aborted).toBe(true);
  });
});

describe("SEC-08 — retry idempotency", () => {
  it("retrying an unavailable-scanner artifact fails closed identically every time", async () => {
    const unavailable = deps({ readMalwareScanSetting: async () => true, endpoint: undefined });
    const errors: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      errors.push(await scanArtifact(artifact, unavailable).catch((err: unknown) => err));
    }
    expect(errors.every((err) => err instanceof ArtifactScanUnavailableError)).toBe(true);
    expect(new Set(errors.map((err) => (err as Error).message)).size).toBe(1);
  });

  it("retrying a clean scan yields the same verdict and one scanner call per attempt", async () => {
    let calls = 0;
    const clean = deps({
      readMalwareScanSetting: async () => true,
      endpoint: "http://scanner.invalid/scan",
      fetch: async () => {
        calls += 1;
        return jsonResponse({ status: "clean" });
      },
    });
    expect(await scanArtifact(artifact, clean)).toEqual({ status: "clean" });
    expect(await scanArtifact(artifact, clean)).toEqual({ status: "clean" });
    expect(calls).toBe(2);
  });
});
