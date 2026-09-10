// SPDX-License-Identifier: Apache-2.0

/**
 * QA F-007 (P2), found live 2026-09-06 — regression coverage for the
 * list/claim audit-conflict split.
 *
 * The list and claim must carry the same self-review rule: a caller cannot
 * review a window containing their own submitted item. Sponsoring a pool or
 * contributing other items to it remains eligible for independent review.
 *
 * Both surfaces now share one predicate, `auditConflictReasonFor` in
 * services/audits.ts. These tests assert the two agree, in both directions,
 * for a sponsor, contributor to the window, unrelated eligible validator, and
 * a window already claimed by someone else.
 *
 * HERMETIC BY DESIGN: real Fastify routing, the real route handlers and the
 * real `services/audits.ts` list + claim logic, with `prisma`, `rbac` and the
 * side-effecting services `audits.ts` imports as explicit doubles. No
 * PostgreSQL, no network. Pattern follows
 * `admin.suspension-revokes-drafts.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";

const H = vi.hoisted(() => {
  interface SubmissionRow {
    status: string;
    contributorUserId: string;
    /** Optional: only set by the near-dup-of-own-work fixtures below. Absent
     * (undefined) behaves exactly like null — no conflict. */
    duplicateOfSubmissionId?: string | null;
  }
  interface MembershipRow {
    id: string;
    submissionId: string;
    selected: boolean;
    submission: SubmissionRow;
  }
  interface WindowRow {
    id: string;
    bountyId: string;
    quota: number;
    auditBatchId: string | null;
    closedAt: Date | null;
    settledAt: Date | null;
    supersededAt: Date | null;
    claimedByUserId: string | null;
    claimedAt: Date | null;
    claimExpiresAt: Date | null;
    bounty: {
      id: string;
      title: string;
      datasetCategory: string;
      language: string;
      requesterUserId: string;
      communityRequesterUserId: string | null;
    };
    memberships: MembershipRow[];
  }

  const state = {
    windows: [] as WindowRow[],
    /** `Rank` rows, keyed by userId — drives the concurrent-claim cap. */
    ranks: [] as Array<{ userId: string; auditsCompleted: number }>,
    /** Advisory-lock keys the claim transaction took, in order. */
    advisoryLocks: [] as string[],
    /** Submission rows a validator "authored", for the near-dup-of-own-work
     * conflict check (loadValidatorDuplicateConflictSets). Empty by default —
     * no window fixture in this file gives a validator any submissions of
     * their own, so this predicate is a no-op unless a test seeds it. */
    submissions: [] as Array<{ id: string; contributorUserId: string; duplicateOfSubmissionId: string | null }>,
  };

  function selectedMemberships(w: WindowRow): MembershipRow[] {
    return w.memberships.filter((m) => m.selected);
  }

  /** The only `where` shape listAvailableAudits builds. Unsupported keys throw
   * loudly rather than silently passing a window through. */
  function matchesListWhere(w: WindowRow, where: Record<string, unknown>): boolean {
    for (const [key, cond] of Object.entries(where)) {
      switch (key) {
        case "settledAt":
          if (w.settledAt !== null) return false;
          break;
        case "supersededAt":
          if (w.supersededAt !== null) return false;
          break;
        case "claimedByUserId":
          if (w.claimedByUserId !== null) return false;
          break;
        case "bountyId":
          if (w.bountyId !== cond) return false;
          break;
        default:
          throw new Error(`Unsupported listAvailableAudits where key: ${key}`);
      }
    }
    return true;
  }

  const humanAuditWindowDelegate = {
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      state.windows
        .filter((w) => matchesListWhere(w, where))
        .map((w) => ({ ...w, memberships: selectedMemberships(w) })),

    findUnique: async ({ where }: { where: { id: string } }) => {
      const w = state.windows.find((row) => row.id === where.id);
      if (!w) return null;
      return { ...w, memberships: selectedMemberships(w) };
    },

    count: async ({ where }: { where: Record<string, any> }) => {
      const now: Date = where.OR?.[1]?.claimExpiresAt?.gte ?? new Date();
      return state.windows.filter(
        (w) =>
          w.claimedByUserId === where.claimedByUserId &&
          w.settledAt === null &&
          (w.claimExpiresAt === null || w.claimExpiresAt.getTime() >= now.getTime())
      ).length;
    },

    updateMany: async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
      let count = 0;
      for (const w of state.windows) {
        if (w.id !== where.id) continue;
        if (where.claimedByUserId === null && w.claimedByUserId !== null) continue;
        if (where.settledAt === null && w.settledAt !== null) continue;
        if (where.supersededAt === null && w.supersededAt !== null) continue;
        Object.assign(w, data);
        count += 1;
      }
      return { count };
    },
  };

  const prismaMock: Record<string, unknown> = {
    humanAuditWindow: humanAuditWindowDelegate,
    // No AuditItem rows in these fixtures: the windows are legacy-shaped
    // (auditBatchId null), so decided counts derive from submission status.
    auditItem: { findMany: async () => [] },
    // Backs loadValidatorDuplicateConflictSets (services/audits.ts): the two
    // findMany calls it issues (own submissions; own submissions that are
    // themselves duplicate-flagged) both filter state.submissions the same
    // way, distinguished only by whether duplicateOfSubmissionId is required.
    submission: {
      findMany: async ({ where }: { where: { contributorUserId: string; duplicateOfSubmissionId?: unknown } }) =>
        state.submissions.filter(
          (r) => r.contributorUserId === where.contributorUserId && (!where.duplicateOfSubmissionId || r.duplicateOfSubmissionId != null)
        ),
    },
    rank: {
      findUnique: async ({ where }: { where: { userId: string } }) =>
        state.ranks.find((r) => r.userId === where.userId) ?? null,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient),
  };

  const txClient = {
    humanAuditWindow: humanAuditWindowDelegate,
    rank: prismaMock.rank,
    // Tagged-template call: `tx.$executeRaw`SELECT pg_advisory_xact_lock(...)``
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      state.advisoryLocks.push(String(values[0]));
      return 1;
    },
  };

  return { state, prismaMock };
});

