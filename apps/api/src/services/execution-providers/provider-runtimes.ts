// SPDX-License-Identifier: Apache-2.0

/**
 * PER-PROVIDER runtime capability — "which binaries can THIS sandbox run".
 *
 * Ported from V1 (databounty-api/src/services/execution-providers/
 * provider-runtimes.ts), minus the `ec2` half (that provider is deliberately
 * not ported — see provider-order.ts).
 *
 * Capability is a property of the box, not of the platform. A capability answer
 * is usable only while it is trustworthy; an absent or unreadable answer
 * degrades to "cannot claim" (the language is reported `unverifiable`), NEVER to
 * "supported" — an over-claim is a false execution-verified promise.
 */
export interface RuntimeCapability {
  /** Binaries this provider is known to be able to run. */
  binaries: ReadonlySet<string>;
  /** Where the knowledge came from, verbatim, for the honesty surface. */
  source: string;
  /** When it was observed; null for a static build artifact that cannot age. */
  observedAt: Date | null;
  /**
   * False when nothing can be claimed for this provider right now. A caller
   * MUST treat `usable: false` as "unknown", never as "has nothing" and never
   * as "has everything" — the two are different verdicts and only one of them
   * is honest.
   */
  usable: boolean;
  /** Present only when `usable` is false; says why in one phrase. */
  unusableReason?: string;
}

/**
 * The runtimes the `databounty-verify` E2B template ships.
 *
 * AUTHORITATIVE for what the platform may claim it can execution-verify.
 * SOURCED FROM A LIVE PROBE of the published template (probed 2026-08-07 for
 * template `databounty-verify` / `eywwal6xp9bygz30a0af`), NOT from its
 * Dockerfile — trust honesty cuts both ways, and under-claiming a passed check
 * is as wrong as over-claiming a skipped one.
 *
 * V1 keeps this as `sandbox/runtimes.json` beside the Dockerfile. It is inlined
 * here because this rebuild's API package ships no `sandbox/` directory yet; the
 * data and its meaning are unchanged. TO CHANGE: rebuild and publish the
 * template, re-probe it, and update this list. Do not add a runtime solely
 * because a Dockerfile declares it.
 *
 * NOTE: e2b.ts fails the provider (rather than silently falling back to the E2B
 * account-default image) when `E2B_TEMPLATE` cannot be loaded, precisely so this
 * manifest can never describe an image that did not run the code.
 */
const E2B_TEMPLATE_BINARIES = [
  "bash",
  "cargo",
  "clang",
  "g++",
  "gcc",
  "git",
  "go",
  "java",
  "javac",
  "mcs",
  "mono",
  "node",
  "npm",
  "php",
  "python3",
  "ruby",
  "rustc",
  "sqlite3",
  "tsc",
  "tsx",
  "valgrind",
  "xmllint",
  // Added by the 2026-09-09 rebuild of the image (alias databounty-verify-dev,
  // rezal50dxbt0wwjplr77) and confirmed by a live probe of that template, not
  // from its definition: ruff 0.16.6, eslint v9.39.5, mypy 2.3.1,
  // protoc/libprotoc 3.21.12. `hypothesis` 6.167.1 ships too but is a Python
  // library, not a binary, so it is not listed here — this set is what
  // `have(cmd)` can answer for.
  //
  // These four unblock static_lint_rule_fix_verification (ruff for Python rows,
  // eslint for JS/TS rows), static_compilation's Python --strict branch (mypy)
  // and serialization's protobuf rows (protoc). Before the rebuild the
  // published image had none of them, which is why those categories reported
  // runtime_unavailable in this tree AND in V1.
  "eslint",
  "mypy",
  "protoc",
  "ruff",
] as const;

let manifestOverride: { binaries: Set<string>; source: string } | null = null;

/** The E2B template's runtime inventory. */
export function installedRuntimes(): Set<string> {
  if (manifestOverride) return manifestOverride.binaries;
  return new Set<string>(E2B_TEMPLATE_BINARIES);
}

/** E2B's capability answer: the probed template manifest. Never ages, because
 * it is a build artifact of an image that cannot change without a redeploy. */
export function e2bRuntimeCapability(): RuntimeCapability {
  const binaries = installedRuntimes();
  return {
    binaries,
    source: `manifest:${manifestOverride?.source ?? "e2b-template:databounty-verify-dev@2026-09-09"}`,
    observedAt: null,
    usable: binaries.size > 0,
    ...(binaries.size > 0 ? {} : { unusableReason: "the E2B template manifest lists no runtimes" }),
  };
}

/**
 * Test seam. Pass a binary list to pretend the E2B template ships exactly that
 * set; pass nothing to drop back to the real manifest.
 *
 * Exists because the `unverifiable` branch of language support must stay
 * covered by a test that does NOT depend on which runtimes happen to be missing
 * from today's image.
 */
export function setInstalledRuntimesForTest(binaries?: string[]): void {
  manifestOverride = binaries ? { binaries: new Set(binaries), source: "test" } : null;
}
