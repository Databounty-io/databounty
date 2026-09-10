// SPDX-License-Identifier: Apache-2.0

import type { Readable } from "node:stream";
import type { Artifact } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { storage } from "../lib/storage/index.js";
import type { ArtifactScanResult } from "../types/index.js";

export type ArtifactScanOutcome = ArtifactScanResult;

export const MALWARE_SCAN_SETTING_KEY = "artifacts.malware_scan.enabled";

/**
 * The three policy states, kept explicitly separate (SEC-08).
 *
 *  - `optional`             — the operator has explicitly recorded the scan as
 *                             NOT required. This is the ONLY state that may
 *                             resolve to `not_required`.
 *  - `required_available`   — a scan is required (explicitly enabled, or a
 *                             non-boolean stored value we refuse to read as "off")
 *                             AND a scanner endpoint is configured, so a real
 *                             scan can run.
 *  - `required_unavailable` — a scan is required, or the policy is unknown, but
 *                             no scanner endpoint is configured. Nothing can be
 *                             scanned, so nothing may be reported. Fails closed.
 */
export type ArtifactScanPolicy =
  | { state: "optional"; reason: string }
  | { state: "required_available"; endpoint: string; reason: string }
  | { state: "required_unavailable"; reason: string };

/**
 * Thrown when a scan is required (or the policy is unknown) but no scanner is
 * reachable/configured. Deliberately an exception rather than an
 * `ArtifactScanResult` variant: the scan-job handler
 * (`services/artifacts.ts#runArtifactScanJob`) already fails closed on a thrown
 * scan — it records `scanStatus = error`, leaves `status = scanning` for retry
 * or manual admin review, and rethrows — whereas every VALUE it can receive is
 * currently funnelled into `ready`. Throwing is therefore the only shape that
 * cannot be mistaken for a completed scan.
 *
 * AGENTS.md §3: a missing or unconfigured check is shown explicitly and is
 * never presented as passed.
 */
export class ArtifactScanUnavailableError extends Error {
  readonly code = "artifact_scan_unavailable" as const;
  readonly policyReason: string;

  constructor(reason: string) {
    super(`malware scan required but unavailable — failing closed: ${reason}`);
    this.name = "ArtifactScanUnavailableError";
    this.policyReason = reason;
  }
}

/** Seam for unit tests: no Postgres, no storage, no network, no scanner. */
export interface ArtifactScanDeps {
  /** Raw stored admin-setting value, or `undefined`/`null` when no row exists. */
  readMalwareScanSetting: () => Promise<unknown>;
  isProd: boolean;
  endpoint: string | undefined;
  token: string | undefined;
  timeoutMs: number;
  readObject: (storageKey: string) => Promise<Readable>;
  fetch: typeof fetch;
}

function realDeps(): ArtifactScanDeps {
  return {
    readMalwareScanSetting: async () => {
      const row = await prisma.adminSetting.findUnique({ where: { key: MALWARE_SCAN_SETTING_KEY } });
      return row?.value;
    },
    isProd: config.isProd,
    endpoint: config.artifactScan.endpoint,
    token: config.artifactScan.token,
    timeoutMs: config.artifactScan.timeoutMs,
    readObject: (storageKey) => storage().get(storageKey),
    fetch: globalThis.fetch,
  };
}

/**
 * Whether malware scanning is required, decided ENTIRELY by the admin setting
 * `artifacts.malware_scan.enabled` (default off) — never by env. Read fresh per
 * scan so a toggle takes effect without a restart.
 *
 * Tri-state on purpose: `unknown` stays separable so it can fail closed rather
 * than being collapsed into "off".
 */
async function malwareScanSetting(deps: ArtifactScanDeps): Promise<"on" | "off" | "unknown"> {
  let value: unknown;
  try {
    value = await deps.readMalwareScanSetting();
  } catch (error) {
    throw new Error(
      `malware scan configuration could not be read — failing closed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (value === true) return "on";
  if (value === false) return "off";
  // Owner decision (2026-09-05): the scanner is OPTIONAL and OFF by default in
  // EVERY environment, production included. An absent row therefore means the
  // documented catalog default (`defaultValue: false`), never an unknown policy
  // that strands uploads. Only a stored value that is neither boolean is a
  // genuinely unknown/corrupt policy, and that still fails closed.
  if (value === undefined || value === null) return "off";
  return "unknown";
}

export async function resolveArtifactScanPolicy(
  overrides: Partial<ArtifactScanDeps> = {}
): Promise<ArtifactScanPolicy> {
  const deps = { ...realDeps(), ...overrides };
  const setting = await malwareScanSetting(deps);

  if (setting === "off") {
    return { state: "optional", reason: "malware scanning disabled (admin setting off)" };
  }

  const required =
    setting === "on"
      ? "malware scanning is enabled by admin setting"
      : `malware scan policy is unknown in this environment (no \`${MALWARE_SCAN_SETTING_KEY}\` setting recorded)`;

  if (!deps.endpoint) {
    return {
      state: "required_unavailable",
      reason: `${required}, but ARTIFACT_SCAN_URL is not configured — no scanner could run, so no scan result exists`,
    };
  }

  return { state: "required_available", endpoint: deps.endpoint, reason: required };
}

export async function scanArtifact(
  artifact: Artifact,
  overrides: Partial<ArtifactScanDeps> = {}
): Promise<ArtifactScanOutcome> {
  const deps = { ...realDeps(), ...overrides };
  const policy = await resolveArtifactScanPolicy(deps);

  if (policy.state === "optional") {
    return { status: "not_required", detail: policy.reason };
  }

  if (policy.state === "required_unavailable") {
    // Never `not_required`: nothing ran, so there is nothing to report.
    throw new ArtifactScanUnavailableError(policy.reason);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const body = await deps.readObject(artifact.storageKey);
    const response = await deps.fetch(policy.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Artifact-Id": artifact.id,
        "X-Artifact-Filename": encodeURIComponent(artifact.filename),
        "X-Artifact-Content-Type": artifact.contentType,
        ...(artifact.checksumSha256 ? { "X-Artifact-Sha256": artifact.checksumSha256 } : {}),
        ...(deps.token ? { Authorization: `Bearer ${deps.token}` } : {}),
      },
      body: body as never,
      signal: controller.signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    if (!response.ok) throw new Error(`artifact scanner returned HTTP ${response.status}`);
    const result = (await response.json()) as { status?: unknown; threats?: unknown };
    if (result.status === "clean") return { status: "clean" };
    if (result.status === "infected") {
      const threats = Array.isArray(result.threats)
        ? result.threats.filter((item): item is string => typeof item === "string").slice(0, 10)
        : [];
      return { status: "infected", detail: threats.join(", ") || "scanner reported infected content" };
    }
    // An unparseable verdict is an unknown result, and unknown fails closed:
    // thrown, not returned, so it cannot be read as a completed scan.
    throw new Error("artifact scanner returned an invalid response");
  } finally {
    clearTimeout(timeout);
  }
}
