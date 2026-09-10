// SPDX-License-Identifier: Apache-2.0

/**
 * SEC-05 regression: Google audience enforcement must fail CLOSED.
 *
 * Hermetic on purpose — no PostgreSQL, no network, no real Google. `config` is
 * a test double so the deployment's own GOOGLE_CLIENT_ID cannot change the
 * outcome, and `fetch` is replaced by a deterministic tokeninfo fixture that
 * THROWS on any other URL, the same shape the 2026-09-05 review harness used
 * (docs/private/operations/community-security-evidence/restart-real-api-review.mts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { configState } = vi.hoisted(() => ({
  configState: { googleClientId: undefined as string | undefined },
}));

vi.mock("../config.js", () => ({ config: configState }));

const { verifyGoogleIdToken, isGoogleAuthConfigured, googleAllowedAudiences } = await import(
  "./google-auth.js"
);

const OUR_CLIENT = "dummy-databounty-oauth-client.apps.googleusercontent.invalid";
const OTHER_CLIENT = "different-dummy-oauth-client";

/** A tokeninfo body that is valid in every respect except what a test changes. */
function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: OUR_CLIENT,
    iss: "https://accounts.google.com",
    exp: String(Math.floor(Date.now() / 1000) + 600),
    email_verified: true,
    email: "Dummy.Reviewer@example.invalid",
    name: "Dummy Reviewer",
    sub: "dummy-google-subject-A",
    ...overrides,
  };
}

const realFetch = globalThis.fetch;
let tokeninfoCalls = 0;

/** Serves the fixture for tokeninfo only; anything else is a hard failure. */
function stubProvider(body: Record<string, unknown> | null, status = 200) {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (!url.startsWith("https://oauth2.googleapis.com/tokeninfo?")) {
      throw new Error(`External fetch blocked by hermetic test harness: ${url}`);
    }
    tokeninfoCalls += 1;
    if (body === null) throw new Error("provider unreachable");
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  tokeninfoCalls = 0;
  configState.googleClientId = OUR_CLIENT;
  stubProvider(fixture());
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("SEC-05 — Google audience enforcement", () => {
  it("accepts a correct audience", async () => {
    const identity = await verifyGoogleIdToken("dummy-identity-token");
    expect(identity).toEqual({
      googleId: "dummy-google-subject-A",
      email: "dummy.reviewer@example.invalid",
      name: "Dummy Reviewer",
      emailVerified: true,
    });
  });

  it("rejects a token minted for a DIFFERENT OAuth client", async () => {
    stubProvider(fixture({ aud: OTHER_CLIENT }));
    expect(await verifyGoogleIdToken("dummy-identity-token")).toBeNull();
  });

  it("rejects a response with no audience claim at all", async () => {
    const body = fixture();
    delete body.aud;
    stubProvider(body);
    expect(await verifyGoogleIdToken("dummy-identity-token")).toBeNull();
  });

  it("matches the audience exactly, not by prefix or substring", async () => {
    stubProvider(fixture({ aud: `${OUR_CLIENT}.attacker.invalid` }));
    expect(await verifyGoogleIdToken("dummy-identity-token")).toBeNull();
    stubProvider(fixture({ aud: OUR_CLIENT.slice(0, 10) }));
    expect(await verifyGoogleIdToken("dummy-identity-token")).toBeNull();
  });

  it("accepts either audience when two OAuth clients are configured", async () => {
    configState.googleClientId = ` ${OUR_CLIENT} , second-dummy-client `;
    expect(googleAllowedAudiences()).toEqual([OUR_CLIENT, "second-dummy-client"]);
    stubProvider(fixture({ aud: "second-dummy-client" }));
    expect(await verifyGoogleIdToken("dummy-identity-token")).not.toBeNull();
    stubProvider(fixture({ aud: OTHER_CLIENT }));
    expect(await verifyGoogleIdToken("dummy-identity-token")).toBeNull();
  });

  // THE ORIGINAL DEFECT. Before the fix `aud` was only compared when
  // config.googleClientId was non-empty, so this exact call returned an
  // identity asserted for an unrelated OAuth application.
  it("refuses everything when no Google client is configured, and never calls the provider", async () => {
    configState.googleClientId = undefined;
    expect(isGoogleAuthConfigured()).toBe(false);

    stubProvider(fixture({ aud: OTHER_CLIENT }));
    expect(await verifyGoogleIdToken("dummy-identity-token")).toBeNull();

    // Even an otherwise-perfect response is refused: with no configured
    // audience there is nothing tying the token to this application.
    stubProvider(fixture());
    expect(await verifyGoogleIdToken("dummy-identity-token")).toBeNull();

    // Fail closed BEFORE the network call, so an unconfigured deployment
    // cannot be probed for provider behaviour either.
    expect(tokeninfoCalls).toBe(0);
  });

  it("treats an empty or whitespace-only client id as unconfigured", async () => {
    for (const value of ["", "   ", ","]) {
      configState.googleClientId = value;
      expect(isGoogleAuthConfigured()).toBe(false);
      expect(await verifyGoogleIdToken("dummy-identity-token")).toBeNull();
    }
  });
});

describe("SEC-05 — remaining token claims", () => {
  it("rejects an expired token", async () => {
    stubProvider(fixture({ exp: String(Math.floor(Date.now() / 1000) - 1) }));
    expect(await verifyGoogleIdToken("dummy-identity-token")).toBeNull();
  });

  it("rejects a response with no expiry claim", async () => {
    const body = fixture();
    delete body.exp;
    stubProvider(body);
    expect(await verifyGoogleIdToken("dummy-identity-token")).toBeNull();
  });

  it("rejects a foreign issuer", async () => {
    stubProvider(fixture({ iss: "https://accounts.google.com.attacker.invalid" }));
    expect(await verifyGoogleIdToken("dummy-identity-token")).toBeNull();
  });

  it("accepts both spellings of the Google issuer", async () => {
    stubProvider(fixture({ iss: "accounts.google.com" }));
    expect(await verifyGoogleIdToken("dummy-identity-token")).not.toBeNull();
  });

  it("rejects an unverified email", async () => {
    stubProvider(fixture({ email_verified: false }));
    expect(await verifyGoogleIdToken("dummy-identity-token")).toBeNull();
  });

  it("rejects a response missing sub or email", async () => {
    stubProvider(fixture({ sub: "" }));
    expect(await verifyGoogleIdToken("dummy-identity-token")).toBeNull();
    stubProvider(fixture({ email: "" }));
    expect(await verifyGoogleIdToken("dummy-identity-token")).toBeNull();
  });

  it("rejects a provider error status", async () => {
    stubProvider({ error_description: "Invalid Value" }, 400);
    expect(await verifyGoogleIdToken("dummy-identity-token")).toBeNull();
  });

  it("rejects when the provider is unreachable", async () => {
    stubProvider(null);
    expect(await verifyGoogleIdToken("dummy-identity-token")).toBeNull();
  });

  it("rejects an empty id token without contacting the provider", async () => {
    expect(await verifyGoogleIdToken("")).toBeNull();
    expect(tokeninfoCalls).toBe(0);
  });
});