const { state, prismaMock } = H;

vi.mock("../../lib/prisma.js", () => ({ prisma: prismaMock }));

// Auth is not what is under test: `x-test-actor` names the caller, and every
// caller is a verified validator with the `validate` scope.
vi.mock("../../lib/rbac.js", () => ({
  requireAnyScope:
    () =>
    async (
      req: { headers: Record<string, string | string[] | undefined> },
      reply: { unauthorized: (m: string) => unknown }
    ) => {
      const actor = req.headers["x-test-actor"];
      if (typeof actor !== "string") return reply.unauthorized("Sign in required");
      (req as unknown as { authedUser: unknown }).authedUser = { id: actor, roles: ["user"] };
    },
  requireVerifiedEmail: async () => {},
}));

// Side-effecting collaborators `services/audits.ts` imports at module load.
// None of them participate in listing or claiming.
vi.mock("../../services/karma.js", () => ({
  awardKarma: async () => {},
  KARMA_RULES: { auditItem: 8 },
}));
vi.mock("../../services/karma-holds.js", () => ({ awardOrHoldAcceptedItemKarma: async () => {} }));
vi.mock("../../services/submission-acceptance.js", () => ({ recomputeAcceptedItemCounters: async () => {} }));
vi.mock("../../services/notifications.js", () => ({ notifyUser: async () => {} }));
vi.mock("../../services/admin-settings.js", () => ({ llmValidationEnabled: async () => false }));
vi.mock("../../services/llm-client.js", () => ({ openRouterConfigured: () => false }));

// The real routes and the real list/claim service logic are under test.
const { auditRoutes } = await import("./audits.js");
const { auditConflictReasonFor } = await import("../../services/audits.js");

const SPONSOR = "user_sponsor";
const CONTRIBUTOR = "user_contributor";
const VALIDATOR = "user_validator";
const OTHER_VALIDATOR = "user_other_validator";

const WINDOW_ID = "win_open";
const CLAIMED_WINDOW_ID = "win_claimed_by_other";

let app: FastifyInstance;

