// SPDX-License-Identifier: Apache-2.0

/**
 * `profile_source.verify` — periodic re-check of a connected credential.
 *
 * Ported from v1 `src/services/profile-sources/revalidation.ts` (the check
 * itself and its evidence/notification contract) plus the bounded outbound
 * fetch + local circuit breaker from v1
 * `src/services/profile-sources/providers.ts`. Both are folded into one file
 * here because this rebuild has only two OAuth-capable providers and no
 * `profile-sources/` package — the registry v1 splits out would be a directory
 * containing one 40-line table.
 *
 * Why this matters: `ProfileSource.verified` feeds the reputation score
 * (`services/reputation.ts#computeReputationScore`). Before this handler
 * existed, a credential was verified once at connect time and then trusted
 * forever — a revoked GitHub grant or a deleted account kept paying reputation
 * points indefinitely, and the `ProfileSourceVerification` evidence table had
 * no writer at all.
 *
 * The one distinction that carries all the weight: a PROVIDER-WIDE transport
 * failure is not evidence that this user's grant is bad. Those record a
 * `deferred` check and retry later, preserving the verified projection; only a
 * real credential rejection (4xx / expired / missing token) flips
 * `verified: false` and notifies the member. Getting this backwards would turn
 * one GitHub outage into a platform-wide reputation drop plus a
 * reconnect-notification storm.
 */
import { ProfileSourceKind, type Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { config } from "../../config.js";
import { decryptToken } from "../../lib/profile-source-crypto.js";
import { notifyEvent } from "../notifications.js";
import { enqueueJob, workspaceKeyForUser } from "../jobs.js";

const RECHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const TEMPORARY_RETRY_MS = 60 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 10_000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000;
/** Adapter identity stamped on every evidence row, so a future change to how a
 * credential is checked is distinguishable from a change in the credential. */
const ADAPTER_VERSION = "v1";

export type CheckType = "initial" | "recheck";

/** Thrown for anything that is the PROVIDER's fault (open circuit, timeout,
 * unreachable host, 5xx). Never used for a credential rejection. */
export class ProfileProviderUnavailableError extends Error {}

function nextCheck(now: Date, delay = RECHECK_INTERVAL_MS): Date {
  return new Date(now.getTime() + delay);
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "credential verification failed").slice(0, 500);
}

async function assertProviderCircuitClosed(kind: ProfileSourceKind): Promise<void> {
  const circuit = await prisma.externalProviderCircuit.findUnique({ where: { provider: kind } });
  if (circuit?.openUntil && circuit.openUntil > new Date()) {
    throw new ProfileProviderUnavailableError(`${kind} is temporarily unavailable; retry later`);
  }
}

async function recordProviderSuccess(kind: ProfileSourceKind): Promise<void> {
  await prisma.externalProviderCircuit.upsert({
    where: { provider: kind },
    create: { provider: kind },
    update: { consecutiveFailures: 0, openUntil: null },
  });
}

async function recordProviderFailure(kind: ProfileSourceKind): Promise<void> {
  const circuit = await prisma.externalProviderCircuit.upsert({
    where: { provider: kind },
    create: { provider: kind, consecutiveFailures: 1 },
    update: { consecutiveFailures: { increment: 1 } },
  });
  if (circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    await prisma.externalProviderCircuit.update({
      where: { provider: kind },
      data: { openUntil: new Date(Date.now() + CIRCUIT_COOLDOWN_MS) },
    });
  }
}

/**
 * The one bounded outbound path for profile-provider traffic. A slow vendor
 * cannot block a worker forever, and repeated transport/5xx failures open a
 * local circuit. Credential 4xx responses are deliberately RETURNED to the
 * caller (not converted into a provider failure) so only that one credential
 * is invalidated — a user who revoked their grant must not take the provider
 * circuit down for everyone else.
 */
