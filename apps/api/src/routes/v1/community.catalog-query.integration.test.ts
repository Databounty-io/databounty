// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the public community-catalog query surface: server-side search
 * and filters, offset paging, the real per-pool submission rollup, the shared
 * lifecycle-phase vocabulary, and the validation queue.
 *
 * Every case here is a defect that was found live and fixed, so each one is a
 * regression guard rather than a restatement of the implementation:
 *  - `q` and `language` reached Postgres as unescaped ILIKE patterns, so a
 *    single `%` matched the entire catalog and defeated the filter outright.
 *  - A NUL byte in any string param was an unauthenticated 500 that echoed an
 *    absolute source path back to the caller.
 *  - `withPoolSummary=false` enabled the summary, because z.coerce.boolean()
 *    is JS truthiness and every non-empty query string is truthy.
 *  - `/v1/bounties` and the catalog disagreed on the name of the in-flight
 *    phase (`production` vs `open`), so a client that learned one name from
 *    one endpoint got a permanently empty grid from the other, and an unknown
 *    phase silently answered `status IN ()` with an empty 200 instead of 400.
 *  - `/v1/bounties` had no query schema at all: `limit=abc` and `offset=-1`
 *    were 500s, and `limit=-1` returned a page read from the wrong end of the
 *    ordering.
 *  - The catalog omitted `poolSummary` entirely, so the Landing grid could not
 *    show a submitted count or an audit queue depth without inventing one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { BountyKind, BountyStatus, GenerationMethod, SubmissionStatus } from "@prisma/client";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdDatasetTypeIds: string[] = [];
const createdBountyIds: string[] = [];
const createdSubmissionIds: string[] = [];

/** Unique enough that these fixtures can never be matched by another test's
 * search terms, and searchable enough to assert on. */