function seedWindow(
  id: string,
  overrides: Partial<(typeof state.windows)[number]> = {},
  contributorUserId: string = CONTRIBUTOR
): void {
  state.windows.push({
    id,
    bountyId: `bounty_for_${id}`,
    quota: 2,
    auditBatchId: null,
    closedAt: new Date("2026-09-05T00:00:00Z"),
    settledAt: null,
    supersededAt: null,
    claimedByUserId: null,
    claimedAt: null,
    claimExpiresAt: null,
    bounty: {
      id: `bounty_for_${id}`,
      title: `pool ${id}`,
      datasetCategory: "debugging",
      language: "typescript",
      // The legacy sponsor column. Community pools also carry
      // communityRequesterUserId, which takes precedence.
      requesterUserId: SPONSOR,
      communityRequesterUserId: SPONSOR,
    },
    memberships: [
      {
        id: `${id}_m1`,
        submissionId: `${id}_s1`,
        selected: true,
        submission: { status: "in_audit", contributorUserId },
      },
      {
        id: `${id}_m2`,
        submissionId: `${id}_s2`,
        selected: true,
        submission: { status: "in_audit", contributorUserId },
      },
    ],
    ...overrides,
  });
}

/** The seeded window row, for asserting whether a refused call wrote. */
function windowRow(id: string): (typeof state.windows)[number] {
  const row = state.windows.find((w) => w.id === id);
  if (!row) throw new Error(`missing window ${id}`);
  return row;
}

async function listAudits(actor: string) {
  return app.inject({ method: "GET", url: "/v1/audits?limit=10", headers: { "x-test-actor": actor } });
}

async function claim(actor: string, windowId: string) {
  return app.inject({
    method: "POST",
    url: `/v1/audits/${windowId}/claim`,
    headers: { "x-test-actor": actor },
  });
}

beforeEach(async () => {
  state.windows = [];
  state.ranks = [];
  state.advisoryLocks = [];
  state.submissions = [];
  seedWindow(WINDOW_ID);
  if (app) await app.close();
  app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(auditRoutes, { prefix: "/v1/audits" });
  await app.ready();
});

describe("GET /v1/audits and POST /v1/audits/:id/claim agree on audit conflicts", () => {
  it("allows the pool sponsor to list and claim a window that contains none of their submissions", async () => {
    const list = await listAudits(SPONSOR);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      total: 1,
      conflictExcluded: 0,
      conflictExcludedByReason: { own_submission: 0, duplicate_of_own_work: 0 },
    });
    expect(list.json().audits).toEqual([expect.objectContaining({ id: WINDOW_ID })]);

    const res = await claim(SPONSOR, WINDOW_ID);
    expect(res.statusCode).toBe(200);
    expect(windowRow(WINDOW_ID).claimedByUserId).toBe(SPONSOR);
  });

  it("a contributor to the window is excluded from the list AND refused by the claim", async () => {
    const list = await listAudits(CONTRIBUTOR);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      total: 0,
      conflictExcluded: 1,
      conflictExcludedByReason: { own_submission: 1, duplicate_of_own_work: 0 },
    });

    const res = await claim(CONTRIBUTOR, WINDOW_ID);
    expect(res.statusCode).toBe(403);
    expect(windowRow(WINDOW_ID).claimedByUserId).toBeNull();
  });

  it("an unrelated eligible validator is listed AND can claim what was listed", async () => {
    const list = await listAudits(VALIDATOR);
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.total).toBe(1);
    expect(body.conflictExcluded).toBe(0);
    expect(body.audits).toHaveLength(1);
    expect(body.audits[0]).toMatchObject({ id: WINDOW_ID, itemCount: 2, status: "available" });

    const res = await claim(VALIDATOR, body.audits[0].id);
    expect(res.statusCode).toBe(200);
    expect(res.json().audit).toMatchObject({
      id: WINDOW_ID,
      claimedByUserId: VALIDATOR,
      status: "claimed",
      itemCount: 2,
    });
    expect(windowRow(WINDOW_ID).claimedByUserId).toBe(VALIDATOR);
    // The claim really took its per-validator advisory lock.
    expect(state.advisoryLocks).toEqual([`audit-claim:${VALIDATOR}`]);
  });

  it("a window already claimed by someone else is not offered, and is not a conflict exclusion", async () => {
    state.windows = [];
    seedWindow(CLAIMED_WINDOW_ID, {
      claimedByUserId: OTHER_VALIDATOR,
      claimedAt: new Date("2026-09-06T00:00:00Z"),
      claimExpiresAt: new Date("2026-09-07T00:00:00Z"),
    });

    const list = await listAudits(VALIDATOR);
    expect(list.statusCode).toBe(200);
    // Withheld because it is taken, NOT because of a conflict — the count
    // stays truthful about what it reports.
    expect(list.json()).toMatchObject({ total: 0, conflictExcluded: 0 });

    const res = await claim(VALIDATOR, CLAIMED_WINDOW_ID);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("claimed by another validator");
    expect(windowRow(CLAIMED_WINDOW_ID).claimedByUserId).toBe(OTHER_VALIDATOR);
  });

  it("every window the list offers is claimable, and every conflict it withholds is refused", async () => {
    state.windows = [];
    seedWindow("win_a"); // contributor conflict for CONTRIBUTOR only
    seedWindow("win_b", {}, OTHER_VALIDATOR); // no conflict for CONTRIBUTOR

    // The sponsor is eligible for both windows; the contributor sees only
    // win_b because win_a contains their own submitted item.
    expect((await listAudits(SPONSOR)).json()).toMatchObject({ total: 2, conflictExcluded: 0 });

    const contributorList = await listAudits(CONTRIBUTOR);
    expect(contributorList.json()).toMatchObject({ total: 1, conflictExcluded: 1 });
    expect(contributorList.json().audits[0].id).toBe("win_b");

    // ...and the offered one really claims.
    expect((await claim(CONTRIBUTOR, "win_b")).statusCode).toBe(200);
  });
});

