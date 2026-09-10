// SPDX-License-Identifier: Apache-2.0

/**
 * Integration coverage for `cleanupMcpOAuth`'s orphaned-client pruning.
 *
 * `POST /mcp/oauth/register` (RFC 7591) is unauthenticated and every
 * registration is a permanent `oauth_clients` row — before this, the row was
 * never pruned. Zed alone re-registers on every connection because its OAuth
 * callback port changes each time, so ordinary use of one real client grows
 * this table without bound, on top of the DCR endpoint being a plain abuse
 * surface. This suite proves the sweep prunes the right rows and only the
 * right rows:
 *
 *  1. a client with no child row at all, past the grace period, is deleted;
 *  2. a client registered inside the grace period is left alone, even with
 *     zero child rows — a person may still be mid-flow;
 *  3. a client with ANY live child row (a pending request, an unconsumed
 *     code, a live access token, a live refresh token) is left alone, no
 *     matter how old;
 *  4. a client whose only child rows are EXPIRED is deleted in the same run
 *     that deletes those expired rows — proving the two deletes inside one
 *     `$transaction` see each other;
 *  5. deleting a client sets `clientId` to null on its audit events rather
 *     than deleting them (schema `onDelete: SetNull`) — the audit trail
 *     survives.
 *
 * Against the real local Postgres, driving `cleanupMcpOAuth` directly rather
 * than through HTTP — this is a service-level sweep, not a route.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AuthMethod } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { cleanupMcpOAuth } from "./mcp-oauth.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

const NOW = new Date();
const WELL_PAST_GRACE = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
const INSIDE_GRACE = new Date(NOW.getTime() - 60 * 60 * 1000);
const PAST_EXPIRY = new Date(NOW.getTime() - 60 * 60 * 1000);
const FUTURE_EXPIRY = new Date(NOW.getTime() + 60 * 60 * 1000);

let testUserId: string;
const createdClientIds: string[] = [];

async function makeClient(overrides: { createdAt: Date; updatedAt?: Date; clientName: string }) {
  const clientId = `db_mcp_client_test_${Math.random().toString(36).slice(2)}`;
  createdClientIds.push(clientId);
  await prisma.oAuthClient.create({
    data: {
      clientId,
      clientName: overrides.clientName,
      redirectUris: ["http://127.0.0.1:9/callback"],
      createdAt: overrides.createdAt,
      updatedAt: overrides.updatedAt ?? overrides.createdAt,
    },
  });
  // `updatedAt` is stamped by Prisma's `@updatedAt` on write, so a plain
  // `create` cannot set it directly to a past value. Force it with a
  // follow-up raw update, exactly as a real row's `updatedAt` would sit in
  // the past until something touches it again.
  await prisma.$executeRaw`UPDATE oauth_clients SET updated_at = ${overrides.updatedAt ?? overrides.createdAt} WHERE client_id = ${clientId}`;
  return clientId;
}

beforeEach(async () => {
  const user = await prisma.user.create({
    data: {
      email: `mcp-cleanup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      passwordHash: "unused",
      handle: `mcpcleanup${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      displayName: "MCP Cleanup Test",
      emailVerifiedAt: new Date(),
      authMethod: AuthMethod.email,
    },
  });
  testUserId = user.id;
});

afterAll(async () => {
  if (createdClientIds.length) {
    await prisma.oAuthClient.deleteMany({ where: { clientId: { in: createdClientIds } } });
  }
  await prisma.$disconnect();
});

describe("cleanupMcpOAuth — orphaned client pruning", () => {
  it("deletes a childless client once it is past the grace period", async () => {
    const clientId = await makeClient({ createdAt: WELL_PAST_GRACE, clientName: "orphan, aged out" });
    await cleanupMcpOAuth();
    expect(await prisma.oAuthClient.findUnique({ where: { clientId } })).toBeNull();
  });

  it("leaves a childless client alone while it is still inside the grace period", async () => {
    const clientId = await makeClient({ createdAt: INSIDE_GRACE, clientName: "orphan, still fresh" });
    await cleanupMcpOAuth();
    expect(await prisma.oAuthClient.findUnique({ where: { clientId } })).not.toBeNull();
  });

  it("never deletes a client with a live pending authorization request, however old", async () => {
    const clientId = await makeClient({ createdAt: WELL_PAST_GRACE, clientName: "live pending request" });
    await prisma.oAuthAuthorizationRequest.create({
      data: {
        clientId,
        redirectUri: "http://127.0.0.1:9/callback",
        scope: ["read"],
        codeChallenge: "x".repeat(43),
        resource: "https://example.test/mcp",
        expiresAt: FUTURE_EXPIRY,
      },
    });
    await cleanupMcpOAuth();
    expect(await prisma.oAuthClient.findUnique({ where: { clientId } })).not.toBeNull();
  });

  it("never deletes a client with a live (unexpired) access token, however old the client is", async () => {
    const clientId = await makeClient({ createdAt: WELL_PAST_GRACE, clientName: "live access token" });
    await prisma.oAuthAccessToken.create({
      data: { tokenHash: `h_${Math.random()}`, clientId, userId: testUserId, scope: ["read"], expiresAt: FUTURE_EXPIRY },
    });
    await cleanupMcpOAuth();
    expect(await prisma.oAuthClient.findUnique({ where: { clientId } })).not.toBeNull();
  });

  it("never deletes a client with a live refresh token", async () => {
    const clientId = await makeClient({ createdAt: WELL_PAST_GRACE, clientName: "live refresh token" });
    await prisma.oAuthRefreshToken.create({
      data: { tokenHash: `h_${Math.random()}`, clientId, userId: testUserId, scope: ["read"], expiresAt: FUTURE_EXPIRY },
    });
    await cleanupMcpOAuth();
    expect(await prisma.oAuthClient.findUnique({ where: { clientId } })).not.toBeNull();
  });

  it("never deletes a client with an unconsumed authorization code", async () => {
    const clientId = await makeClient({ createdAt: WELL_PAST_GRACE, clientName: "live code" });
    await prisma.oAuthAuthorizationCode.create({
      data: {
        codeHash: `h_${Math.random()}`,
        clientId,
        userId: testUserId,
        redirectUri: "http://127.0.0.1:9/callback",
        codeChallenge: "x".repeat(43),
        scope: ["read"],
        resource: "https://example.test/mcp",
        expiresAt: FUTURE_EXPIRY,
      },
    });
    await cleanupMcpOAuth();
    expect(await prisma.oAuthClient.findUnique({ where: { clientId } })).not.toBeNull();
  });

  it("deletes a client whose only child rows are EXPIRED, in the same run that deletes those rows", async () => {
    // Proves the two deletes inside cleanupMcpOAuth's $transaction see each
    // other: the client only qualifies as an orphan AFTER the expired access
    // token ahead of it in the same transaction is gone.
    const clientId = await makeClient({ createdAt: WELL_PAST_GRACE, clientName: "expired-only" });
    await prisma.oAuthAccessToken.create({
      data: { tokenHash: `h_${Math.random()}`, clientId, userId: testUserId, scope: ["read"], expiresAt: PAST_EXPIRY },
    });
    await cleanupMcpOAuth();
    expect(await prisma.oAuthAccessToken.findFirst({ where: { clientId } })).toBeNull();
    expect(await prisma.oAuthClient.findUnique({ where: { clientId } })).toBeNull();
  });

  it("deletes a client but preserves its audit trail, nulling clientId rather than removing the rows", async () => {
    const clientId = await makeClient({ createdAt: WELL_PAST_GRACE, clientName: "audited orphan" });
    await prisma.oAuthAuditEvent.create({ data: { action: "client.registered", clientId, metadata: { clientName: "audited orphan" } } });
    await cleanupMcpOAuth();
    expect(await prisma.oAuthClient.findUnique({ where: { clientId } })).toBeNull();
    const event = await prisma.oAuthAuditEvent.findFirst({ where: { action: "client.registered", metadata: { path: ["clientName"], equals: "audited orphan" } } });
    expect(event).not.toBeNull();
    expect(event?.clientId).toBeNull();
  });
});

describe("cleanupMcpOAuth — authorization-code retention (feeds replay-revocation, R6)", () => {
  async function makeCode(overrides: { usedAt: Date | null; expiresAt: Date; clientId?: string }) {
    const clientId = overrides.clientId ?? (await makeClient({ createdAt: WELL_PAST_GRACE, clientName: "code owner" }));
    const code = await prisma.oAuthAuthorizationCode.create({
      data: {
        codeHash: `h_${Math.random()}`,
        clientId,
        userId: testUserId,
        redirectUri: "http://127.0.0.1:9/callback",
        scope: ["read"],
        codeChallenge: "x".repeat(43),
        resource: "https://example.test/mcp",
        expiresAt: overrides.expiresAt,
        usedAt: overrides.usedAt,
      },
    });
    return { codeId: code.id, clientId };
  }

  it("deletes an UNUSED code once it is expired, exactly as before", async () => {
    const { codeId } = await makeCode({ usedAt: null, expiresAt: PAST_EXPIRY });
    await cleanupMcpOAuth();
    expect(await prisma.oAuthAuthorizationCode.findUnique({ where: { id: codeId } })).toBeNull();
  });

  it("keeps a USED code alive past its own expiresAt while a token it minted is still live", async () => {
    // CODE_TTL_MS is 60 seconds, so a used code is virtually always "expired"
    // by wall-clock time within moments of being exchanged. An unconditional
    // expiry-delete would sever the replay-revocation link on the very first
    // sweep after nearly every legitimate exchange.
    const { codeId, clientId } = await makeCode({ usedAt: new Date(), expiresAt: PAST_EXPIRY });
    await prisma.oAuthAccessToken.create({
      data: { tokenHash: `h_${Math.random()}`, clientId, userId: testUserId, scope: ["read"], expiresAt: FUTURE_EXPIRY, authorizationCodeId: codeId },
    });
    await cleanupMcpOAuth();
    expect(await prisma.oAuthAuthorizationCode.findUnique({ where: { id: codeId } })).not.toBeNull();
  });

  it("prunes a USED code once every token it minted is gone (revoked, or expired-and-deleted in the same sweep)", async () => {
    const { codeId: revokedCase, clientId: c1 } = await makeCode({ usedAt: new Date(), expiresAt: PAST_EXPIRY });
    await prisma.oAuthRefreshToken.create({
      data: { tokenHash: `h_${Math.random()}`, clientId: c1, userId: testUserId, scope: ["read"], expiresAt: FUTURE_EXPIRY, revokedAt: new Date(), authorizationCodeId: revokedCase },
    });

    const { codeId: expiredCase, clientId: c2 } = await makeCode({ usedAt: new Date(), expiresAt: PAST_EXPIRY });
    await prisma.oAuthAccessToken.create({
      data: { tokenHash: `h_${Math.random()}`, clientId: c2, userId: testUserId, scope: ["read"], expiresAt: PAST_EXPIRY, authorizationCodeId: expiredCase },
    });

    await cleanupMcpOAuth();
    // Both: the revoked token leaves nothing live; the expired token was
    // deleted earlier in the SAME transaction, which is what makes this
    // deletion possible without a second sweep.
    expect(await prisma.oAuthAuthorizationCode.findUnique({ where: { id: revokedCase } })).toBeNull();
    expect(await prisma.oAuthAuthorizationCode.findUnique({ where: { id: expiredCase } })).toBeNull();
  });

  it("deleting a used-up code nulls authorizationCodeId on tokens that already pointed at it, never deletes the tokens themselves", async () => {
    const { codeId, clientId } = await makeCode({ usedAt: new Date(), expiresAt: PAST_EXPIRY });
    const revoked = await prisma.oAuthRefreshToken.create({
      data: { tokenHash: `h_${Math.random()}`, clientId, userId: testUserId, scope: ["read"], expiresAt: FUTURE_EXPIRY, revokedAt: new Date(), authorizationCodeId: codeId },
    });
    await cleanupMcpOAuth();
    expect(await prisma.oAuthAuthorizationCode.findUnique({ where: { id: codeId } })).toBeNull();
    const survivor = await prisma.oAuthRefreshToken.findUnique({ where: { id: revoked.id } });
    expect(survivor).not.toBeNull();
    expect(survivor?.authorizationCodeId).toBeNull();
  });
});