async function fetchProfileProvider(
  kind: ProfileSourceKind,
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
  await assertProviderCircuitClosed(kind);
  try {
    const res = await fetch(input, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    if (res.status >= 500) await recordProviderFailure(kind);
    else await recordProviderSuccess(kind);
    return res;
  } catch (error) {
    await recordProviderFailure(kind);
    if (error instanceof ProfileProviderUnavailableError) throw error;
    throw new ProfileProviderUnavailableError(`${kind} request timed out or could not reach the provider`);
  }
}

export interface ProviderIdentity {
  externalId: string;
  handleOrUrl: string;
}

/**
 * Re-verify a persisted credential from its STABLE identity only. It must not
 * depend on anything that existed solely in the original token-exchange
 * response, or a re-check would be impossible for an old row.
 *
 * Only the two kinds this deployment can actually connect
 * (`services/profile-source-oauth.ts`) have an entry. A manually claimed kind
 * (linkedin, scholar, kaggle, x, website) has no verification API here and is
 * honestly left unchecked rather than being re-checked by something that
 * cannot check it.
 */
const REVALIDATORS: Partial<Record<ProfileSourceKind, (accessToken: string, externalId: string) => Promise<ProviderIdentity>>> = {
  [ProfileSourceKind.github]: async (accessToken) => {
    const res = await fetchProfileProvider(ProfileSourceKind.github, "https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "databounty",
      },
    });
    if (!res.ok) throw new Error(`GitHub /user failed (${res.status})`);
    const body = (await res.json()) as { id: number; login: string };
    return { externalId: String(body.id), handleOrUrl: `https://github.com/${body.login}` };
  },
  [ProfileSourceKind.orcid]: async (accessToken, orcidId) => {
    const base = config.orcidOAuth.apiBaseUrl.includes("orcid.org")
      ? "https://api.orcid.org"
      : config.orcidOAuth.apiBaseUrl.replace(/\/+$/, "");
    const res = await fetchProfileProvider(
      ProfileSourceKind.orcid,
      `${base}/v3.0/${encodeURIComponent(orcidId)}/person`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.orcid+json",
          "User-Agent": "databounty",
        },
      }
    );
    if (!res.ok) throw new Error(`ORCID credential check failed (${res.status})`);
    return { externalId: orcidId, handleOrUrl: `https://orcid.org/${orcidId}` };
  },
};

/** Every kind this module can genuinely re-check. Used as the scanner's filter
 * so it never enqueues a job that would immediately record "no provider". */
export const REVALIDATABLE_KINDS = Object.keys(REVALIDATORS) as ProfileSourceKind[];

/**
 * Producer. The idempotency key is time-bucketed to the hour, so repeated
 * scanner ticks are cheap and concurrent workers cannot produce a
 * notification/reputation storm for one credential.
 */
export async function enqueueProfileSourceVerification(
  profileSourceId: string,
  checkType: CheckType,
  tx?: Prisma.TransactionClient
): Promise<string> {
  const client = tx ?? prisma;
  const key = `profile-source:${profileSourceId}:${checkType}:${Math.floor(Date.now() / 3_600_000)}`;
  // Fairness partition key (see dbJobQueue.claim): a user reconnecting a dozen
  // credentials must not push everyone else's checks behind theirs.
  const owner = await client.profileSource.findUnique({
    where: { id: profileSourceId },
    select: { userId: true },
  });
  await enqueueJob(
    "profile_source.verify",
    { profileSourceId, checkType, verificationKey: key },
    {
      idempotencyKey: key,
      workspaceId: owner ? workspaceKeyForUser(owner.userId) : undefined,
      maxAttempts: 8,
      tx,
    }
  );
  return key;
}

/**
 * Scanner. Enqueues only; it never calls an identity provider itself, so this
 * is safe to run from a request process as well as the worker.
 */
export async function revalidateDueProfileSources(
  opts: { limit?: number; userId?: string } = {}
): Promise<{ checked: number }> {
  const now = new Date();
  const rows = await prisma.profileSource.findMany({
    where: {
      verified: true,
      source: { in: REVALIDATABLE_KINDS },
      ...(opts.userId ? { userId: opts.userId } : {}),
      OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }],
    },
    orderBy: { nextCheckAt: "asc" },
    take: opts.limit ?? 50,
    select: { id: true },
  });
  for (const row of rows) await enqueueProfileSourceVerification(row.id, "recheck");
  return { checked: rows.length };
}

/**
 * `profile_source.verify` handler: one provider check, with its immutable
 * evidence row written either side of the call.
 *
 * Return value is the OUTCOME, not success/failure of the job: `invalid` and
 * `deferred` are both fully-recorded terminal results for this attempt, so the
 * caller acks. Only a persistence/queue error escapes as a throw.
 */