// New: the validator holds a near-duplicate of their OWN work in the window
// (v1's auditDuplicateOfValidatorConflict had no equivalent here until this
// port). Checked in both directions, matching v1 exactly.
describe("GET /v1/audits and POST /v1/audits/:id/claim agree on the near-dup-of-own-work conflict", () => {
  it("direction (a): the item under audit is a documented duplicate of a submission the validator owns", async () => {
    state.windows = [];
    seedWindow("win_dup_a", {
      memberships: [
        {
          id: "win_dup_a_m1",
          submissionId: "win_dup_a_s1",
          selected: true,
          // A stranger's submission, but the dedupe engine matched it to
          // something VALIDATOR themselves authored earlier.
          submission: { status: "in_audit", contributorUserId: "user_stranger", duplicateOfSubmissionId: "sub_owned_by_validator" },
        },
      ],
    });
    state.submissions = [{ id: "sub_owned_by_validator", contributorUserId: VALIDATOR, duplicateOfSubmissionId: null }];

    const list = await listAudits(VALIDATOR);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ total: 0, conflictExcluded: 1 });

    const res = await claim(VALIDATOR, "win_dup_a");
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("conflicts with your own submissions");
    expect(windowRow("win_dup_a").claimedByUserId).toBeNull();

    // An unrelated validator sees no conflict for the exact same window.
    const otherList = await listAudits(OTHER_VALIDATOR);
    expect(otherList.json()).toMatchObject({ total: 1, conflictExcluded: 0 });
  });

  it("direction (b): the validator later submitted something the dedupe engine matched to the item under audit", async () => {
    state.windows = [];
    seedWindow("win_dup_b", {
      memberships: [
        {
          id: "win_dup_b_m1",
          submissionId: "win_dup_b_s1",
          selected: true,
          submission: { status: "in_audit", contributorUserId: "user_stranger", duplicateOfSubmissionId: null },
        },
      ],
    });
    // VALIDATOR's own later submission was flagged as a near-dup of the item
    // now under audit.
    state.submissions = [{ id: "sub_by_validator_later", contributorUserId: VALIDATOR, duplicateOfSubmissionId: "win_dup_b_s1" }];

    const list = await listAudits(VALIDATOR);
    expect(list.json()).toMatchObject({ total: 0, conflictExcluded: 1 });

    const res = await claim(VALIDATOR, "win_dup_b");
    expect(res.statusCode).toBe(403);
    expect(windowRow("win_dup_b").claimedByUserId).toBeNull();
  });
});

describe("auditConflictReasonFor is the single source of truth", () => {
  const window = {
    memberships: [{ submission: { contributorUserId: CONTRIBUTOR } }],
  };

  it("allows a sponsor to audit a window containing another contributor's work", () => {
    expect(auditConflictReasonFor(window, SPONSOR)).toBeNull();
  });

  it("names the own-submission conflict", () => {
    expect(auditConflictReasonFor(window, CONTRIBUTOR)).toBe("own_submission");
  });

  it("returns null for an unrelated validator", () => {
    expect(auditConflictReasonFor(window, VALIDATOR)).toBeNull();
  });
});
