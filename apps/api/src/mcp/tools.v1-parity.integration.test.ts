// SPDX-License-Identifier: Apache-2.0

/**
 * v1 MCP parity regressions.
 *
 * One `describe` per fixed parity gap, each asserting the CONTRACT an agent
 * written against v1 depends on — not the implementation that happens to
 * satisfy it today. Tools are called directly (the transport, scope gate and
 * audit trail are covered by `transport.integration.test.ts` and
 * `routes/mcp-scope-matrix.integration.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  AgentIssueCategory,
  AgentIssueImpact,
  ArtifactKind,
  ArtifactStatus,
  ArtifactVisibility,
  AuditMode,
  AuthMethod,
  BountyKind,
  BountyStatus,
  DatasetCategory,
  DatasetTypeStatus,
  GenerationMethod,
  KarmaEventType,
  SubmissionStatus,
  SponsorExampleReviewStatus,
} from "@prisma/client";
import { buildApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { tools } from "./tools.js";
import { assertToolAllowed } from "./tool-gate.js";
import { McpToolError } from "./core/errors.js";
import { SUBMISSION_ITEMS_HARD_MAX, MCP_BULK_THRESHOLD_ITEMS } from "./core/limits.js";
import { getAttributionPreference } from "../services/reputation.js";
import { getPoolSubmitLimits } from "../services/submission-limits.js";
import { setAdminSetting } from "../services/admin-settings.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

const tool = (name: string) => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no such MCP tool: ${name}`);
  return found;
};

let app: FastifyInstance;
let userId: string;
const createdUserIds: string[] = [];
const createdArtifactIds: string[] = [];
const createdBountyIds: string[] = [];

async function createVerifiedUser(prefix: string) {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: {
      email: `${prefix}-${stamp}@example.com`,
      handle: `${prefix.slice(0, 6)}${stamp}`.toLowerCase().slice(0, 20),
      displayName: prefix,
      authMethod: AuthMethod.email,
      passwordHash: "not-used-in-these-tests",
      emailVerifiedAt: new Date(),
      onboarded: true,
    },
  });
  createdUserIds.push(user.id);
  return user.id;
}

// Used by describe 32 (delete_file's verified-email gate). Deliberately no
// `emailVerifiedAt` so `assertVerifiedEmail` (mcp/tool-gate.ts) reads a real
// unverified row rather than a mocked one.
async function createUnverifiedUser(prefix: string) {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: {
      email: `${prefix}-${stamp}@example.com`,
      handle: `${prefix.slice(0, 6)}${stamp}`.toLowerCase().slice(0, 20),
      displayName: prefix,
      authMethod: AuthMethod.email,
      passwordHash: "not-used-in-these-tests",
      onboarded: true,
    },
  });
  createdUserIds.push(user.id);
  return user.id;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  userId = await createVerifiedUser("parity");
});

afterAll(async () => {
  await app.close();
  await prisma.karmaEvent.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.agentIssue.deleteMany({ where: { reporterUserId: { in: createdUserIds } } });
  await prisma.artifact.deleteMany({ where: { id: { in: createdArtifactIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

// ── 12. prepare_large_file_upload no longer hard-codes bulk_submission_source
describe("12 · upload tools withhold bulk_submission_source and accept every target", () => {
  it("prepare_large_file_upload refuses the kind v1 deliberately withholds from MCP", () => {
    const parsed = tool("prepare_large_file_upload").schema.safeParse({
      kind: ArtifactKind.bulk_submission_source,
      filename: "corpus.jsonl",
      contentType: "application/jsonl",
      totalSizeBytes: 10,
      parts: [{ partNumber: 1, sizeBytes: 10, checksumSha256Hex: "a".repeat(64) }],
    });
    expect(parsed.success, "bulk_submission_source must not be reachable over MCP").toBe(false);
  });

  it("prepare_file_upload refuses it too, and both default to submission_attachment", () => {
    expect(
      tool("prepare_file_upload").schema.safeParse({
        kind: ArtifactKind.bulk_submission_source,
        filename: "corpus.jsonl",
        contentType: "application/jsonl",
      }).success,
    ).toBe(false);
    // Server-authored kinds were reachable through the old nativeEnum too.
    expect(
      tool("prepare_file_upload").schema.safeParse({
        kind: ArtifactKind.export_bundle,
        filename: "x.zip",
        contentType: "application/zip",
      }).success,
    ).toBe(false);
    for (const name of ["prepare_file_upload", "prepare_large_file_upload"]) {
      const base =
        name === "prepare_file_upload"
          ? { filename: "a.json", contentType: "application/json" }
          : {
              filename: "a.json",
              contentType: "application/json",
              totalSizeBytes: 10,
              parts: [{ partNumber: 1, sizeBytes: 10, checksumSha256Hex: "a".repeat(64) }],
            };
      const parsed = tool(name).schema.safeParse(base) as { success: true; data: { kind: string } };
      expect(parsed.success).toBe(true);
      expect(parsed.data.kind).toBe(ArtifactKind.submission_attachment);
    }
  });

  it("both upload tools accept the submissionId / contributorBatchId targets v1 accepts", () => {
    for (const name of ["prepare_file_upload", "prepare_large_file_upload"]) {
      const shape = (tool(name).schema as unknown as { shape: Record<string, unknown> }).shape;
      expect(Object.keys(shape), `${name} dropped a v1 target parameter`).toEqual(
        expect.arrayContaining(["bountyId", "submissionId", "contributorBatchId"]),
      );
    }
  });
});

// ── 16. richer get_file_status / get_file_processing_checks
describe("16 · file status reports ingest, scan progress and per-stage checks", () => {
  let artifactId: string;

  beforeAll(async () => {
    const artifact = await prisma.artifact.create({
      data: {
        kind: ArtifactKind.bulk_submission_source,
        ownerUserId: userId,
        filename: "parity-source.jsonl",
        contentType: "application/jsonl",
        storageKey: `test/parity/${Date.now()}`,
        bulkParseStatus: "done",
        bulkParseRowCount: 10,
        bulkParseCreated: 7,
        bulkParseSkippedRows: 3,
      },
    });
    artifactId = artifact.id;
    createdArtifactIds.push(artifactId);
  });

  it("returns a bulk-source ingest block with row / created / skipped, so a PARTIAL ingest is visible", async () => {
    const res = (await tool("get_file_status").call({ fileId: artifactId }, { userId })) as {
      ingest: { status: string; rowCount: number; created: number; skipped: number; recheckAfterSeconds: number | null; basis: string } | null;
      scanProgress: unknown;
      fileId: string;
    };
    expect(res.fileId).toBe(artifactId);
    expect(res.ingest).not.toBeNull();
    expect(res.ingest!.status).toBe("done");
    expect(res.ingest!.rowCount).toBe(10);
    expect(res.ingest!.created).toBe(7);
    // The whole point: `done` with skipped > 0 is NOT a clean upload.
    expect(res.ingest!.skipped).toBe(3);
    // Settled work must not hand back a polling hint.
    expect(res.ingest!.recheckAfterSeconds).toBeNull();
    expect(res.ingest!.basis).toBe("settled");
    expect("scanProgress" in res).toBe(true);
  });

  it("reports a stage that never ran as `missing`, never as passed", async () => {
    const res = (await tool("get_file_processing_checks").call({ fileId: artifactId }, { userId })) as {
      stages: { stage: string; status: string }[];
    };
    expect(res.stages.map((s) => s.stage)).toEqual(["parse", "preview", "similarity_check"]);
    for (const stage of res.stages) {
      expect(stage.status, `${stage.stage} must not read as passed with no recorded event`).not.toBe("passed");
      expect(["missing", "pending"]).toContain(stage.status);
    }
  });

  it("reports a recorded pass from a superseded handler as `stale`, not as a pass", async () => {
    await prisma.artifactProcessingEvent.create({
      data: {
        artifactId,
        stage: "parse",
        status: "passed",
        handlerVersion: "definitely-not-the-current-version",
        detail: {},
      },
    });
    const res = (await tool("get_file_processing_checks").call({ artifactId }, { userId })) as {
      stages: { stage: string; status: string; handlerVersion: string | null; currentHandlerVersion: string }[];
    };
    const parse = res.stages.find((s) => s.stage === "parse")!;
    expect(parse.status).toBe("stale");
    expect(parse.handlerVersion).toBe("definitely-not-the-current-version");
    expect(parse.currentHandlerVersion).not.toBe(parse.handlerVersion);
  });

  it("still refuses an artifact the caller does not own", async () => {
    const stranger = await createVerifiedUser("strangr");
    await expect(tool("get_file_status").call({ fileId: artifactId }, { userId: stranger })).rejects.toBeInstanceOf(
      McpToolError,
    );
  });
});

// ── 17. list_dataset_categories is DB-backed
describe("17 · list_dataset_categories serves the live catalog, not the compiled enum", () => {
  it("returns only categories that have an ACTIVE dataset type in the database", async () => {
    const res = (await tool("list_dataset_categories").call({}, {})) as {
      categories: { id: string; label: string; datasetTypes: { id: string }[] }[];
    };
    const live = await prisma.datasetType.findMany({
      where: { status: DatasetTypeStatus.active },
      select: { category: true },
      distinct: ["category"],
    });
    expect(new Set(res.categories.map((c) => c.id))).toEqual(new Set(live.map((t) => String(t.category))));
    // Every returned category carries its active types, so a category can
    // never be advertised with nothing behind it.
    for (const category of res.categories) expect(category.datasetTypes.length).toBeGreaterThan(0);
  });
});

// ── 18. submit_pool_items is bounded
describe("18 · submit_pool_items bounds its items array", () => {
  // Pass-3 fix (2026-09-08): a 1-character title used to be valid here, but
  // the item schema now bounds `title` to `.trim().min(3).max(120)` (matching
  // routes/v1/submissions.ts) — see describe 34 below. Kept at 3 characters
  // (the floor) so this describe still proves what it is actually testing
  // (the ARRAY length bound), not a title-length rejection.
  const item = { title: "itm", payloadJson: { a: 1 } };

  it("rejects an oversized array at the schema boundary instead of timing out mid-transaction", () => {
    const parsed = tool("submit_pool_items").schema.safeParse({
      bountyId: "x",
      items: Array.from({ length: SUBMISSION_ITEMS_HARD_MAX + 1 }, () => item),
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty array and accepts one at the limit", () => {
    expect(tool("submit_pool_items").schema.safeParse({ bountyId: "x", items: [] }).success).toBe(false);
    expect(
      tool("submit_pool_items").schema.safeParse({
        bountyId: "x",
        items: Array.from({ length: SUBMISSION_ITEMS_HARD_MAX }, () => item),
      }).success,
    ).toBe(true);
  });
});

describe("18a · community pool inline limits are live admin settings", () => {
  it("uses the lower live bulk threshold as the pool submit ceiling", async () => {
    try {
      await setAdminSetting({ key: "submissions.max_items_per_request", value: 70, updatedByUserId: userId });
      await setAdminSetting({ key: "submissions.mcp_bulk_threshold_items", value: 12, updatedByUserId: userId });
      await expect(getPoolSubmitLimits()).resolves.toEqual({ maxItemsPerRequest: 12, bulkThresholdItems: 12 });
    } finally {
      await prisma.adminSetting.deleteMany({
        where: { key: { in: ["submissions.max_items_per_request", "submissions.mcp_bulk_threshold_items"] } },
      });
    }
  });
});

// ── 19. set_attribution_preference is no longer inverted
describe("19 · attribution preference uses v1's optOut, and writes the attribution field", () => {
  it("takes optOut, not profilePublic", () => {
    expect(tool("set_attribution_preference").schema.safeParse({ profilePublic: false }).success).toBe(false);
    expect(tool("set_attribution_preference").schema.safeParse({ optOut: true }).success).toBe(true);
  });

  it("optOut=true removes dataset credit and leaves profile visibility untouched", async () => {
    const subject = await createVerifiedUser("attrib");
    await prisma.user.update({ where: { id: subject }, data: { profilePublic: true } });

    const set = (await tool("set_attribution_preference").call({ optOut: true }, { userId: subject })) as {
      optOut: boolean;
    };
    expect(set.optOut).toBe(true);
    expect((await getAttributionPreference(subject)).attributionOptOut).toBe(true);
    // The bug this replaces: it used to write User.profilePublic.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: subject }, select: { profilePublic: true } });
    expect(after.profilePublic, "attribution opt-out must not hide the whole profile").toBe(true);

    const read = (await tool("get_attribution_preference").call({}, { userId: subject })) as { optOut: boolean };
    expect(read.optOut).toBe(true);

    // ...and it round-trips back.
    await tool("set_attribution_preference").call({ optOut: false }, { userId: subject });
    expect((await getAttributionPreference(subject)).attributionOptOut).toBe(false);
  });
});

// ── 20. v1 parameter names still work
describe("20 · v1 parameter names are accepted (fileId; auditId as a documented alias)", () => {
  const FILE_TOOLS = [
    "complete_file_upload",
    "complete_large_file_upload",
    "abort_large_file_upload",
    "get_file_status",
    "get_file_processing_checks",
    "delete_file",
  ];

  it("every id-taking file tool advertises v1's `fileId` and keeps `artifactId` as an alias", () => {
    for (const name of FILE_TOOLS) {
      const shape = (tool(name).schema as unknown as { shape: Record<string, unknown> }).shape;
      expect(Object.keys(shape), `${name} lost v1's fileId parameter`).toEqual(
        expect.arrayContaining(["fileId", "artifactId"]),
      );
    }
  });

  it("prepare_* return `fileId` so the round trip names the id the same way", async () => {
    const res = (await tool("prepare_file_upload").call(
      { filename: "parity.json", contentType: "application/json", kind: ArtifactKind.submission_attachment },
      { userId },
    )) as { artifactId: string; fileId: string };
    createdArtifactIds.push(res.artifactId);
    expect(res.fileId).toBe(res.artifactId);
  });

  it("a file tool called with NEITHER id says so, naming fileId", async () => {
    await expect(tool("get_file_status").call({}, { userId })).rejects.toThrow(/fileId is required/);
  });

  it("audit tools accept `auditId` as an alias of the canonically-named windowId", async () => {
    for (const name of ["get_audit", "claim_audit"]) {
      const shape = (tool(name).schema as unknown as { shape: Record<string, unknown> }).shape;
      expect(Object.keys(shape)).toEqual(expect.arrayContaining(["windowId", "auditId"]));
      // Both routes reach the same lookup: a nonexistent id is "not found",
      // never a schema error about an unknown parameter.
      await expect(tool(name).call({ auditId: "parity-no-such-window" }, { userId })).rejects.toThrow(/not found/i);
    }
  });

  it("a validate tool called with neither id says so, naming windowId", async () => {
    await expect(tool("get_audit").call({}, { userId })).rejects.toThrow(/windowId is required/);
  });
});

// ── 21. pagination and filtering restored
describe("21 · restored pagination and filtering", () => {
  let karmaUser: string;

  beforeAll(async () => {
    karmaUser = await createVerifiedUser("pager");
    for (let i = 0; i < 5; i += 1) {
      await prisma.karmaEvent.create({
        data: {
          userId: karmaUser,
          eventType: i % 2 === 0 ? KarmaEventType.community_item_accepted : KarmaEventType.admin_adjustment,
          amount: 10 + i,
          sourceType: "test",
          sourceId: `parity-karma-${i}-${Date.now()}`,
          createdAt: new Date(Date.now() - i * 60_000),
        },
      });
      await prisma.notification.create({
        data: {
          userId: karmaUser,
          type: "parity.probe",
          title: `probe ${i}`,
          body: "paging probe",
          eventKey: `parity-note-${i}-${Date.now()}-${Math.random()}`,
        },
      });
      await prisma.agentIssue.create({
        data: {
          reporterUserId: karmaUser,
          reporterLabel: "parity",
          source: "test",
          category: AgentIssueCategory.mcp,
          impact: AgentIssueImpact.degraded,
          summary: i % 2 === 0 ? `even parity probe ${i}` : `odd parity probe ${i}`,
          expected: "paged",
          actual: "paged",
          fingerprint: `parity-fp-${i}-${Date.now()}`,
          idempotencyKey: `parity-idem-${i}-${Date.now()}-${Math.random()}`,
        },
      });
    }
  });

  it("get_karma_details pages by a stable cursor and filters by eventType", async () => {
    const first = (await tool("get_karma_details").call({ limit: 2 }, { userId: karmaUser })) as {
      events: { id: string }[];
      eventCount: number;
      hasMore: boolean;
      nextCursor: string | null;
      totalKarma: number;
    };
    expect(first.events).toHaveLength(2);
    expect(first.eventCount).toBe(5);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    // The breakdown v1 also returns is still there — this is one tool, not two.
    expect(first).toHaveProperty("totalKarma");

    const second = (await tool("get_karma_details").call(
      { limit: 2, cursor: first.nextCursor! },
      { userId: karmaUser },
    )) as { events: { id: string }[]; hasMore: boolean };
    expect(second.events).toHaveLength(2);
    // No overlap: a cursor is a keyset, not an offset.
    const firstIds = new Set(first.events.map((e) => e.id));
    for (const ev of second.events) expect(firstIds.has(ev.id)).toBe(false);

    const filtered = (await tool("get_karma_details").call(
      { eventType: KarmaEventType.admin_adjustment },
      { userId: karmaUser },
    )) as { events: { eventType: string }[]; eventCount: number };
    expect(filtered.eventCount).toBe(2);
    for (const ev of filtered.events) expect(ev.eventType).toBe(KarmaEventType.admin_adjustment);
  });

  it("get_karma_details rejects a malformed cursor rather than returning an empty page", async () => {
    await expect(
      tool("get_karma_details").call({ cursor: "not-a-cursor" }, { userId: karmaUser }),
    ).rejects.toThrow(/cursor/i);
  });

  it("list_my_issues filters and pages instead of returning the whole history", async () => {
    const page = (await tool("list_my_issues").call({ limit: 2 }, { userId: karmaUser })) as {
      items: { id: string }[];
      hasMore: boolean;
      nextCursor: string | null;
      issueCount: number;
    };
    expect(page.items).toHaveLength(2);
    expect(page.issueCount).toBe(5);
    expect(page.hasMore).toBe(true);

    const next = (await tool("list_my_issues").call(
      { limit: 2, cursor: page.nextCursor! },
      { userId: karmaUser },
    )) as { items: { id: string }[] };
    const seen = new Set(page.items.map((i) => i.id));
    for (const row of next.items) expect(seen.has(row.id)).toBe(false);

    const searched = (await tool("list_my_issues").call({ q: "even parity" }, { userId: karmaUser })) as {
      issueCount: number;
    };
    expect(searched.issueCount).toBe(3);
  });

  it("list_notifications pages by a stable cursor", async () => {
    const first = (await tool("list_notifications").call({ limit: 2 }, { userId: karmaUser })) as {
      items: { id: string }[];
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    // A notification arriving mid-walk must not make the next page re-serve a
    // row already read — the exact failure `offset` has.
    await prisma.notification.create({
      data: {
        userId: karmaUser,
        type: "parity.probe",
        title: "arrived mid-walk",
        body: "shifts an offset walk",
        eventKey: `parity-mid-${Date.now()}-${Math.random()}`,
      },
    });
    const second = (await tool("list_notifications").call(
      { limit: 2, cursor: first.nextCursor! },
      { userId: karmaUser },
    )) as { items: { id: string }[] };
    const seen = new Set(first.items.map((n) => n.id));
    for (const row of second.items) expect(seen.has(row.id)).toBe(false);
  });

  it("list_community_pools filters by domain again, and pages by cursor", async () => {
    const datasetType = await prisma.datasetType.findFirst({ where: { status: DatasetTypeStatus.active } });
    if (!datasetType) {
      // Honest skip rather than a green assertion over an empty catalog.
      expect(tool("list_community_pools").schema.safeParse({ domain: "coding" }).success).toBe(true);
      return;
    }
    const pool = await prisma.bounty.create({
      data: {
        kind: BountyKind.community,
        status: BountyStatus.active,
        title: `parity pool ${Date.now()}`,
        description: "domain filter probe",
        datasetTypeId: datasetType.id,
        datasetCategory: datasetType.category,
        targetItems: 10,
        karmaPerAcceptedItem: 1,
        language: "TypeScript",
        framework: "none",
        requesterUserId: userId,
        auditMode: "partial",
        auditCoveragePct: 10,
        holdDays: 0,
      },
    });
    createdBountyIds.push(pool.id);

    const matching = (await tool("list_community_pools").call({ domain: datasetType.domain }, {})) as {
      bounties: { id: string }[];
    };
    expect(matching.bounties.map((b) => b.id)).toContain(pool.id);

    const otherDomain = ["coding", "legal", "healthcare", "finance", "science"].find(
      (d) => d !== String(datasetType.domain),
    )!;
    const excluded = (await tool("list_community_pools").call({ domain: otherDomain }, {})) as {
      bounties: { id: string }[];
    };
    expect(excluded.bounties.map((b) => b.id)).not.toContain(pool.id);

    const paged = (await tool("list_community_pools").call({ limit: 1 }, {})) as {
      bounties: { id: string }[];
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(paged.bounties).toHaveLength(1);
    if (paged.hasMore) {
      const next = (await tool("list_community_pools").call({ limit: 1, cursor: paged.nextCursor! }, {})) as {
        bounties: { id: string }[];
      };
      expect(next.bounties[0]?.id).not.toBe(paged.bounties[0]?.id);
    }
  });

  it("get_pool_contract is contributor-scoped and returns the real approved work brief", async () => {
    const datasetType = await prisma.datasetType.findFirst({ where: { status: DatasetTypeStatus.active } });
    if (!datasetType) throw new Error("MCP contract fixture needs one active dataset type");
    const pool = await prisma.bounty.create({
      data: {
        kind: BountyKind.community,
        status: BountyStatus.active,
        title: `MCP work-brief pool ${Date.now()}`,
        description: "MCP work-brief fixture",
        datasetTypeId: datasetType.id,
        datasetCategory: datasetType.category,
        targetItems: 10,
        karmaPerAcceptedItem: 1,
        language: "TypeScript",
        framework: "none",
        requesterUserId: userId,
        auditMode: "partial",
        auditCoveragePct: 10,
        holdDays: 0,
      },
    });
    createdBountyIds.push(pool.id);
    const visible = await prisma.artifact.create({
      data: {
        bountyId: pool.id,
        ownerUserId: userId,
        kind: ArtifactKind.sponsor_reference,
        visibility: ArtifactVisibility.work_brief,
        status: ArtifactStatus.ready,
        sponsorReviewStatus: SponsorExampleReviewStatus.approved,
        filename: "mcp-sponsor-brief.json",
        contentType: "application/json",
        storageKey: `artifacts/sponsor_reference/mcp/${pool.id}/brief.json`,
      },
    });
    createdArtifactIds.push(visible.id);
    const hidden = await prisma.artifact.create({
      data: {
        bountyId: pool.id,
        ownerUserId: userId,
        kind: ArtifactKind.sponsor_reference,
        visibility: ArtifactVisibility.private,
        status: ArtifactStatus.ready,
        sponsorReviewStatus: SponsorExampleReviewStatus.approved,
        filename: "mcp-private-note.json",
        contentType: "application/json",
        storageKey: `artifacts/sponsor_reference/mcp/${pool.id}/private.json`,
      },
    });
    createdArtifactIds.push(hidden.id);

    const contractTool = tool("get_pool_contract");
    expect(contractTool.scope).toBe("contribute");
    const contract = (await contractTool.call({ bountyId: pool.id }, { userId })) as {
      sponsorReferences?: Array<{ id: string; filename: string; downloadUrl: string }>;
      llmValidationEnabled?: unknown;
      llmProviderConfigured?: unknown;
    };
    expect(contract.sponsorReferences).toEqual([
      expect.objectContaining({
        id: visible.id,
        filename: "mcp-sponsor-brief.json",
        downloadUrl: `/v1/artifacts/${visible.id}/content`,
      }),
    ]);
    expect(contract.sponsorReferences?.map((artifact) => artifact.id)).not.toContain(hidden.id);
    expect(contract).not.toHaveProperty("llmValidationEnabled");
    expect(contract).not.toHaveProperty("llmProviderConfigured");
    expect(contractTool.description).not.toContain("llmValidationEnabled");
    expect(tool("check_submission").description).not.toContain("llmValidationEnabled");
  });
});

// ── 22. report_issue context ids
describe("22 · report_issue accepts the v1 context ids and never invents a resource", () => {
  it("stores a confirmed resource and keeps an unconfirmable id as an explicit claim", async () => {
    const reporter = await createVerifiedUser("issuer");
    const datasetType = await prisma.datasetType.findFirst({ select: { id: true } });

    const res = (await tool("report_issue").call(
      {
        category: AgentIssueCategory.contract,
        impact: AgentIssueImpact.degraded,
        summary: "parity context probe",
        expected: "context ids are recorded",
        actual: "they used to be dropped",
        ...(datasetType ? { datasetTypeId: datasetType.id } : {}),
        submissionId: "parity-no-such-submission",
      },
      { userId: reporter },
    )) as { id: string; resources: { kind: string }[]; unresolvedIds: string[] };

    // The id the caller named but cannot be shown is NOT presented as a
    // resolved resource.
    expect(res.unresolvedIds).toContain("parity-no-such-submission");
    // `kind`, not `type`: resolution moved into the shared
    // `collectIssueContext` used by both this tool and POST /v1/issues, and
    // the reporter DTO / apps/web `IssueResource` have always read `kind`.
    // The old `type` key meant an MCP-filed case stored a snapshot the /issues
    // page could not render at all.
    expect(res.resources.map((r) => r.kind)).not.toContain("submission");
    if (datasetType) expect(res.resources.map((r) => r.kind)).toContain("dataset_type");

    const stored = await prisma.agentIssue.findUniqueOrThrow({
      where: { id: res.id },
      select: { context: true, contextCollection: true },
    });
    // One resolved + one unresolvable = partial. With no dataset type to
    // resolve, nothing resolved at all, and the honest state is `unavailable`
    // — never `partial`, which would still imply something was attached.
    expect(stored.contextCollection).toBe(datasetType ? "partial" : "unavailable");
    expect(stored.context).toBeTruthy();
  });

  it("advertises every v1 context id (plus the rebuild's own entity names)", () => {
    const shape = (tool("report_issue").schema as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape)).toEqual(
      expect.arrayContaining(["bountyId", "submissionId", "auditBatchId", "windowId", "batchId", "contributorBatchId", "datasetTypeId"]),
    );
  });
});

// ── Shared fixture for the submit_decisions / whoami tests below — same
// shape as mcp/tools.audit-claim.test.ts's own `seedClaimableWindow` (not
// imported across test files on purpose; each integration file stays
// self-contained).
async function seedClaimableWindow(params: { itemCount: number; contributorUserId: string; requesterUserId: string }) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: params.requesterUserId,
      title: `mcp parity fixture ${suffix}`,
      description: "fixture bounty for MCP v1-parity tool tests",
      datasetCategory: DatasetCategory.debugging,
      language: "typescript",
      framework: "none",
      targetItems: BigInt(params.itemCount),
      requiredSponsorExamples: 0,
      auditMode: AuditMode.partial,
      auditCoveragePct: 100,
      holdDays: 0,
      karmaPerAcceptedItem: 25,
    },
  });
  createdBountyIds.push(bounty.id);

  const submissions = await Promise.all(
    Array.from({ length: params.itemCount }, (_, i) =>
      prisma.submission.create({
        data: {
          bountyId: bounty.id,
          contributorUserId: params.contributorUserId,
          title: `mcp parity fixture item ${i}`,
          payloadJson: { i },
          generationMethod: GenerationMethod.human,
          status: SubmissionStatus.in_audit,
        },
      }),
    ),
  );

  const window = await prisma.humanAuditWindow.create({
    data: {
      bountyId: bounty.id,
      windowIndex: 1,
      eligibleCount: submissions.length,
      quota: submissions.length,
      closureReason: "test_fixture",
    },
  });
  await prisma.humanAuditWindowMembership.createMany({
    data: submissions.map((s, i) => ({
      windowId: window.id,
      submissionId: s.id,
      rank: `mcp-parity-rank-${suffix}-${i}`,
      selected: true,
    })),
  });

  return { bountyId: bounty.id, windowId: window.id, submissionIds: submissions.map((s) => s.id) };
}

// ── 23. get_file_upload_limits also returns the item-count limits
describe("23 · get_file_upload_limits returns item-count limits alongside the byte limits", () => {
  it("returns the live pool inline limit under both item-count fields", async () => {
    const res = (await tool("get_file_upload_limits").call({}, {})) as {
      maxUploadBytes: number;
      bulkThresholdItems: number;
      maxItemsPerRequest: number;
    };
    expect(res.bulkThresholdItems).toBe(MCP_BULK_THRESHOLD_ITEMS);
    expect(res.maxItemsPerRequest).toBe(res.bulkThresholdItems);
    expect(res.maxUploadBytes).toBeGreaterThan(0);
  });
});

// ── 24. dispute_submission bounds its argument like this repo's own REST route
describe("24 · dispute_submission bounds argument the same as POST /v1/submissions/:id/dispute", () => {
  it("rejects an argument above 2000 characters at the schema boundary", () => {
    const parsed = tool("dispute_submission").schema.safeParse({ submissionId: "x", argument: "a".repeat(2001) });
    expect(parsed.success).toBe(false);
  });

  it("accepts one at the limit", () => {
    const parsed = tool("dispute_submission").schema.safeParse({ submissionId: "x", argument: "a".repeat(2000) });
    expect(parsed.success).toBe(true);
  });
});

// ── 25. report_issue bounds match this repo's own REST route
describe("25 · report_issue bounds match POST /v1/issues", () => {
  const base = {
    category: AgentIssueCategory.contract,
    impact: AgentIssueImpact.degraded,
    summary: "a valid parity summary",
    expected: "expected behavior",
    actual: "actual behavior",
  };

  it("rejects an oversized summary, expected, actual, steps, or context id", () => {
    expect(tool("report_issue").schema.safeParse({ ...base, summary: "s".repeat(201) }).success).toBe(false);
    expect(tool("report_issue").schema.safeParse({ ...base, expected: "e".repeat(1001) }).success).toBe(false);
    expect(tool("report_issue").schema.safeParse({ ...base, actual: "a".repeat(1001) }).success).toBe(false);
    expect(tool("report_issue").schema.safeParse({ ...base, steps: "x".repeat(4001) }).success).toBe(false);
    expect(tool("report_issue").schema.safeParse({ ...base, bountyId: "b".repeat(65) }).success).toBe(false);
    expect(tool("report_issue").schema.safeParse({ ...base, datasetTypeId: "d".repeat(65) }).success).toBe(false);
  });

  it("accepts a report at every bound", () => {
    expect(
      tool("report_issue").schema.safeParse({
        ...base,
        summary: "s".repeat(200),
        expected: "e".repeat(1000),
        actual: "a".repeat(1000),
        steps: "x".repeat(4000),
        bountyId: "b".repeat(64),
      }).success,
    ).toBe(true);
  });
});

// ── 26. create_upload_review_link bounds match this repo's own REST route
describe("26 · create_upload_review_link bounds match POST /v1/upload-review-drafts", () => {
  it("rejects a non-positive/fractional expectedItemCount and an oversized sourceDescription", () => {
    expect(tool("create_upload_review_link").schema.safeParse({ bountyId: "x", expectedItemCount: 0 }).success).toBe(false);
    expect(tool("create_upload_review_link").schema.safeParse({ bountyId: "x", expectedItemCount: -1 }).success).toBe(false);
    expect(tool("create_upload_review_link").schema.safeParse({ bountyId: "x", expectedItemCount: 1.5 }).success).toBe(false);
    expect(
      tool("create_upload_review_link").schema.safeParse({ bountyId: "x", sourceDescription: "d".repeat(501) }).success,
    ).toBe(false);
  });

  it("accepts a valid positive count and a description at the limit", () => {
    expect(
      tool("create_upload_review_link").schema.safeParse({
        bountyId: "x",
        expectedItemCount: 5,
        sourceDescription: "d".repeat(500),
      }).success,
    ).toBe(true);
  });
});

// ── 27. list_notifications accepts v1's `unread` alias of `unreadOnly`
describe("27 · list_notifications accepts v1's `unread` alias of `unreadOnly`", () => {
  it("unread:true filters identically to unreadOnly:true", async () => {
    const user = await createVerifiedUser("unreadalias");
    await prisma.notification.create({
      data: { userId: user, type: "parity.probe", title: "already read", body: "b", eventKey: `ua-read-${Date.now()}`, read: true },
    });
    await prisma.notification.create({
      data: { userId: user, type: "parity.probe", title: "still unread", body: "b", eventKey: `ua-unread-${Date.now()}` },
    });

    const viaAlias = (await tool("list_notifications").call({ unread: true }, { userId: user })) as {
      items: { title: string }[];
    };
    const viaCanonical = (await tool("list_notifications").call({ unreadOnly: true }, { userId: user })) as {
      items: { title: string }[];
    };
    expect(viaAlias.items.map((i) => i.title)).toEqual(viaCanonical.items.map((i) => i.title));
    expect(viaAlias.items.some((i) => i.title === "still unread")).toBe(true);
    expect(viaAlias.items.some((i) => i.title === "already read")).toBe(false);
  });
});

// ── 28. suggest_handles accepts v1's `count` parameter
describe("28 · suggest_handles accepts v1's `count` parameter (1-10, default 8)", () => {
  it("returns at most `count` suggestions, with and without a baseName", async () => {
    const withBase = (await tool("suggest_handles").call({ baseName: "parityhandle", count: 3 }, {})) as string[];
    expect(withBase.length).toBeLessThanOrEqual(3);
    const withoutBase = (await tool("suggest_handles").call({ count: 3 }, {})) as string[];
    expect(withoutBase.length).toBe(3);
  });

  it("rejects a count outside 1-10", () => {
    expect(tool("suggest_handles").schema.safeParse({ count: 0 }).success).toBe(false);
    expect(tool("suggest_handles").schema.safeParse({ count: 11 }).success).toBe(false);
  });
});

// ── 29. get_sponsor_submission_evidence accepts v1's `q` alias of `search`
describe("29 · get_sponsor_submission_evidence accepts v1's `q` alias of `search`", () => {
  it("q filters identically to search", async () => {
    const owner = await createVerifiedUser("sponsorevidenceq");
    const contributor = await createVerifiedUser("sponsorevidenceqc");
    const datasetType = await prisma.datasetType.findFirst({ where: { status: DatasetTypeStatus.active } });
    if (!datasetType) {
      // Honest skip over an empty catalog, matching describe 21's own pattern.
      expect(tool("get_sponsor_submission_evidence").schema.safeParse({ bountyId: "x", q: "y" }).success).toBe(true);
      return;
    }
    const bounty = await prisma.bounty.create({
      data: {
        kind: BountyKind.community,
        status: BountyStatus.active,
        title: `q-alias fixture ${Date.now()}`,
        description: "q alias probe",
        datasetTypeId: datasetType.id,
        datasetCategory: datasetType.category,
        targetItems: 10,
        karmaPerAcceptedItem: 1,
        language: "TypeScript",
        framework: "none",
        requesterUserId: owner,
        auditMode: "partial",
        auditCoveragePct: 10,
        holdDays: 0,
      },
    });
    createdBountyIds.push(bounty.id);
    await prisma.submission.create({
      data: {
        bountyId: bounty.id,
        contributorUserId: contributor,
        title: "zzzuniquematch fixture item",
        payloadJson: {},
        generationMethod: GenerationMethod.human,
        status: SubmissionStatus.submitted,
      },
    });
    await prisma.submission.create({
      data: {
        bountyId: bounty.id,
        contributorUserId: contributor,
        title: "unrelated other item",
        payloadJson: {},
        generationMethod: GenerationMethod.human,
        status: SubmissionStatus.submitted,
      },
    });

    const viaQ = (await tool("get_sponsor_submission_evidence").call(
      { bountyId: bounty.id, q: "zzzuniquematch" },
      { userId: owner },
    )) as { submissions: { title: string }[] };
    const viaSearch = (await tool("get_sponsor_submission_evidence").call(
      { bountyId: bounty.id, search: "zzzuniquematch" },
      { userId: owner },
    )) as { submissions: { title: string }[] };
    expect(viaQ.submissions.map((s) => s.title)).toEqual(viaSearch.submissions.map((s) => s.title));
    expect(viaQ.submissions).toHaveLength(1);
    expect(viaQ.submissions[0]!.title).toContain("zzzuniquematch");
  });
});

// ── 30. submit_decisions accepts v1's submissionId alias of auditItemId
describe("30 · submit_decisions accepts v1's submissionId alias of auditItemId", () => {
  it("resolves a decision named by submissionId, scoped to the claimed window", async () => {
    const owner = await createVerifiedUser("subdecowner");
    const contributor = await createVerifiedUser("subdeccontrib");
    const validator = await createVerifiedUser("subdecvalidator");
    const { windowId, submissionIds } = await seedClaimableWindow({
      itemCount: 1,
      contributorUserId: contributor,
      requesterUserId: owner,
    });

    const claimed = await tool("claim_audit").call({ windowId }, { userId: validator });
    expect((claimed as { ok: boolean }).ok).toBe(true);

    const decided = (await tool("submit_decisions").call(
      { windowId, decisions: [{ submissionId: submissionIds[0], verdict: "ok" }] },
      { userId: validator },
    )) as { ok: boolean };
    expect(decided.ok).toBe(true);

    const submission = await prisma.submission.findUniqueOrThrow({ where: { id: submissionIds[0] } });
    expect(submission.status).toBe(SubmissionStatus.accepted);
  });

  it("rejects a submissionId that is not part of THIS window with a clear 400, not a cross-window match", async () => {
    const owner = await createVerifiedUser("subdecowner2");
    const contributorA = await createVerifiedUser("subdeccontriba2");
    const contributorB = await createVerifiedUser("subdeccontribb2");
    const validator = await createVerifiedUser("subdecvalidator2");
    const windowA = await seedClaimableWindow({ itemCount: 1, contributorUserId: contributorA, requesterUserId: owner });
    const windowB = await seedClaimableWindow({ itemCount: 1, contributorUserId: contributorB, requesterUserId: owner });

    await tool("claim_audit").call({ windowId: windowA.windowId }, { userId: validator });

    // windowB's submission id does not belong to windowA's membership set.
    await expect(
      tool("submit_decisions").call(
        { windowId: windowA.windowId, decisions: [{ submissionId: windowB.submissionIds[0], verdict: "ok" }] },
        { userId: validator },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("schema requires at least one of auditItemId/submissionId per decision", () => {
    const parsed = tool("submit_decisions").schema.safeParse({ windowId: "x", decisions: [{ verdict: "ok" }] });
    expect(parsed.success).toBe(false);
  });
});

// ── 31. whoami surfaces activity.activeAudits and badges, matching v1
describe("31 · whoami returns activity.activeAudits and badges", () => {
  it("activeAudits reflects a real claimed-and-unsettled audit window count", async () => {
    const owner = await createVerifiedUser("whoamiactowner");
    const contributor = await createVerifiedUser("whoamiactcontrib");
    const validator = await createVerifiedUser("whoamiactvalidator");

    const before = (await tool("whoami").call({}, { userId: validator })) as {
      activity: { activeAudits: number };
      badges: unknown[] | null;
    };
    expect(before.activity.activeAudits).toBe(0);
    expect(Array.isArray(before.badges)).toBe(true);

    const { windowId } = await seedClaimableWindow({ itemCount: 1, contributorUserId: contributor, requesterUserId: owner });
    await tool("claim_audit").call({ windowId }, { userId: validator });

    const after = (await tool("whoami").call({}, { userId: validator })) as { activity: { activeAudits: number } };
    expect(after.activity.activeAudits).toBe(1);
  });
});

// ── 32. Pass-3 fix: delete_file's REQUIRES_VERIFIED_EMAIL gap (tool-gate.ts)
describe("32 · delete_file requires a verified email, matching DELETE /v1/artifacts/:id", () => {
  const deleteFileTool = tools.find((t) => t.name === "delete_file")!;

  it("refuses an unverified caller with 403 email_unverified, before it ever reaches softDeleteArtifact", async () => {
    const unverified = await createUnverifiedUser("delfileunverif");
    const err = await assertToolAllowed(deleteFileTool, { userId: unverified, scopes: ["artifact"] }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).status).toBe(403);
    expect((err as McpToolError).code).toBe("email_unverified");
  });

  it("lets a verified caller through the gate", async () => {
    const verified = await createVerifiedUser("delfileverif");
    await expect(assertToolAllowed(deleteFileTool, { userId: verified, scopes: ["artifact"] })).resolves.toBeUndefined();
  });
});

// ── 33. Pass-3 fix: list_community_pools / list_notifications now wrap
// PoolCursorError / NotificationCursorError through withCursorErrors, exactly
// like every other cursor-paged tool in this file (get_karma_details above,
// list_my_issues, list_files, ...).
describe("33 · list_community_pools and list_notifications reject a malformed cursor rather than paging as if it were the end of the list", () => {
  it("list_community_pools rejects a malformed cursor with an actionable 400, not an empty page", async () => {
    await expect(tool("list_community_pools").call({ cursor: "not-a-real-cursor" }, {})).rejects.toBeInstanceOf(
      McpToolError,
    );
    await expect(tool("list_community_pools").call({ cursor: "not-a-real-cursor" }, {})).rejects.toThrow(/cursor/i);
  });

  it("list_notifications rejects a malformed cursor with an actionable 400, not an empty page", async () => {
    const notifyUser = await createVerifiedUser("cursornotify");
    await expect(
      tool("list_notifications").call({ cursor: "not-a-real-cursor" }, { userId: notifyUser }),
    ).rejects.toBeInstanceOf(McpToolError);
    await expect(
      tool("list_notifications").call({ cursor: "not-a-real-cursor" }, { userId: notifyUser }),
    ).rejects.toThrow(/cursor/i);
  });
});

// ── 34. Pass-3 fixes on submit_pool_items: the item title is now bounded like
// this repo's own REST route, and the tool now translates the service's
// invalid-state Errors into an actionable McpToolError instead of letting
// them reach the transport uncaught (where safeMcpErrorMessage() would
// replace them with a generic, misleadingly-retryable message).
describe("34 · submit_pool_items bounds item titles and surfaces specific invalid-state errors", () => {
  it("bounds each item's title like routes/v1/submissions.ts (.trim().min(3).max(120))", () => {
    const schema = tool("submit_pool_items").schema;
    const base = { bountyId: "b1" };
    expect(schema.safeParse({ ...base, items: [{ title: "ab", payloadJson: {} }] }).success).toBe(false);
    expect(schema.safeParse({ ...base, items: [{ title: "  ", payloadJson: {} }] }).success).toBe(false);
    expect(schema.safeParse({ ...base, items: [{ title: "x".repeat(121), payloadJson: {} }] }).success).toBe(false);
    expect(schema.safeParse({ ...base, items: [{ title: "abc", payloadJson: {} }] }).success).toBe(true);
    expect(schema.safeParse({ ...base, items: [{ title: "x".repeat(120), payloadJson: {} }] }).success).toBe(true);
  });

  it("reports 'not active or does not exist' for a draft (never-activated) pool, not the generic could-not-complete message", async () => {
    const requester = await createVerifiedUser("submitinactivereq");
    const contributor = await createVerifiedUser("submitinactivecontrib");
    const datasetType = await prisma.datasetType.findFirst({ where: { status: DatasetTypeStatus.active } });
    const draftPool = await prisma.bounty.create({
      data: {
        kind: BountyKind.community,
        // No `status` — defaults to `draft`, i.e. never activated.
        title: `parity draft pool ${Date.now()}`,
        description: "inactive-pool probe",
        datasetTypeId: datasetType?.id,
        datasetCategory: datasetType?.category ?? DatasetCategory.debugging,
        targetItems: 10,
        karmaPerAcceptedItem: 1,
        language: "TypeScript",
        framework: "none",
        requesterUserId: requester,
        auditMode: "partial",
        auditCoveragePct: 10,
        holdDays: 0,
      },
    });
    createdBountyIds.push(draftPool.id);

    const err = await tool("submit_pool_items")
      .call({ bountyId: draftPool.id, items: [{ title: "a real title", payloadJson: { a: 1 } }] }, { userId: contributor })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).status).toBe(400);
    expect((err as McpToolError).message).toMatch(/not active or does not exist/i);
  });

  it("reports 'already reached its item target' for a full pool, not the generic could-not-complete message", async () => {
    const requester = await createVerifiedUser("submitfullreq");
    const contributor = await createVerifiedUser("submitfullcontrib");
    const datasetType = await prisma.datasetType.findFirst({ where: { status: DatasetTypeStatus.active } });
    const fullPool = await prisma.bounty.create({
      data: {
        kind: BountyKind.community,
        status: BountyStatus.active,
        title: `parity full pool ${Date.now()}`,
        description: "at-target-pool probe",
        datasetTypeId: datasetType?.id,
        datasetCategory: datasetType?.category ?? DatasetCategory.debugging,
        targetItems: 1,
        acceptedItems: 1,
        // Default is 3; the check constraint requires
        // required_sponsor_examples < target_items, which a targetItems of 1
        // can never satisfy at the default.
        requiredSponsorExamples: 0,
        karmaPerAcceptedItem: 1,
        language: "TypeScript",
        framework: "none",
        requesterUserId: requester,
        auditMode: "partial",
        auditCoveragePct: 10,
        holdDays: 0,
      },
    });
    createdBountyIds.push(fullPool.id);

    const err = await tool("submit_pool_items")
      .call({ bountyId: fullPool.id, items: [{ title: "a real title", payloadJson: { a: 1 } }] }, { userId: contributor })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).status).toBe(400);
    expect((err as McpToolError).message).toMatch(/already reached its item target/i);
  });
});

// ── 35. Pass-3 fix: revise_submission's replacement title is now bounded like
// routes/v1/submissions.ts `reviseBody` (`.trim().min(3).max(120).optional()`).
describe("35 · revise_submission bounds its replacement title like the REST route", () => {
  it("rejects a too-short, whitespace-only or too-long title, and accepts omitting it entirely", () => {
    const schema = tool("revise_submission").schema;
    const base = { submissionId: "s1", payloadJson: { a: 1 } };
    expect(schema.safeParse({ ...base, title: "ab" }).success).toBe(false);
    expect(schema.safeParse({ ...base, title: "   " }).success).toBe(false);
    expect(schema.safeParse({ ...base, title: "x".repeat(121) }).success).toBe(false);
    expect(schema.safeParse({ ...base, title: "abc" }).success).toBe(true);
    expect(schema.safeParse({ ...base, title: "x".repeat(120) }).success).toBe(true);
    expect(schema.safeParse(base).success).toBe(true);
  });
});

describe("37 · rerun_submission_validation mirrors the contributor validation gate", () => {
  it("is contribute-scoped, takes only a submission id, and requires a verified email", async () => {
    const rerun = tool("rerun_submission_validation");
    expect(rerun.scope).toBe("contribute");
    expect(rerun.schema.safeParse({ submissionId: "sub_1" }).success).toBe(true);
    expect(rerun.schema.safeParse({}).success).toBe(false);
    const unverified = await createUnverifiedUser("rerungate");
    await expect(assertToolAllowed(rerun, { userId: unverified, scopes: ["contribute"] })).rejects.toMatchObject({ status: 403, code: "email_unverified" });
  });
});

// ── 36. Pass-3 fix: complete_file_upload now translates completeUpload's
// thrown errors into an actionable McpToolError instead of letting them reach
// the transport uncaught.
describe("36 · complete_file_upload surfaces specific errors instead of the generic could-not-complete message", () => {
  it("reports 'not found or access denied' for someone else's artifact, not the generic message", async () => {
    const owner = await createVerifiedUser("completeownerA");
    const stranger = await createVerifiedUser("completestrangerA");
    const artifact = await prisma.artifact.create({
      data: {
        kind: ArtifactKind.submission_attachment,
        ownerUserId: owner,
        filename: "parity-complete-owner.txt",
        contentType: "text/plain",
        storageKey: `test/parity-complete/${Date.now()}`,
        status: ArtifactStatus.pending_upload,
      },
    });
    createdArtifactIds.push(artifact.id);

    const err = await tool("complete_file_upload").call({ fileId: artifact.id }, { userId: stranger }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).status).toBe(400);
    expect((err as McpToolError).message).toMatch(/not found or access denied/i);
  });

  it("reports 'upload slot is no longer open' (409) for an already-completed slot, not the generic message", async () => {
    const owner = await createVerifiedUser("completeownerB");
    const artifact = await prisma.artifact.create({
      data: {
        kind: ArtifactKind.submission_attachment,
        ownerUserId: owner,
        filename: "parity-complete-done.txt",
        contentType: "text/plain",
        storageKey: `test/parity-complete/${Date.now()}`,
        // Already past pending_upload — completeUpload's SLOT_NOT_OPEN case,
        // reachable with no real storage backend involved.
        status: ArtifactStatus.ready,
      },
    });
    createdArtifactIds.push(artifact.id);

    const err = await tool("complete_file_upload").call({ fileId: artifact.id }, { userId: owner }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).status).toBe(409);
    expect((err as McpToolError).code).toBe("SLOT_NOT_OPEN");
    expect((err as McpToolError).message).toMatch(/upload slot is no longer open/i);
  });
});

// ── 37. Pass-4 fix: list_community_pools now exposes `status`/`phase`, the
// two filters GET /v1/bounties (the REST route this same listCommunityPools
// service backs) has always accepted — the service itself already took both
// params, only this tool's schema never surfaced them, so an agent could not
// ask for a completed/delivered pool without listing everything and
// filtering client-side.
describe("37 · list_community_pools accepts status and phase, matching GET /v1/bounties", () => {
  it("status narrows to an exact lifecycle state and excludes everything else", async () => {
    const datasetType = await prisma.datasetType.findFirst({ where: { status: DatasetTypeStatus.active } });
    if (!datasetType) {
      expect(tool("list_community_pools").schema.safeParse({ status: BountyStatus.completed }).success).toBe(true);
      return;
    }
    const completed = await prisma.bounty.create({
      data: {
        kind: BountyKind.community,
        status: BountyStatus.completed,
        title: `parity status-filter pool ${Date.now()}`,
        description: "status filter probe",
        datasetTypeId: datasetType.id,
        datasetCategory: datasetType.category,
        targetItems: 10,
        karmaPerAcceptedItem: 1,
        language: "TypeScript",
        framework: "none",
        requesterUserId: userId,
        auditMode: "partial",
        auditCoveragePct: 10,
        holdDays: 0,
      },
    });
    createdBountyIds.push(completed.id);

    const matching = (await tool("list_community_pools").call({ status: BountyStatus.completed, limit: 100 }, {})) as {
      bounties: { id: string; status: string }[];
    };
    expect(matching.bounties.map((b) => b.id)).toContain(completed.id);
    expect(matching.bounties.every((b) => b.status === BountyStatus.completed)).toBe(true);

    // The default (no status/phase) window is active/completed/closing only
    // in the OLDER port; with an explicit status this pool is reachable, and
    // asking for `active` alone must exclude it.
    const excluded = (await tool("list_community_pools").call({ status: BountyStatus.active, limit: 100 }, {})) as {
      bounties: { id: string }[];
    };
    expect(excluded.bounties.map((b) => b.id)).not.toContain(completed.id);
  });

  it("phase resolves through the shared PHASE_STATUSES vocabulary, and an explicit status wins over it", async () => {
    const datasetType = await prisma.datasetType.findFirst({ where: { status: DatasetTypeStatus.active } });
    if (!datasetType) {
      expect(tool("list_community_pools").schema.safeParse({ phase: "delivered" }).success).toBe(true);
      return;
    }
    const delivered = await prisma.bounty.create({
      data: {
        kind: BountyKind.community,
        status: BountyStatus.completed,
        title: `parity phase-filter pool ${Date.now()}`,
        description: "phase filter probe",
        datasetTypeId: datasetType.id,
        datasetCategory: datasetType.category,
        targetItems: 10,
        karmaPerAcceptedItem: 1,
        language: "TypeScript",
        framework: "none",
        requesterUserId: userId,
        auditMode: "partial",
        auditCoveragePct: 10,
        holdDays: 0,
      },
    });
    createdBountyIds.push(delivered.id);

    const viaPhase = (await tool("list_community_pools").call({ phase: "delivered", limit: 100 }, {})) as {
      bounties: { id: string }[];
    };
    expect(viaPhase.bounties.map((b) => b.id)).toContain(delivered.id);

    // An unknown phase name must be a schema-level 400, never a silent
    // "matches nothing" 200 — the same rule REST's own `phaseSchema` enforces.
    expect(tool("list_community_pools").schema.safeParse({ phase: "not-a-real-phase" }).success).toBe(false);

    // A single explicit `status` wins over `phase` when both are given
    // (matching listCommunityPools' own precedence) — asking for the "open"
    // phase but pinning `status: completed` still finds this pool.
    const explicitWins = (await tool("list_community_pools").call(
      { phase: "open", status: BountyStatus.completed, limit: 100 },
      {},
    )) as { bounties: { id: string }[] };
    expect(explicitWins.bounties.map((b) => b.id)).toContain(delivered.id);
  });
});

// ── 38. Pass-4 fix: list_files now exposes `plannerSessionId`, which GET
// /v1/artifacts (routes/v1/artifacts.ts) and listUserArtifacts have always
// accepted — only this tool's schema never surfaced it, so an agent resuming
// a sponsor's planner draft (reference samples exist before any bounty does,
// so there is no bountyId to filter by yet) had to page the whole account.
describe("38 · list_files accepts plannerSessionId, matching GET /v1/artifacts", () => {
  it("narrows to one planner draft's own artifacts and excludes another owner's", async () => {
    const owner = await createVerifiedUser("plannerfilesowner");
    const session = await prisma.plannerSession.create({
      data: { userId: owner, answersJson: {}, transcript: [] },
    });
    const other = await prisma.artifact.create({
      data: {
        kind: ArtifactKind.submission_attachment,
        ownerUserId: owner,
        filename: "unrelated.txt",
        contentType: "text/plain",
        storageKey: `test/parity-planner-files/unrelated-${Date.now()}`,
        status: ArtifactStatus.ready,
      },
    });
    createdArtifactIds.push(other.id);
    const scoped = await prisma.artifact.create({
      data: {
        kind: ArtifactKind.sponsor_reference,
        ownerUserId: owner,
        plannerSessionId: session.id,
        filename: "draft-sample.txt",
        contentType: "text/plain",
        storageKey: `test/parity-planner-files/draft-${Date.now()}`,
        status: ArtifactStatus.ready,
      },
    });
    createdArtifactIds.push(scoped.id);

    const filtered = (await tool("list_files").call({ plannerSessionId: session.id }, { userId: owner })) as {
      items: { id: string }[];
    };
    expect(filtered.items.map((f) => f.id)).toEqual([scoped.id]);
    expect(filtered.items.map((f) => f.id)).not.toContain(other.id);

    await prisma.artifact.deleteMany({ where: { id: { in: [other.id, scoped.id] } } });
    await prisma.plannerSession.delete({ where: { id: session.id } });
  });
});

// ── 39. Pass-4 fix: list_my_submissions now exposes `bountyId`, which GET
// /v1/submissions (routes/v1/submissions.ts) and listSubmissions have always
// accepted — only this tool's schema never surfaced it, even though the
// schema's own pre-existing comment already described listSubmissions'
// bountyId/contributorUserId/status filter set, so an agent asking "what have
// I submitted to THIS pool?" had to page their whole history client-side.
describe("39 · list_my_submissions accepts bountyId, matching GET /v1/submissions", () => {
  it("narrows to one pool's submissions and excludes another pool's", async () => {
    const datasetType = await prisma.datasetType.findFirst({ where: { status: DatasetTypeStatus.active } });
    if (!datasetType) {
      expect(tool("list_my_submissions").schema.safeParse({ bountyId: "x" }).success).toBe(true);
      return;
    }
    const contributor = await createVerifiedUser("bountyfiltersubmitter");
    const makePool = async (suffix: string) => {
      const pool = await prisma.bounty.create({
        data: {
          kind: BountyKind.community,
          status: BountyStatus.active,
          title: `parity bountyId-filter pool ${suffix}`,
          description: "bountyId filter probe",
          datasetTypeId: datasetType.id,
          datasetCategory: datasetType.category,
          targetItems: 10,
          karmaPerAcceptedItem: 1,
          language: "TypeScript",
          framework: "none",
          requesterUserId: userId,
          auditMode: "partial",
          auditCoveragePct: 10,
          holdDays: 0,
        },
      });
      createdBountyIds.push(pool.id);
      return pool;
    };
    const poolA = await makePool(`a-${Date.now()}`);
    const poolB = await makePool(`b-${Date.now()}`);
    const subA = await prisma.submission.create({
      data: {
        bountyId: poolA.id,
        contributorUserId: contributor,
        title: "in pool A",
        payloadJson: {},
        status: SubmissionStatus.submitted,
        generationMethod: GenerationMethod.human,
      },
    });
    const subB = await prisma.submission.create({
      data: {
        bountyId: poolB.id,
        contributorUserId: contributor,
        title: "in pool B",
        payloadJson: {},
        status: SubmissionStatus.submitted,
        generationMethod: GenerationMethod.human,
      },
    });

    const filtered = (await tool("list_my_submissions").call({ bountyId: poolA.id }, { userId: contributor })) as {
      items: { id: string }[];
    };
    expect(filtered.items.map((s) => s.id)).toContain(subA.id);
    expect(filtered.items.map((s) => s.id)).not.toContain(subB.id);
  });
});

// ── 40. Pass-4 fix: get_karma_details' cursor is now bound to the
// eventType/since/until filter it was minted under, matching every other
// paged tool in this file (list_files, list_my_submissions, list_audits,
// list_my_audits, list_my_issues, get_sponsor_submission_evidence all route
// through the same lib/keyset-cursor.js filter-bound envelope). Before this
// fix the tool's own description already claimed "keep eventType/since/until
// IDENTICAL across every page of one walk", but nothing enforced it: the
// cursor decoded only `createdAt|id`, so replaying a page-2 cursor under a
// DIFFERENT eventType silently returned a page from the new filter positioned
// by the old one instead of the actionable 400 every sibling tool gives.
describe("40 · get_karma_details' cursor is bound to its own filter set", () => {
  it("rejects a cursor minted under one eventType when replayed under another", async () => {
    const owner = await createVerifiedUser("karmacursorfilter");
    const makeEvent = async (eventType: (typeof KarmaEventType)[keyof typeof KarmaEventType], n: number) =>
      prisma.karmaEvent.create({
        data: {
          userId: owner,
          eventType,
          amount: 1,
          sourceType: "test",
          sourceId: `parity-karma-cursor-${eventType}-${n}-${Date.now()}`,
        },
      });
    await makeEvent(KarmaEventType.community_item_accepted, 1);
    await makeEvent(KarmaEventType.community_item_accepted, 2);
    await makeEvent(KarmaEventType.community_audit_completed, 1);

    const firstPage = (await tool("get_karma_details").call(
      { eventType: KarmaEventType.community_item_accepted, limit: 1 },
      { userId: owner },
    )) as { nextCursor: string | null; hasMore: boolean };
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBeTruthy();

    // Replaying the SAME cursor under a different eventType must be refused,
    // never silently re-anchored onto the new filter's rows.
    await expect(
      tool("get_karma_details").call(
        { eventType: KarmaEventType.community_audit_completed, cursor: firstPage.nextCursor! },
        { userId: owner },
      ),
    ).rejects.toBeInstanceOf(McpToolError);
    await expect(
      tool("get_karma_details").call(
        { eventType: KarmaEventType.community_audit_completed, cursor: firstPage.nextCursor! },
        { userId: owner },
      ),
    ).rejects.toThrow(/cursor/i);

    // The SAME filter, replayed, still pages correctly.
    const secondPage = (await tool("get_karma_details").call(
      { eventType: KarmaEventType.community_item_accepted, limit: 1, cursor: firstPage.nextCursor! },
      { userId: owner },
    )) as { events: { eventType: string }[] };
    expect(secondPage.events.every((e) => e.eventType === KarmaEventType.community_item_accepted)).toBe(true);
  });
});