export async function verifyProfileSource(
  profileSourceId: string,
  checkType: CheckType,
  verificationKey: string
): Promise<"verified" | "invalid" | "deferred" | "skipped"> {
  const row = await prisma.profileSource.findUnique({ where: { id: profileSourceId } });
  if (!row) return "skipped";

  const evidence = await prisma.profileSourceVerification.upsert({
    where: { idempotencyKey: verificationKey },
    create: {
      profileSourceId,
      provider: row.source,
      checkType,
      status: "running",
      adapterVersion: ADAPTER_VERSION,
      idempotencyKey: verificationKey,
    },
    update: {},
  });
  const now = new Date();

  try {
    if (!row.accessTokenEnc || !row.externalId) {
      throw new Error("credential identity is unavailable; reconnect required");
    }
    if (row.tokenExpiresAt && row.tokenExpiresAt <= now) {
      throw new Error("credential expired; reconnect required");
    }
    const revalidate = REVALIDATORS[row.source];
    if (!revalidate) throw new Error("credential provider is unavailable; reconnect required");
    const accessToken = decryptToken(row.accessTokenEnc);
    // A token we cannot decrypt is a local key problem, not the member's
    // fault — treat it as deferred rather than silently invalidating a
    // credential that may be perfectly good.
    if (!accessToken) {
      throw new ProfileProviderUnavailableError("stored credential token could not be decrypted");
    }
    const identity = await revalidate(accessToken, row.externalId);
    await prisma.$transaction(async (tx) => {
      await tx.profileSource.update({
        where: { id: row.id },
        data: {
          handleOrUrl: identity.handleOrUrl,
          externalId: identity.externalId,
          verified: true,
          verificationState: "verified",
          verifiedAt: row.verifiedAt ?? now,
          lastCheckedAt: now,
          nextCheckAt: nextCheck(now),
          verifyLastError: null,
        },
      });
      await tx.profileSourceVerification.update({
        where: { id: evidence.id },
        data: {
          status: "verified",
          completedAt: now,
          errorCode: null,
          evidence: { externalId: identity.externalId, handleOrUrl: identity.handleOrUrl },
        },
      });
    });
    return "verified";
  } catch (error) {
    const message = errorMessage(error);
    // Provider-wide failure: preserve the verified projection, record a
    // deferred check, retry sooner. See the file header for why.
    if (error instanceof ProfileProviderUnavailableError) {
      await prisma.$transaction(async (tx) => {
        await tx.profileSource.update({
          where: { id: row.id },
          data: {
            lastCheckedAt: now,
            nextCheckAt: nextCheck(now, TEMPORARY_RETRY_MS),
            verifyLastError: message,
          },
        });
        await tx.profileSourceVerification.update({
          where: { id: evidence.id },
          data: {
            status: "deferred",
            completedAt: now,
            errorCode: "provider_unavailable",
            evidence: { externalId: row.externalId },
          },
        });
      });
      return "deferred";
    }
    // A genuine credential rejection. The projection flips to unverified —
    // which really does lower the reputation score — and the member is told,
    // once, keyed to this verification.
    await prisma.$transaction(async (tx) => {
      await tx.profileSource.update({
        where: { id: row.id },
        data: {
          verified: false,
          verificationState: "pending_recheck",
          lastCheckedAt: now,
          nextCheckAt: nextCheck(now, TEMPORARY_RETRY_MS),
          verifyLastError: message,
        },
      });
      await tx.profileSourceVerification.update({
        where: { id: evidence.id },
        data: {
          status: "failed",
          completedAt: now,
          errorCode: message,
          evidence: { externalId: row.externalId },
        },
      });
      await notifyEvent(tx, "profile.credential_recheck_failed", {
        userId: row.userId,
        entityId: row.id,
        keySuffix: verificationKey,
        data: { provider: row.source },
      });
    });
    return "invalid";
  }
}

/** Worker entry point. Payload carries identifiers only; the token is resolved
 * (and decrypted) here, inside the trusted worker. */
export async function runProfileSourceVerifyJob(payload: {
  profileSourceId: string;
  checkType: CheckType;
  verificationKey: string;
}): Promise<void> {
  await verifyProfileSource(payload.profileSourceId, payload.checkType, payload.verificationKey);
}
