// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for an explicitness gap found in a read-only
 * architecture audit: several admin-dashboard aggregate queries in
 * routes/v1/admin.ts (the GET /v1/admin/overview handler, plus the per-user
 * roster aggregates further down the same file) called
 * `prisma.bounty.count()` / `prisma.submission.count()` / `.groupBy()` /
 * `.findMany()` with NO `kind` filter at all. That was correct today only
 * because `BountyKind` has exactly one member (`community`) — funded/paid
 * work lives entirely in a separate sibling service (`enterprise`), bridged
 * only by a signed cross-service identity protocol, and is never a second
 * row in this table. Roughly 20 other call sites in this codebase (see
 * services/bounties.ts, routes/v1/admin-community.ts, routes/v1/batches.ts)
 * already state `kind: BountyKind.community` explicitly rather than relying
 * on "there's nothing else to count." The fix makes admin.ts (and a handful
 * of sibling admin-*.ts files with the exact same gap) match that standard.
 *
 * IMPORTANT HONEST LIMITATION — read before trusting these tests as full
 * regression coverage:
 *
 * `BountyKind` genuinely has one value by design in this rebuild (this file
 * must NOT add a second one — that would be inventing a hypothetical
 * funded-kind row the project explicitly does not want). That means NO
 * numeric assertion in this test suite can, by itself, tell the difference
 * between "the where clause says `kind: BountyKind.community`" and "the
 * where clause has no kind filter at all" — both produce the identical
 * count against real data today, because every row already has
 * kind = 'community'. `describe("numeric parity")` below proves the ORM
 * query and an independently hand-written raw-SQL query with an explicit
 * `WHERE kind = 'community'` agree on the same count; it does NOT prove the
 * `kind` filter is actually present in the Prisma call, and it never can as
 * long as there is only one kind in the enum.
 *
 * The only thing that CAN catch a future regression — someone deleting the
 * `kind: BountyKind.community` / `bounty: { kind: BountyKind.community }`
 * clause from one of these call sites again — is reading the actual source
 * text of the fixed call sites and asserting the clause is still there.
 * `describe("source-level scope guard")` does exactly that: it fails loudly
 * and points at the exact call site whose explicit scope disappeared. This
 * codebase has no Prisma-call-arg-spy/mock pattern anywhere else (checked:
 * no `vi.spyOn`/`vi.fn` on `prisma.*` in any existing test), so this is the
 * strongest honest check available without inventing a second BountyKind or
 * a mocking pattern this codebase doesn't otherwise use.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AuditMode, BountyKind, DatasetCategory, GenerationMethod, SubmissionStatus } from "@prisma/client";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";

requireDisposableDatabase();

const __dirname = dirname(fileURLToPath(import.meta.url));

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdBountyIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.submission.deleteMany({ where: { bountyId: { in: createdBountyIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function signup(emailPrefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `${emailPrefix}-${stamp}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Test@12345", handle: `${emailPrefix}${stamp}`.slice(0, 30), displayName: emailPrefix },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  createdUserIds.push(userId);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

async function signupAdmin(emailPrefix: string) {
  const account = await signup(emailPrefix);
  await prisma.user.update({ where: { id: account.userId }, data: { emailVerifiedAt: new Date() } });
  await prisma.userRole.create({ data: { userId: account.userId, role: "admin" } });
  return account;
}

async function seedBountyWithSubmissions(opts: { requesterUserId: string; contributorUserId: string; itemCount: number }) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: opts.requesterUserId,
      title: `kind-scope fixture ${stamp}`,
      description: "fixture bounty for the admin overview bounty-kind scope regression test",
      datasetCategory: DatasetCategory.debugging,
      language: "typescript",
      framework: "none",
      targetItems: BigInt(opts.itemCount),
      // Must stay BELOW targetItems: the `bounties_required_sponsor_examples_bounds`
      // CHECK (restored from V1 by migration 20260902100000) rejects the schema
      // default of 3 against this fixture's small itemCount.
      requiredSponsorExamples: 0,
      auditMode: AuditMode.partial,
      auditCoveragePct: 100,
      holdDays: 0,
      karmaPerAcceptedItem: 25,
      // Deliberately not passed: `kind` defaults to BountyKind.community in
      // the schema, same as every other bounty in this database.
    },
  });
  createdBountyIds.push(bounty.id);

  await prisma.submission.createMany({
    data: Array.from({ length: opts.itemCount }, (_, i) => ({
      bountyId: bounty.id,
      contributorUserId: opts.contributorUserId,
      title: `kind-scope fixture item ${i}`,
      payloadJson: { i },
      generationMethod: GenerationMethod.human,
      status: i === 0 ? SubmissionStatus.accepted : SubmissionStatus.submitted,
    })),
  });

  return bounty;
}

describe("GET /v1/admin/overview — bounty-kind scope numeric parity", () => {
  it("matches independently-computed raw-SQL counts scoped to kind = 'community' for the same data", async () => {
    // This proves the ORM query and a hand-written SQL query with an
    // explicit WHERE clause agree today. It does NOT prove the `kind`
    // filter is present in the Prisma call — see the file header. Real
    // fixture rows are seeded (rather than trusting whatever's already in
    // the shared dev DB) so the counts below are provably non-trivial.
    const admin = await signupAdmin("kindscopeoverviewadmin");
    const requester = await signup("kindscopeoverviewrequester");
    const contributor = await signup("kindscopeoverviewcontributor");
    await seedBountyWithSubmissions({ requesterUserId: requester.userId, contributorUserId: contributor.userId, itemCount: 3 });

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/overview",
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const [rawBountyTotal, rawSubmissionTotal, rawAcceptedTotal] = await Promise.all([
      prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*)::bigint AS count FROM bounties WHERE kind = 'community'`,
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        FROM submissions s
        JOIN bounties b ON b.id = s.bounty_id
        WHERE b.kind = 'community'`,
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        FROM submissions s
        JOIN bounties b ON b.id = s.bounty_id
        WHERE b.kind = 'community' AND s.status = 'accepted'`,
    ]);

    expect(body.totalDatasets).toBe(Number(rawBountyTotal[0]!.count));
    expect(body.totalSubmissions).toBe(Number(rawSubmissionTotal[0]!.count));
    expect(body.acceptedSubmissions).toBe(Number(rawAcceptedTotal[0]!.count));

    // Sanity check the fixture actually moved the numbers (i.e. this isn't
    // vacuously true because the DB and the fixture are both empty).
    expect(Number(rawBountyTotal[0]!.count)).toBeGreaterThan(0);
    expect(Number(rawSubmissionTotal[0]!.count)).toBeGreaterThan(0);
  });

  it("confirms every bounty in this database is kind='community' today — the reason the numeric check above cannot, by itself, catch a dropped filter", async () => {
    const distinctKinds = await prisma.$queryRaw<{ kind: string }[]>`SELECT DISTINCT kind FROM bounties`;
    expect(distinctKinds.map((r) => r.kind)).toEqual(["community"]);
  });
});

