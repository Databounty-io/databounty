// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level coverage for the reporter-facing `/v1/issues` surface.
 *
 * These lock down six behaviours that were each reproducible against a running
 * server, and each of which fails in a way a caller cannot distinguish from a
 * correct answer:
 *
 *  A. A case never claims `contextCollection: "complete"` unless resources
 *     were genuinely resolved. The column defaulted to "complete" and no
 *     writer ever set it, so every case displayed a green "Context attached"
 *     pill above "No resources were named on this case."
 *  B. `GET /v1/issues` validates its whole query. `?limit=abc` used to reach
 *     Prisma as `take: NaN` and return a 500 whose body carried absolute
 *     source paths.
 *  C. The list cursor is an encoded, filter-bound token. A bare row id came
 *     back as an empty 200 for a nonexistent cursor and silently paged the
 *     wrong set after a filter change.
 *  D. An unrecognized `status` is a 400, not a silently unfiltered 200.
 *  E. `POST /v1/issues` returns a narrow projection, not the raw Prisma row.
 *  F. Intake dedupes on a caller-supplied Idempotency-Key.
 *
 * Same harness as the other route-level integration tests here: Fastify
 * inject() against buildApp(), no port bound, refuses to run outside the
 * disposable verification database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

const TAG = "issuesintake";

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdDatasetTypeIds: string[] = [];

/**
 * Two reporters, created once. `POST /v1/auth/signup` is rate-limited to 10 a
 * minute per key (routes/v1/auth.ts AUTH_RATE_LIMIT) — a fixture-per-test
 * would 429 halfway through this file and every failure would read as a
 * product defect. Cases are cleared per test instead, which is what the
 * assertions actually need.
 */
let primary: { userId: string; cookie: string };
let secondary: { userId: string; cookie: string };

/** Every case belonging to these reporters, gone. Keeps `issueCount`
 * assertions exact without needing a fresh account. */
async function resetIssues() {
  const ids = [primary.userId, secondary.userId];
  await prisma.agentIssueEvent.deleteMany({ where: { issue: { reporterUserId: { in: ids } } } });
  await prisma.agentIssue.deleteMany({ where: { reporterUserId: { in: ids } } });
}

beforeAll(async () => {
  // This file signs up ~20 fixture reporters; the global limiter's default
  // would 429 the later ones. Lifted for this app instance only — the limiter
  // itself is covered by the MCP rate-limit suites.
  process.env.RATELIMIT_GLOBAL_MAX = "100000";
  app = await buildApp();
  await app.ready();
  primary = await signupVerified();
  secondary = await signupVerified();
});

beforeEach(async () => {
  await resetIssues();
});