const TAG = `catq${Date.now().toString(36)}`;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.submission.deleteMany({ where: { id: { in: createdSubmissionIds } } });
  await prisma.datasetPublication.deleteMany({ where: { bountyId: { in: createdBountyIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  await prisma.datasetType.deleteMany({ where: { id: { in: createdDatasetTypeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function seedUser() {
  const user = await prisma.user.create({
    data: { authMethod: "email", email: `${TAG}-${Math.random().toString(36).slice(2, 8)}@local.test`, displayName: "Catalog Query Fixture" },
  });
  createdUserIds.push(user.id);
  return user.id;
}

async function seedDatasetType() {
  const type = await prisma.datasetType.create({
    data: {
      id: `${TAG}-type-${Math.random().toString(36).slice(2, 8)}`,
      domain: "coding",
      name: `Catalog Query Fixture Type ${TAG}`,
      description: "Fixture dataset type for the community-catalog query tests.",
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

async function seedBounty(params: {
  requesterUserId: string;
  datasetTypeId: string;
  title: string;
  description?: string;
  language?: string;
  status?: BountyStatus;
}) {
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: params.requesterUserId,
      kind: BountyKind.community,
      title: params.title,
      description: params.description ?? `Fixture pool ${TAG}`,
      datasetCategory: "implementation",
      language: params.language ?? "TypeScript",
      framework: "Node.js",
      targetItems: 50,
      karmaPerAcceptedItem: 25,
      auditCoveragePct: 10,
      auditMode: "partial",
      holdDays: 0,
      disputeWindowHours: 48,
      communityLicense: "CC-BY-4.0",
      poolDifficulty: "intermediate",
      status: params.status ?? BountyStatus.active,
      datasetTypeId: params.datasetTypeId,
    },
  });
  createdBountyIds.push(bounty.id);
  return bounty.id;
}

async function seedSubmission(bountyId: string, contributorUserId: string, status: SubmissionStatus) {
  const submission = await prisma.submission.create({
    data: {
      bountyId,
      contributorUserId,
      status,
      title: `Fixture submission ${TAG}`,
      payloadJson: { instruction: `fixture ${TAG}` },
      generationMethod: GenerationMethod.human,
    },
  });
  createdSubmissionIds.push(submission.id);
  return submission.id;
}

async function get(url: string) {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.statusCode === 200 ? res.json() : res.json() };
}

/** GET /v1/bounties/:id/contract requires the contribute scope (it can carry
 * sponsor work-brief file metadata) — any signed-in contributor account
 * satisfies it, not specifically the pool's own contributor. */
async function getAsContributor(url: string) {
  const email = `${TAG}-contract-${Math.random().toString(36).slice(2, 8)}@local.test`;
  const signup = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Test@12345", handle: `${TAG}c${Math.random().toString(36).slice(2, 8)}`, displayName: "Contract Fixture" },
  });
  const userId = signup.json().user.id as string;
  createdUserIds.push(userId);
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  const setCookie = signup.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;

  const res = await app.inject({ method: "GET", url, headers: { cookie, origin: "http://localhost:3010" } });
  return { status: res.statusCode, body: res.statusCode === 200 ? res.json() : res.json() };
}

describe("GET /v1/community/catalog — search and filters", () => {
  it("escapes SQL LIKE wildcards so a bare % is a literal, not 'match everything'", async () => {
    const requesterUserId = await seedUser();
    const datasetTypeId = await seedDatasetType();
    await seedBounty({ requesterUserId, datasetTypeId, title: `${TAG} plain pool` });
    await seedBounty({ requesterUserId, datasetTypeId, title: `${TAG} literal % pool` });

    // A pool whose title really does contain "%" is findable...
    const literal = await get(`/v1/community/catalog?q=${encodeURIComponent(`${TAG} literal %`)}&limit=50`);
    expect(literal.status).toBe(200);
    expect(literal.body.total).toBe(1);

    // ...but "%" alone must not behave as a wildcard over the whole catalog.
    const wildcard = await get(`/v1/community/catalog?q=${encodeURIComponent("%")}&limit=1`);
    const everything = await get("/v1/community/catalog?limit=1");
    expect(wildcard.status).toBe(200);
    expect(wildcard.body.total).toBeLessThan(everything.body.total);

    // Same for the underscore single-character wildcard, and for `language`,
    // which is documented as an exact (case-insensitive) match.
    const underscore = await get(`/v1/community/catalog?q=${encodeURIComponent("_")}&limit=1`);
    expect(underscore.body.total).toBeLessThan(everything.body.total);
    const langWildcard = await get(`/v1/community/catalog?language=${encodeURIComponent("%")}&limit=1`);
    expect(langWildcard.body.total).toBe(0);
  });

  it("searches title and description, case-insensitively, and combines filters as AND", async () => {
    const requesterUserId = await seedUser();
    const datasetTypeId = await seedDatasetType();
    await seedBounty({ requesterUserId, datasetTypeId, title: `${TAG} findable by title`, language: "Python" });
    await seedBounty({
      requesterUserId,
      datasetTypeId,
      title: `${TAG} other`,
      description: `${TAG} findable by description text`,
      language: "Go",
    });

    const byTitle = await get(`/v1/community/catalog?q=${encodeURIComponent(`${TAG} FINDABLE BY TITLE`.toUpperCase())}&limit=50`);
    expect(byTitle.body.total).toBe(1);

    const byDescription = await get(`/v1/community/catalog?q=${encodeURIComponent("findable by description")}&limit=50`);
    expect(byDescription.body.total).toBe(1);

    // q AND language, not q OR language.
    const both = await get(`/v1/community/catalog?q=${encodeURIComponent(TAG)}&language=Python&limit=50`);
    const qOnly = await get(`/v1/community/catalog?q=${encodeURIComponent(TAG)}&limit=50`);
    expect(both.body.total).toBe(1);
    expect(qOnly.body.total).toBeGreaterThan(both.body.total);
  });

  it("rejects a null byte with 400 instead of 500-ing out of the database driver", async () => {
    for (const param of ["q", "language", "datasetTypeId", "cursor"]) {
      const res = await get(`/v1/community/catalog?${param}=a%00b`);
      expect(res.status, `${param} should be rejected, not crash`).toBe(400);
    }
  });

  it("offers one language option per case-folded language", async () => {
    const requesterUserId = await seedUser();
    const datasetTypeId = await seedDatasetType();
    await seedBounty({ requesterUserId, datasetTypeId, title: `${TAG} lower`, language: "rustlang" });
    await seedBounty({ requesterUserId, datasetTypeId, title: `${TAG} upper`, language: "RustLang" });

    const res = await get("/v1/community/catalog?limit=1");
    const languages: string[] = res.body.filterOptions.languages;
    const rustish = languages.filter((l) => l.toLowerCase() === "rustlang");
    expect(rustish).toHaveLength(1);
  });
});

describe("GET /v1/community/catalog — paging and pool summaries", () => {
  it("pages by offset without duplicating or skipping a row", async () => {
    const first = await get("/v1/community/catalog?limit=5&offset=0");
    const second = await get("/v1/community/catalog?limit=5&offset=5");
    const ten = await get("/v1/community/catalog?limit=10&offset=0");

    const walked = [...first.body.bounties, ...second.body.bounties].map((b: { id: string }) => b.id);
    const straight = ten.body.bounties.map((b: { id: string }) => b.id);
    expect(walked).toEqual(straight);
    expect(new Set(walked).size).toBe(walked.length);
    expect(first.body.total).toBe(ten.body.total);
  });

  it("returns poolSummary counts that match the submission rows, and null when not asked for", async () => {
    const requesterUserId = await seedUser();
    const contributorUserId = await seedUser();
    const datasetTypeId = await seedDatasetType();
    const bountyId = await seedBounty({ requesterUserId, datasetTypeId, title: `${TAG} rollup pool` });
    await seedSubmission(bountyId, contributorUserId, SubmissionStatus.in_audit);
    await seedSubmission(bountyId, contributorUserId, SubmissionStatus.in_audit);
    await seedSubmission(bountyId, contributorUserId, SubmissionStatus.rejected);
    await seedSubmission(bountyId, contributorUserId, SubmissionStatus.submitted);

    const withSummary = await get(`/v1/community/catalog?q=${encodeURIComponent(`${TAG} rollup pool`)}&limit=5&withPoolSummary=true`);
    const row = withSummary.body.bounties.find((b: { id: string }) => b.id === bountyId);
    expect(row.poolSummary).toMatchObject({
      totalSubmitted: 4,
      validatorReview: 2,
      processing: 1,
      rejected: 1,
    });

    // Absent must be null, never a zeros object: "we did not look" and
    // "we looked and it is zero" must not render identically.
    const without = await get(`/v1/community/catalog?q=${encodeURIComponent(`${TAG} rollup pool`)}&limit=5`);
    expect(without.body.bounties.find((b: { id: string }) => b.id === bountyId).poolSummary).toBeNull();

    // Query strings are not JS truthiness: "false" means false.
    const explicitlyOff = await get(
      `/v1/community/catalog?q=${encodeURIComponent(`${TAG} rollup pool`)}&limit=5&withPoolSummary=false`
    );
    expect(explicitlyOff.body.bounties.find((b: { id: string }) => b.id === bountyId).poolSummary).toBeNull();
  });

  it("rejects out-of-range paging rather than issuing an unbounded query", async () => {
    for (const query of ["limit=0", "limit=101", "limit=-1", "limit=abc", "offset=-1", "offset=999999"]) {
      const res = await get(`/v1/community/catalog?${query}`);
      expect(res.status, `${query} should be a 400`).toBe(400);
    }
  });
});

describe("lifecycle phase vocabulary", () => {
  it("uses one vocabulary across both public listings and 400s on an unknown phase", async () => {
    const catalogOpen = await get("/v1/community/catalog?phase=open&limit=1");
    const bountiesOpen = await get("/v1/bounties?phase=open&limit=1");
    const bountiesProduction = await get("/v1/bounties?phase=production&limit=1");

    expect(catalogOpen.status).toBe(200);
    // `open` and `production` are synonyms; neither may be a silent empty set.
    expect(bountiesOpen.body.total).toBe(bountiesProduction.body.total);
    expect(bountiesOpen.body.total).toBe(catalogOpen.body.total);

    for (const url of ["/v1/community/catalog?phase=bogus", "/v1/bounties?phase=bogus"]) {
      expect((await get(url)).status, `${url} should be a 400`).toBe(400);
    }
  });

  it("keeps delivered pools out of the open phase and vice versa", async () => {
    const requesterUserId = await seedUser();
    const datasetTypeId = await seedDatasetType();
    const deliveredId = await seedBounty({
      requesterUserId,
      datasetTypeId,
      title: `${TAG} delivered pool`,
      status: BountyStatus.completed,
    });

    const open = await get(`/v1/community/catalog?phase=open&q=${encodeURIComponent(TAG)}&limit=50`);
    const delivered = await get(`/v1/community/catalog?phase=delivered&q=${encodeURIComponent(TAG)}&limit=50`);
    expect(open.body.bounties.map((b: { id: string }) => b.id)).not.toContain(deliveredId);
    expect(delivered.body.bounties.map((b: { id: string }) => b.id)).toContain(deliveredId);
  });
});

describe("GET /v1/bounties — query validation", () => {
  it("400s on malformed paging instead of crashing or reading from the wrong end", async () => {
    for (const query of ["limit=abc", "limit=-1", "limit=0", "offset=-1", "offset=abc"]) {
      const res = await get(`/v1/bounties?${query}`);
      expect(res.status, `${query} should be a 400`).toBe(400);
    }
  });

  it("still serves `items` for existing callers alongside `bounties`", async () => {
    const res = await get("/v1/bounties?limit=3");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual(res.body.bounties);
  });
});

describe("GET /v1/community/validation-queue", () => {
  it("reports totals across every open pool, not just the returned page", async () => {
    const requesterUserId = await seedUser();
    const contributorUserId = await seedUser();
    const datasetTypeId = await seedDatasetType();

    const before = await get("/v1/community/validation-queue?limit=1");

    // Two pools with audit work; only one can fit in a limit=1 page, but both
    // must be counted in the totals — deriving the backlog from the page is
    // exactly the bug this endpoint exists to prevent.
    const deep = await seedBounty({ requesterUserId, datasetTypeId, title: `${TAG} deep queue` });
    const shallow = await seedBounty({ requesterUserId, datasetTypeId, title: `${TAG} shallow queue` });
    await seedSubmission(deep, contributorUserId, SubmissionStatus.in_audit);
    await seedSubmission(deep, contributorUserId, SubmissionStatus.in_audit);
    await seedSubmission(shallow, contributorUserId, SubmissionStatus.in_audit);

    const after = await get("/v1/community/validation-queue?limit=1");
    expect(after.body.bounties).toHaveLength(1);
    expect(after.body.totals.pools).toBe(before.body.totals.pools + 2);
    expect(after.body.totals.items).toBe(before.body.totals.items + 3);
  });

  it("orders pools deepest queue first and excludes pools with no audit work", async () => {
    const requesterUserId = await seedUser();
    const contributorUserId = await seedUser();
    const datasetTypeId = await seedDatasetType();

    const deep = await seedBounty({ requesterUserId, datasetTypeId, title: `${TAG} order deep` });
    const shallow = await seedBounty({ requesterUserId, datasetTypeId, title: `${TAG} order shallow` });
    const idle = await seedBounty({ requesterUserId, datasetTypeId, title: `${TAG} order idle` });
    for (let i = 0; i < 5; i += 1) await seedSubmission(deep, contributorUserId, SubmissionStatus.in_audit);
    await seedSubmission(shallow, contributorUserId, SubmissionStatus.in_audit);
    await seedSubmission(idle, contributorUserId, SubmissionStatus.accepted);

    // Scoped with `q` to this test's own fixtures: on a shared database that
    // already carries real audit-queue rows, an unscoped `limit=50` page can
    // fill up before reaching these three pools, which isn't a defect in the
    // ordering — it's the test not isolating itself the way every other test
    // in this file does.
    const res = await get(`/v1/community/validation-queue?limit=50&q=${encodeURIComponent(`${TAG} order`)}`);
    const ids: string[] = res.body.bounties.map((b: { id: string }) => b.id);
    expect(ids).not.toContain(idle);
    expect(ids.indexOf(deep)).toBeLessThan(ids.indexOf(shallow));

    const depths = res.body.bounties.map((b: { poolSummary: { validatorReview: number } }) => b.poolSummary.validatorReview);
    expect(depths).toEqual([...depths].sort((a: number, b: number) => b - a));
  });
});

describe("poolSummary shape parity", () => {
  it("serves the SAME version-1 shape from the catalog and the pool contract", async () => {
    const requesterUserId = await seedUser();
    const contributorUserId = await seedUser();
    const datasetTypeId = await seedDatasetType();
    const bountyId = await seedBounty({ requesterUserId, datasetTypeId, title: `${TAG} parity pool` });
    // One submission in a bucket the catalog added and the contract lacked.
    await seedSubmission(bountyId, contributorUserId, SubmissionStatus.accepted);
    await seedSubmission(bountyId, contributorUserId, SubmissionStatus.in_audit);

    const catalog = await get(`/v1/community/catalog?q=${encodeURIComponent(`${TAG} parity pool`)}&limit=5&withPoolSummary=true`);
    const fromGrid = catalog.body.bounties.find((b: { id: string }) => b.id === bountyId).poolSummary;
    const contract = await getAsContributor(`/v1/bounties/${bountyId}/contract`);
    const fromContract = contract.body.bounty.poolSummary;

    // `policy` is contract-only (it describes the pool, not its counts).
    const gridKeys = Object.keys(fromGrid).sort();
    const contractKeys = Object.keys(fromContract).filter((k) => k !== "policy").sort();
    expect(gridKeys).toEqual(contractKeys);
    for (const key of gridKeys) expect(fromContract[key], `${key} must agree`).toEqual(fromGrid[key]);

    // Two shapes under one version number is undetectable by a client, so the
    // real guard is that the buckets account for every submission.
    const buckets = gridKeys.filter(
      (k) => !["version", "targetItems", "totalSubmitted", "finalAccepted", "capacityReserved", "remainingToTarget"].includes(k)
    );
    const summed = buckets.reduce((sum, k) => sum + (fromGrid[k] as number), 0);
    expect(summed).toBe(fromGrid.totalSubmitted);
  });
});

describe("delivered timestamp", () => {
  it("reports a real publication push, never a last-touched timestamp", async () => {
    const requesterUserId = await seedUser();
    const datasetTypeId = await seedDatasetType();
    const bountyId = await seedBounty({
      requesterUserId, datasetTypeId, title: `${TAG} publish pool`, status: BountyStatus.completed,
    });

    // Nothing published yet: null, so a client omits the row rather than
    // labelling an unrelated timestamp "delivered".
    const before = await get(`/v1/community/catalog?phase=delivered&q=${encodeURIComponent(`${TAG} publish pool`)}&limit=5`);
    expect(before.body.bounties[0].deliveredAt).toBeNull();

    const pushedAt = new Date("2026-01-02T03:04:05.000Z");
    await prisma.datasetPublication.create({
      data: { bountyId, target: "huggingface", status: "published", pushedAt },
    });
    // A later failed retry must not move the reported date.
    await prisma.bounty.update({ where: { id: bountyId }, data: { description: `touched ${TAG}` } });

    const after = await get(`/v1/community/catalog?phase=delivered&q=${encodeURIComponent(`${TAG} publish pool`)}&limit=5`);
    expect(after.body.bounties[0].deliveredAt).toBe(pushedAt.toISOString());
  });
});

describe("public dataset-type field allowlist", () => {
  it("never serves authorUserId, reviewNote, sponsorHarnessNote or proofJobId on a public route", async () => {
    const forbidden = ["authorUserId", "reviewNote", "sponsorHarnessNote", "proofJobId"];

    const catalog = await get("/v1/community/catalog?limit=5");
    const catalogBody = JSON.stringify(catalog.body);
    for (const field of forbidden) expect(catalogBody, `catalog leaked ${field}`).not.toContain(field);

    const planner = await get("/v1/planner/catalog");
    const plannerBody = JSON.stringify(planner.body);
    for (const field of forbidden) expect(plannerBody, `planner catalog leaked ${field}`).not.toContain(field);

    const requesterUserId = await seedUser();
    const datasetTypeId = await seedDatasetType();
    const bountyId = await seedBounty({ requesterUserId, datasetTypeId, title: `${TAG} allowlist pool` });
    const detail = await get(`/v1/bounties/${bountyId}`);
    const detailBody = JSON.stringify(detail.body);
    for (const field of forbidden) expect(detailBody, `bounty detail leaked ${field}`).not.toContain(field);

    const catalogDetail = await get(`/v1/community/catalog/${datasetTypeId}`);
    const catalogDetailBody = JSON.stringify(catalogDetail.body);
    for (const field of forbidden) expect(catalogDetailBody, `catalog dataset-type detail leaked ${field}`).not.toContain(field);
  });
});

describe("stale cursor", () => {
  it("400s a cursor that no longer addresses a row, instead of an empty 200", async () => {
    const res = await get("/v1/community/catalog?cursor=this-id-does-not-exist&limit=5");
    expect(res.status).toBe(400);
  });

  it("still pages correctly on a valid cursor", async () => {
    const first = await get("/v1/community/catalog?limit=3");
    const cursor = first.body.nextCursor as string;
    expect(cursor).toBeTruthy();
    const second = await get(`/v1/community/catalog?cursor=${cursor}&limit=3`);
    expect(second.status).toBe(200);
    const firstIds = first.body.bounties.map((b: { id: string }) => b.id);
    const secondIds = second.body.bounties.map((b: { id: string }) => b.id);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(firstIds.length + secondIds.length);
  });

  it("400s a cursor that pointed at a row a stricter filter now excludes", async () => {
    const requesterUserId = await seedUser();
    const datasetTypeId = await seedDatasetType();
    const bountyId = await seedBounty({ requesterUserId, datasetTypeId, title: `${TAG} filtered-out cursor`, language: "Elixir" });
    // The cursor row is real, but it doesn't match this language filter.
    const res = await get(`/v1/community/catalog?cursor=${bountyId}&language=NotElixir&limit=5`);
    expect(res.status).toBe(400);
  });
});
