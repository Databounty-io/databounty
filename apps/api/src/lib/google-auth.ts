// SPDX-License-Identifier: Apache-2.0

import { config } from "../config.js";

const GOOGLE_TOKENINFO_URL =
  process.env.GOOGLE_TOKENINFO_URL ?? "https://oauth2.googleapis.com/tokeninfo";
const FETCH_TIMEOUT_MS = Number(process.env.GOOGLE_AUTH_TIMEOUT_MS ?? 5000);

const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export interface GoogleIdentity {
  googleId: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

/**
 * The audiences this deployment will accept, taken from `GOOGLE_CLIENT_ID`.
 *
 * A comma-separated value is allowed on purpose: the member dashboard and the
 * admin console can be registered as two OAuth clients of the same project,
 * and both must be nameable without inventing a second environment variable.
 * Every entry is matched EXACTLY — no prefix, suffix or substring matching.
 */
export function googleAllowedAudiences(): string[] {
  return (config.googleClientId ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Whether Google sign-in is configured at all.
 *
 * SEC-05 (2026-09-05): this used to be implicit, and it failed OPEN. The
 * verifier only compared `aud` when `config.googleClientId` was non-empty,
 * while the `/v1/auth/google` and `/v1/auth/google/admin` routes stayed
 * mounted and usable regardless. A deployment that simply forgot
 * `GOOGLE_CLIENT_ID` therefore accepted a provider response whose audience
 * belonged to a completely unrelated OAuth application — proven in the
 * 2026-09-05 review, where the real verifier accepted a tokeninfo fixture
 * with `aud: "different-dummy-oauth-client"`.
 *
 * Audience is the only thing that ties a Google-issued token to THIS
 * application, so with no configured client id there is nothing left to check
 * and the only safe answer is to refuse. Callers must gate the login routes on
 * this and reject; they must not fall through to the verifier. The local test
 * environment leaves `GOOGLE_CLIENT_ID` unset, which now means "Google login
 * is off here" rather than "Google login accepts anything".
 */
export function isGoogleAuthConfigured(): boolean {
  return googleAllowedAudiences().length > 0;
}

/** Seconds-since-epoch claim, tolerating tokeninfo's string encoding. */
function numericClaim(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity | null> {
  if (!idToken) return null;
  // Fail closed: no configured audience means no way to prove the token was
  // minted for us. See isGoogleAuthConfigured().
  if (!isGoogleAuthConfigured()) return null;
  const allowedAudiences = googleAllowedAudiences();
  try {
    const res = await fetch(
      `${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    if (!res.ok) return null;
    const d = (await res.json()) as Record<string, unknown>;

    if (typeof d.aud !== "string" || !allowedAudiences.includes(d.aud)) return null;
    if (typeof d.iss !== "string" || !GOOGLE_ISSUERS.has(d.iss)) return null;
    // `exp` is what makes a tokeninfo response time-bounded. Google rejects
    // expired tokens itself, but a cached, replayed or proxied response would
    // otherwise be accepted forever, so the claim is checked here too and a
    // missing/unparseable one is a rejection rather than a skip.
    const exp = numericClaim(d.exp);
    if (exp === null || exp * 1000 <= Date.now()) return null;
    if (d.email_verified !== true && d.email_verified !== "true") return null;
    if (typeof d.email !== "string" || !d.email) return null;
    if (typeof d.sub !== "string" || !d.sub) return null;

    return {
      googleId: d.sub,
      email: d.email.toLowerCase(),
      name: typeof d.name === "string" && d.name ? d.name : d.email.split("@")[0] ?? "user",
      emailVerified: true,
    };
  } catch {
    return null;
  }
}