afterAll(async () => {
  await prisma.agentIssueEvent.deleteMany({ where: { issue: { reporterUserId: { in: createdUserIds } } } });
  await prisma.agentIssue.deleteMany({ where: { reporterUserId: { in: createdUserIds } } });
  await prisma.jobQueue.deleteMany({ where: { type: { startsWith: "agent_issue." } } });
  await prisma.datasetType.deleteMany({ where: { id: { in: createdDatasetTypeIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
  await prisma.$disconnect();
  delete process.env.RATELIMIT_GLOBAL_MAX;
});

async function signupVerified() {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email: `${TAG}-${stamp}@example.com`,
      password: "Test@12345",
      handle: `${TAG}${stamp}`.replace(/[^a-z0-9]/gi, "").slice(0, 20),
      displayName: "Issues Intake Fixture",
    },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  createdUserIds.push(userId);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { userId, cookie };
}

async function seedDatasetType() {
  const type = await prisma.datasetType.create({
    data: {
      id: `${TAG}-type-${Math.random().toString(36).slice(2, 8)}`,
      domain: "coding",
      name: `Issues Intake Fixture Type`,
      description: "Fixture dataset type for the /v1/issues intake tests.",
      status: "active",
      origin: "platform",
      category: "implementation",
      trustTier: "llm_verified",
      fields: [{ key: "instruction", label: "Instruction", role: "instruction", required: true }],
      verification: { pipeline: ["schema", "human_audit"], dedupeFields: ["instruction"], auditOptions: [25, 100] },
      difficultyLevels: ["intermediate"],
      complexityScore: 2,
      verificationUnits: 1,
    },
  });
  createdDatasetTypeIds.push(type.id);
  return type.id;
}

let keySeq = 0;
/** Idempotency keys are caller-supplied now; ≥16 chars is the route's floor. */
function idemKey(prefix = "k"): string {
  keySeq += 1;
  return `${TAG}-${prefix}-${Date.now()}-${keySeq}-${Math.random().toString(36).slice(2, 8)}`;
}

function reportPayload(extra: Record<string, unknown> = {}) {
  return {
    category: "validation",
    impact: "degraded",
    summary: "Validation rejected an item that matches the contract",
    expected: "The item is accepted because every required field is present",
    actual: "The item is rejected with no field named",
    ...extra,
  };
}

function file(cookie: string, payload: Record<string, unknown>, key = idemKey()) {
  return app.inject({
    method: "POST",
    url: "/v1/issues",
    headers: { cookie, origin: "http://localhost:3010", "idempotency-key": key },
    payload,
  });
}

describe("A. contextCollection never over-claims", () => {
  it("does NOT report `complete` for a case with no resolved resources", async () => {
    const { cookie, userId } = primary;
    const res = await file(cookie, reportPayload());
    expect(res.statusCode).toBe(201);

    // The claim the caller is handed.
    expect(res.json().contextCollection).not.toBe("complete");
    expect(res.json().contextCollection).toBe("unavailable");
    expect(res.json().claimedResources).toEqual([]);

    // The claim that is STORED — the pill reads this, so the row itself must
    // not say "complete" either.
    const row = await prisma.agentIssue.findFirstOrThrow({ where: { reporterUserId: userId } });
    expect(row.contextCollection).not.toBe("complete");
    expect(row.contextCollection).toBe("unavailable");

    // And the read side agrees: an empty resource list beside an honest state,
    // never an empty list beside a success pill.
    const detail = await app.inject({ method: "GET", url: `/v1/issues/${res.json().id}`, headers: { cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().contextCollection).toBe("unavailable");
    expect(detail.json().resources).toEqual([]);
    expect(detail.json().unresolvedIds).toEqual([]);
  });

  it("reports `complete` only when every named resource actually resolved", async () => {
    const { cookie } = primary;
    const datasetTypeId = await seedDatasetType();
    const res = await file(cookie, reportPayload({ datasetTypeId }));
    expect(res.statusCode).toBe(201);
    expect(res.json().contextCollection).toBe("complete");
    expect(res.json().claimedResources).toEqual([{ kind: "datasetType", id: datasetTypeId }]);

    const detail = await app.inject({ method: "GET", url: `/v1/issues/${res.json().id}`, headers: { cookie } });
    expect(detail.json().resources).toHaveLength(1);
    expect(detail.json().resources[0]).toMatchObject({ kind: "dataset_type", id: datasetTypeId });
    expect(detail.json().unresolvedIds).toEqual([]);
  });

  it("reports `partial` when some named ids resolved and some did not", async () => {
    const { cookie } = primary;
    const datasetTypeId = await seedDatasetType();
    const res = await file(cookie, reportPayload({ datasetTypeId, submissionId: "sub_does_not_exist" }));
    expect(res.statusCode).toBe(201);
    expect(res.json().contextCollection).toBe("partial");

    const detail = await app.inject({ method: "GET", url: `/v1/issues/${res.json().id}`, headers: { cookie } });
    expect(detail.json().resources.map((r: { id: string }) => r.id)).toEqual([datasetTypeId]);
    expect(detail.json().unresolvedIds).toEqual(["sub_does_not_exist"]);
  });

  it("reports `unavailable` — not `partial` — when nothing at all resolved", async () => {
    const { cookie } = primary;
    const res = await file(cookie, reportPayload({ bountyId: "bnt_nope", submissionId: "sub_nope" }));
    expect(res.statusCode).toBe(201);
    expect(res.json().contextCollection).toBe("unavailable");

    const detail = await app.inject({ method: "GET", url: `/v1/issues/${res.json().id}`, headers: { cookie } });
    expect(detail.json().resources).toEqual([]);
    expect(detail.json().unresolvedIds.sort()).toEqual(["bnt_nope", "sub_nope"]);
  });

  it("a resource the reporter does not own is unresolved, not a 404", async () => {
    // Ownership scoping without an enumeration oracle: a stranger naming a
    // submission id gets it back as an unconfirmed claim and is told nothing
    // about whether the row exists. Contrast the datasetType case above, which
    // is catalog data and deliberately resolvable by anyone.
    const stranger = primary;
    const datasetTypeId = await seedDatasetType();
    const res = await file(
      stranger.cookie,
      reportPayload({ submissionId: "sub_someone_elses", contributorBatchId: "cb_someone_elses", datasetTypeId }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().contextCollection).toBe("partial");
    const detail = await app.inject({
      method: "GET",
      url: `/v1/issues/${res.json().id}`,
      headers: { cookie: stranger.cookie },
    });
    expect(detail.json().unresolvedIds.sort()).toEqual(["cb_someone_elses", "sub_someone_elses"]);
    expect(detail.json().resources.map((r: { id: string }) => r.id)).toEqual([datasetTypeId]);
  });

  it("the migration's backfill statement only rewrites rows with no resolved resources", async () => {
    // The shipped backfill runs once at deploy time, so its predicate is
    // exercised here directly against seeded rows rather than left unverified.
    const { userId } = primary;
    const base = {
      reporterUserId: userId,
      reporterLabel: "fixture",
      source: "session",
      category: "other" as const,
      impact: "suggestion" as const,
      summary: "backfill fixture",
      expected: "e",
      actual: "a",
      fingerprint: "backfillfixture",
      contextCollection: "complete",
    };
    const noContext = await prisma.agentIssue.create({ data: { ...base, idempotencyKey: idemKey("bf1") } });
    const emptyResources = await prisma.agentIssue.create({
      data: { ...base, idempotencyKey: idemKey("bf2"), context: { resources: [], unresolvedIds: ["x"] } },
    });
    const realResources = await prisma.agentIssue.create({
      data: {
        ...base,
        idempotencyKey: idemKey("bf3"),
        context: { resources: [{ kind: "dataset_type", id: "dt_1" }], unresolvedIds: [] },
      },
    });
    const nonObjectContext = await prisma.agentIssue.create({
      data: { ...base, idempotencyKey: idemKey("bf4"), context: "not-an-object" },
    });

    await prisma.$executeRawUnsafe(`
      UPDATE "agent_issues"
      SET "context_collection" = 'unavailable'
      WHERE "context_collection" = 'complete'
        AND CASE
              WHEN jsonb_typeof("context" -> 'resources') = 'array'
                THEN jsonb_array_length("context" -> 'resources')
              ELSE 0
            END = 0
    `);

    const read = async (id: string) =>
      (await prisma.agentIssue.findUniqueOrThrow({ where: { id } })).contextCollection;
    expect(await read(noContext.id)).toBe("unavailable");
    expect(await read(emptyResources.id)).toBe("unavailable");
    expect(await read(nonObjectContext.id)).toBe("unavailable");
    // The one row with real evidence keeps its claim.
    expect(await read(realResources.id)).toBe("complete");
  });
});

describe("B. GET /v1/issues validates its query instead of 500ing", () => {
  it("400s on a non-numeric limit and leaks no filesystem path", async () => {
    const { cookie } = primary;
    const res = await app.inject({ method: "GET", url: "/v1/issues?limit=abc", headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/\/Users\/|\/src\/|node_modules|prisma/i);
  });

  it("400s on an out-of-range limit", async () => {
    const { cookie } = primary;
    for (const limit of ["0", "51", "1.5", "-3"]) {
      const res = await app.inject({ method: "GET", url: `/v1/issues?limit=${limit}`, headers: { cookie } });
      expect(res.statusCode, `limit=${limit}`).toBe(400);
    }
  });

  it("400s on an unparseable since/until and leaks no filesystem path", async () => {
    const { cookie } = primary;
    for (const url of ["/v1/issues?since=garbage", "/v1/issues?until=garbage"]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(res.statusCode, url).toBe(400);
      expect(res.body).not.toMatch(/\/Users\/|\/src\/|node_modules|prisma/i);
    }
  });

  it("400s on an inverted since/until range rather than returning zero rows", async () => {
    const { cookie } = primary;
    const res = await app.inject({
      method: "GET",
      url: "/v1/issues?since=2026-02-01T00:00:00.000Z&until=2026-01-01T00:00:00.000Z",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/earlier than/i);
  });

  it("400s on a too-short q rather than searching for it", async () => {
    const { cookie } = primary;
    const res = await app.inject({ method: "GET", url: "/v1/issues?q=a", headers: { cookie } });
    expect(res.statusCode).toBe(400);
  });

  it("still serves a valid query", async () => {
    const { cookie } = primary;
    await file(cookie, reportPayload());
    const res = await app.inject({ method: "GET", url: "/v1/issues?limit=5&status=received", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().issueCount).toBe(1);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().hasMore).toBe(false);
  });
});

describe("C. the list cursor is an encoded, filter-bound token", () => {
  it("400s on a bare row id rather than returning an empty page", async () => {
    const { cookie } = primary;
    const filed = await file(cookie, reportPayload());
    // A real row id is exactly the shape the old cursor accepted.
    for (const cursor of [filed.json().id, "nonexistent_id", "!!!not-base64!!!"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/issues?cursor=${encodeURIComponent(cursor)}`,
        headers: { cookie },
      });
      expect(res.statusCode, cursor).toBe(400);
      expect(res.json().message).toMatch(/cursor/i);
    }
  });

  it("pages correctly with the token it issued", async () => {
    const { cookie } = primary;
    for (let i = 0; i < 3; i += 1) {
      await file(cookie, reportPayload({ summary: `Paging fixture case number ${i}` }));
    }
    const first = await app.inject({ method: "GET", url: "/v1/issues?limit=2", headers: { cookie } });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(2);
    expect(first.json().hasMore).toBe(true);
    expect(first.json().issueCount).toBe(3);

    const second = await app.inject({
      method: "GET",
      url: `/v1/issues?limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().items).toHaveLength(1);
    expect(second.json().hasMore).toBe(false);
    // No row repeated across the two pages, and the count is filter-stable.
    const ids = [...first.json().items, ...second.json().items].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(3);
    expect(second.json().issueCount).toBe(3);
  });

  it("400s when a cursor minted under one filter is replayed under another", async () => {
    const { cookie } = primary;
    for (let i = 0; i < 3; i += 1) {
      await file(cookie, reportPayload({ summary: `Filter-bound fixture case number ${i}` }));
    }
    const first = await app.inject({ method: "GET", url: "/v1/issues?limit=1", headers: { cookie } });
    const cursor = encodeURIComponent(first.json().nextCursor);
    const replayed = await app.inject({
      method: "GET",
      url: `/v1/issues?limit=1&status=received&cursor=${cursor}`,
      headers: { cookie },
    });
    expect(replayed.statusCode).toBe(400);
    expect(replayed.json().message).toMatch(/different issue filter/i);
  });
});

describe("D. an unrecognized status is rejected, not ignored", () => {
  it("400s on ?status=bogus instead of returning the unfiltered set", async () => {
    const { cookie } = primary;
    await file(cookie, reportPayload());
    const res = await app.inject({ method: "GET", url: "/v1/issues?status=bogus", headers: { cookie } });
    expect(res.statusCode).toBe(400);
  });

  it("honours a real status filter", async () => {
    const { cookie } = primary;
    await file(cookie, reportPayload());
    const match = await app.inject({ method: "GET", url: "/v1/issues?status=received", headers: { cookie } });
    expect(match.json().issueCount).toBe(1);
    const miss = await app.inject({ method: "GET", url: "/v1/issues?status=resolved", headers: { cookie } });
    expect(miss.json().issueCount).toBe(0);
    expect(miss.json().items).toEqual([]);
  });
});

describe("E. POST /v1/issues returns a narrow projection", () => {
  it("returns exactly the reporter-facing fields and no internal columns", async () => {
    const { cookie } = primary;
    const res = await file(cookie, reportPayload());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(
      [
        "claimedResources",
        "contextCollection",
        "createdAt",
        "deduplicated",
        "guidance",
        "id",
        "message",
        "redactionApplied",
        "status",
        "version",
      ].sort(),
    );
    for (const leaked of [
      "reporterUserId",
      "credentialRef",
      "fingerprint",
      "idempotencyKey",
      "context",
      "events",
      "reporterLabel",
      "assignedToUserId",
    ]) {
      expect(body, leaked).not.toHaveProperty(leaked);
    }
    // The raw body must not carry an event's internal fields either.
    expect(res.body).not.toMatch(/internalOnly|actorUserId/);
  });
});

describe("F. intake dedupes on a caller-supplied Idempotency-Key", () => {
  it("400s when the header is missing or too short", async () => {
    const { cookie } = primary;
    const missing = await app.inject({
      method: "POST",
      url: "/v1/issues",
      headers: { cookie, origin: "http://localhost:3010" },
      payload: reportPayload(),
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toMatch(/Idempotency-Key/i);

    const short = await app.inject({
      method: "POST",
      url: "/v1/issues",
      headers: { cookie, origin: "http://localhost:3010", "idempotency-key": "tooshort" },
      payload: reportPayload(),
    });
    expect(short.statusCode).toBe(400);
  });

  it("returns 200 + deduplicated:true and opens no second case on a retry", async () => {
    const { cookie, userId } = primary;
    const key = idemKey("retry");
    const first = await file(cookie, reportPayload(), key);
    expect(first.statusCode).toBe(201);
    expect(first.json().deduplicated).toBe(false);

    const retry = await file(cookie, reportPayload(), key);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().deduplicated).toBe(true);
    expect(retry.json().id).toBe(first.json().id);

    expect(await prisma.agentIssue.count({ where: { reporterUserId: userId } })).toBe(1);
  });

  it("scopes the key to the reporter — one reporter's key never returns another's case", async () => {
    const a = primary;
    const b = secondary;
    const key = idemKey("shared");
    const first = await file(a.cookie, reportPayload(), key);
    const second = await file(b.cookie, reportPayload(), key);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().deduplicated).toBe(false);
    expect(second.json().id).not.toBe(first.json().id);
  });

  it("a distinct key from the same reporter still opens a distinct case", async () => {
    const { cookie, userId } = primary;
    await file(cookie, reportPayload(), idemKey("d1"));
    await file(cookie, reportPayload(), idemKey("d2"));
    expect(await prisma.agentIssue.count({ where: { reporterUserId: userId } })).toBe(2);
  });
});