describe("source-level scope guard — catches a future accidental revert", () => {
  // Each entry: the file the fix landed in, and a regex that must still
  // match its source text. If a future change deletes the explicit
  // `kind: BountyKind.community` (or the `bounty: { kind: BountyKind.community }`
  // relation-filter form used for Submission, which has no `kind` column of
  // its own) from one of these call sites, the matching assertion below
  // fails with a message naming exactly which site regressed — a typecheck
  // or a passing numeric test would NOT catch this, because removing the
  // filter is not a type error and (per the limitation above) does not
  // change any count while BountyKind has only one member.
  const routesDir = join(__dirname, "routes", "v1");

  const expectations: Array<{ file: string; label: string; pattern: RegExp }> = [
    {
      file: "admin.ts",
      label: "/overview: total bounties count",
      pattern: /prisma\.bounty\.count\(\{ where: \{ kind: BountyKind\.community \} \}\)/,
    },
    {
      file: "admin.ts",
      label: "/overview: new bounties (7d) count",
      pattern: /prisma\.bounty\.count\(\{ where: \{ kind: BountyKind\.community, createdAt: \{ gte: cutoff7d \} \} \}\)/,
    },
    {
      file: "admin.ts",
      label: "/overview: new bounties (30d) count",
      pattern: /prisma\.bounty\.count\(\{ where: \{ kind: BountyKind\.community, createdAt: \{ gte: cutoff30d \} \} \}\)/,
    },
    {
      file: "admin.ts",
      label: "/overview: total submissions count",
      pattern: /prisma\.submission\.count\(\{ where: \{ bounty: \{ kind: BountyKind\.community \} \} \}\)/,
    },
    {
      file: "admin.ts",
      label: "/overview: accepted submissions count",
      pattern: /prisma\.submission\.count\(\{ where: \{ bounty: \{ kind: BountyKind\.community \}, status: SubmissionStatus\.accepted \} \}\)/,
    },
    {
      file: "admin.ts",
      label: "/overview: pipeline groupBy",
      pattern: /where: \{ bounty: \{ kind: BountyKind\.community \}, status: \{ in: PIPELINE_STATUSES \} \}/,
    },
    {
      file: "admin.ts",
      label: "/overview: active-contributor groupBy",
      pattern: /where: \{ bounty: \{ kind: BountyKind\.community \}, status: \{ in: ACTIVE_NON_TERMINAL_STATUSES \} \}/,
    },
    {
      file: "admin.ts",
      label: "/overview: submissions-pending-validation count",
      pattern: /prisma\.submission\.count\(\{ where: \{ bounty: \{ kind: BountyKind\.community \}, status: \{ in: ACTIVE_NON_TERMINAL_STATUSES \} \} \}\)/,
    },
    {
      file: "admin.ts",
      label: "/users: per-user sponsoredBounties groupBy",
      pattern: /where: \{ requesterUserId: \{ in: userIds \}, kind: BountyKind\.community \}/,
    },
    {
      file: "admin.ts",
      label: "/users: per-user accepted-submissions groupBy",
      pattern: /where: \{ contributorUserId: \{ in: userIds \}, bounty: \{ kind: BountyKind\.community \}, status: SubmissionStatus\.accepted \}/,
    },
    {
      file: "admin-dataset-types.ts",
      label: "/dataset-types/:id: usageCount",
      pattern: /prisma\.bounty\.count\(\{ where: \{ datasetTypeId: id, kind: BountyKind\.community \} \}\)/,
    },
    {
      file: "admin-internal.ts",
      label: "user drill-down: bounty findMany",
      pattern: /where: \{ requesterUserId: id, kind: BountyKind\.community \}/,
    },
    {
      file: "admin-internal.ts",
      label: "user drill-down: bounty count total",
      pattern: /prisma\.bounty\.count\(\{ where: \{ requesterUserId: id, kind: BountyKind\.community \} \}\)/,
    },
    {
      file: "admin-contributors.ts",
      label: "/contributors: per-status submission groupBy",
      pattern: /where: \{ contributorUserId: \{ in: userIds \}, bounty: \{ kind: BountyKind\.community \}, \.\.\.submissionDateFilter \}/,
    },
    {
      file: "admin-contributors.ts",
      label: "/contributors: rejected-duplicate groupBy",
      pattern: /contributorUserId: \{ in: userIds \},\s*bounty: \{ kind: BountyKind\.community \},\s*status: SubmissionStatus\.rejected,/,
    },
    {
      file: "admin-contributors.ts",
      label: "/contributors: in-flight groupBy",
      pattern: /contributorUserId: \{ in: userIds \},\s*bounty: \{ kind: BountyKind\.community \},\s*status: \{ in: IN_FLIGHT_SUBMISSION_STATUSES \},/,
    },
    {
      file: "admin-submissions.ts",
      label: "/submissions: list+count shared where",
      pattern: /\{ bounty: \{ kind: BountyKind\.community \} \},\s*statusWhere,/,
    },
  ];

  const fileCache = new Map<string, string>();
  function sourceOf(file: string): string {
    if (!fileCache.has(file)) fileCache.set(file, readFileSync(join(routesDir, file), "utf8"));
    return fileCache.get(file)!;
  }

  for (const { file, label, pattern } of expectations) {
    it(`${file} — ${label} — still has its explicit BountyKind.community scope`, () => {
      const source = sourceOf(file);
      expect(
        pattern.test(source),
        `Expected ${file} to still contain the explicit BountyKind.community scope for "${label}" ` +
          `(pattern: ${pattern}). If this fails, someone removed the explicit \`kind\` filter this ` +
          `regression test protects — the query would still run and return the same numbers today ` +
          `(BountyKind has only one member), so nothing else would catch this.`,
      ).toBe(true);
    });
  }

  it("admin-internal.ts: submission-by-status groupBy AND distinct-bounty findMany both keep their explicit scope (identical where-clause text, checked by count)", () => {
    const source = sourceOf("admin-internal.ts");
    const matches = source.match(/where: \{ contributorUserId: id, bounty: \{ kind: BountyKind\.community \} \}/g) ?? [];
    expect(
      matches.length,
      "expected both the submission-by-status groupBy and the distinct-bounty findMany to carry the filter",
    ).toBe(2);
  });

  it("admin.ts: /users per-user submissions groupBy AND distinct-datasets findMany both keep their explicit scope (identical where-clause text, checked by count so a regression in either one is caught)", () => {
    // These two call sites (the plain per-user submissions groupBy and the
    // distinct-bounty findMany feeding `distinctDatasetsContributed`) happen
    // to share byte-identical where-clause text after the fix, so a single
    // existence check could pass even if one of the two lost its filter
    // while the other kept it. Counting occurrences instead means both must
    // still carry the clause.
    const source = sourceOf("admin.ts");
    const matches = source.match(/where: \{ contributorUserId: \{ in: userIds \}, bounty: \{ kind: BountyKind\.community \} \}/g) ?? [];
    expect(matches.length, "expected both the per-user submissions groupBy and the distinct-datasets findMany to carry the filter").toBe(
      2,
    );
  });

  it("every fixed file still imports BountyKind from @prisma/client", () => {
    for (const file of ["admin.ts", "admin-dataset-types.ts", "admin-internal.ts", "admin-contributors.ts", "admin-submissions.ts"]) {
      const source = sourceOf(file);
      expect(/import\s*\{[^}]*\bBountyKind\b[^}]*\}\s*from\s*"@prisma\/client"/.test(source), `${file} should import BountyKind`).toBe(
        true,
      );
    }
  });
});
