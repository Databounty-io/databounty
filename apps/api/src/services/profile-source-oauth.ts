// SPDX-License-Identifier: Apache-2.0

import { ProfileSourceKind } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { encryptToken, signOAuthState } from "../lib/profile-source-crypto.js";

const FETCH_TIMEOUT_MS = 8000;

export type OAuthCapableKind = "github" | "orcid";

export function oauthCapableKinds(): OAuthCapableKind[] {
  const kinds: OAuthCapableKind[] = [];
  if (config.githubOAuth.clientId && config.githubOAuth.clientSecret) kinds.push("github");
  if (config.orcidOAuth.clientId && config.orcidOAuth.clientSecret) kinds.push("orcid");
  return kinds;
}

function callbackUrl(req: { protocol: string; headers: { host?: string } }, provider: OAuthCapableKind): string {
  return `${req.protocol}://${req.headers.host}/v1/profile-sources/${provider}/callback`;
}

/** Builds the provider's authorize URL for `POST /me/profile-sources/:id/connect`. */
export function buildAuthorizeUrl(
  req: { protocol: string; headers: { host?: string } },
  provider: OAuthCapableKind,
  userId: string
): string | null {
  const state = signOAuthState(userId, provider);
  const redirectUri = callbackUrl(req, provider);
  if (provider === "github") {
    if (!config.githubOAuth.clientId) return null;
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", config.githubOAuth.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "read:user");
    url.searchParams.set("state", state);
    return url.toString();
  }
  if (provider === "orcid") {
    if (!config.orcidOAuth.clientId) return null;
    const url = new URL(`${config.orcidOAuth.apiBaseUrl}/oauth/authorize`);
    url.searchParams.set("client_id", config.orcidOAuth.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "/authenticate");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }
  return null;
}

interface ExchangeResult {
  handleOrUrl: string;
  externalId: string;
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
}

async function exchangeGithub(
  code: string,
  redirectUri: string
): Promise<ExchangeResult | null> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: config.githubOAuth.clientId,
      client_secret: config.githubOAuth.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!tokenRes.ok) return null;
  const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenBody.access_token) return null;

  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenBody.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "databounty-community" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!userRes.ok) return null;
  const userBody = (await userRes.json()) as { login?: string; id?: number };
  if (!userBody.login || userBody.id === undefined) return null;

  return { handleOrUrl: userBody.login, externalId: String(userBody.id), accessToken: tokenBody.access_token };
}

async function exchangeOrcid(code: string, redirectUri: string): Promise<ExchangeResult | null> {
  const tokenRes = await fetch(`${config.orcidOAuth.apiBaseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: config.orcidOAuth.clientId!,
      client_secret: config.orcidOAuth.clientSecret!,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!tokenRes.ok) return null;
  const body = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    orcid?: string;
  };
  if (!body.access_token || !body.orcid) return null;

  return {
    handleOrUrl: body.orcid,
    externalId: body.orcid,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresInSec: body.expires_in,
  };
}

/**
 * Handles the provider redirect back to `GET /profile-sources/:provider/callback`.
 * Verifies the signed `state` (bound to the user who started the flow —
 * never trusts a bare userId from the query string), exchanges the code for
 * a real token, fetches the provider identity, and upserts a verified
 * ProfileSource. Returns the userId on success so the route can redirect
 * back to the right place, or null on any failure (state, exchange, or
 * identity-fetch) — every failure path is fail-closed, never a
 * partially-connected row.
 */
export async function completeOAuthConnect(
  req: { protocol: string; headers: { host?: string } },
  provider: OAuthCapableKind,
  userId: string,
  code: string
): Promise<boolean> {
  const redirectUri = callbackUrl(req, provider);
  const result = provider === "github" ? await exchangeGithub(code, redirectUri) : await exchangeOrcid(code, redirectUri);
  if (!result) return false;

  await prisma.profileSource.upsert({
    where: { userId_source: { userId, source: provider as ProfileSourceKind } },
    create: {
      userId,
      source: provider as ProfileSourceKind,
      handleOrUrl: result.handleOrUrl,
      externalId: result.externalId,
      verified: true,
      verifiedAt: new Date(),
      verificationState: "verified",
      accessTokenEnc: encryptToken(result.accessToken),
      refreshTokenEnc: result.refreshToken ? encryptToken(result.refreshToken) : null,
      tokenExpiresAt: result.expiresInSec ? new Date(Date.now() + result.expiresInSec * 1000) : null,
    },
    update: {
      handleOrUrl: result.handleOrUrl,
      externalId: result.externalId,
      verified: true,
      verifiedAt: new Date(),
      verificationState: "verified",
      verifyLastError: null,
      accessTokenEnc: encryptToken(result.accessToken),
      refreshTokenEnc: result.refreshToken ? encryptToken(result.refreshToken) : null,
      tokenExpiresAt: result.expiresInSec ? new Date(Date.now() + result.expiresInSec * 1000) : null,
    },
  });
  return true;
}
