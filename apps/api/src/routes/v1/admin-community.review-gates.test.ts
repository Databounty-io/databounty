// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the four admin community-review authorization gates in
 * `admin-community.ts`. Each one was reproduced as a LIVE defect first, so each
 * test below is written to fail if its guard is removed — not merely to pass
 * against the current code.
 *
 *  1. Conflict-of-interest (`isSelfReview`): a reviewer may not decide, mint or
 *     implement their own dataset request. Before the fix one account created,
 *     approved (collecting the 25-karma approval award) and minted its own
 *     public pool, with `admin` AND with `member`-only staff roles. All four
 *     write routes are covered, under both identities.
 *  2. `REQUEST_DECISION_TRANSITIONS` / `canDecideRequest`: neither decision
 *     route had a from-status precondition, so a minted request was flipped
 *     `implemented -> declined -> under_review`, which re-opened the
 *     sponsor-side edit gate (`routes/v1/community.ts`
 *     REQUEST_EDITABLE_STATUSES) and the reference-sample gate
 *     (`services/artifacts.ts` SAMPLE_EDITABLE_REQUEST_STATUSES) behind a
 *     LIVE public pool, letting the spec be rewritten under a running bounty.
 *  3. Legacy `/dataset-requests/:id/mint` parity with
 *     `/community/requests/:id/implement`: it had no `approved` status gate,
 *     its "already minted?" check sat outside the transaction (TOCTOU — eight
 *     concurrent calls produced eight live public pools, seven orphaned), and
 *     `karmaPerAcceptedItem` was caller-supplied and unbounded (50,000 was
 *     accepted, so one accepted item granted the top karma tier).
 *  4. Reachability of every status: `disputed` and `declined` must have exits.
 *
 * Real route module on a real Fastify instance driven with `app.inject()`;
 * every dependency is an explicit in-memory double, so no Postgres and no
 * network — the same approach as `artifacts.upload-routes.test.ts`.
 *
 * The concurrency double deliberately models Postgres row-lock semantics
 * rather than serializing everything: `tx.$queryRaw` grants an exclusive
 * per-row lease ONLY when the SQL it is handed actually says `FOR UPDATE`, and
 * the row read/write helpers yield to the event loop, so eight interleaved
 * mints genuinely race. Deleting the `SELECT … FOR UPDATE` line from the route
 * makes the invariant test fail with eight bounties — and the
 * `enforceRowLocks: false` control test below proves exactly that, so the
 * passing case is not vacuous.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DatasetRequestStatus, DatasetTypeStatus } from "@prisma/client";
import { datasetLicense } from "../../lib/publication/license-texts.js";

type Row = {
  id: string;
  requesterUserId: string;
  title: string;
  description: string;
  datasetTypeId: string | null;
  domain: string | null;
  proposedLicense: string;
  language: string | null;
  framework: string | null;
  targetItems: number | null;
  difficultyMix: string | null;
  auditCoveragePct: number | null;
  status: DatasetRequestStatus;
  adminNote: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  mintedBountyId: string | null;
};

const DATASET_TYPE = {
  id: "api_function_calling",
  name: "API Call / Function-Calling",
  status: DatasetTypeStatus.active,
  complexityScore: 2,
  verificationUnits: 1,
  category: "implementation",
  domain: "coding",
  version: 1,
};

const DEFAULT_KARMA_RULES = {
  acceptedItem: { beginner: 10, intermediate: 25, advanced: 60 },
  auditItem: 8,
  confirmedFlag: 25,
  requestApproved: 25,
  publishBonus: 150,
  bountyPublished: 50,
};

const state = {
  actor: { id: "reviewer-1", roles: ["admin"] as string[], apiKeyScopes: undefined as string[] | undefined },
  requests: new Map<string, Row>(),
  bounties: [] as Record<string, unknown>[],
  karmaAwards: [] as Record<string, unknown>[],
  auditLogs: [] as Record<string, unknown>[],
  notifications: [] as string[],
  newWorkAlerts: [] as string[],
  /** Ordered log of what each transaction did, so the ORDER of lock/read/write
   *  is assertable and not just the end state. */
  txOps: [] as string[],
  /** Control switch: with row locks off the fake behaves like the pre-fix
   *  code path (no `FOR UPDATE` honoured), which is how the concurrency test
   *  proves it can still detect the regression. */
  enforceRowLocks: true,
  karmaRules: DEFAULT_KARMA_RULES as typeof DEFAULT_KARMA_RULES,
  bountySeq: 0,
  // See the artifact mock above: true unless a test explicitly asserts the
  // "no approved sample yet" gate.
  hasApprovedSample: true,
};

function makeRequest(over: Partial<Row> = {}): Row {
  const id = over.id ?? `req_${state.requests.size + 1}`;
  const row: Row = {
    id,
    requesterUserId: "sponsor-1",
    title: "Function-calling traces for tool routing",
    description: "A community corpus of function-calling traces for tool-routing evaluation.",
    datasetTypeId: DATASET_TYPE.id,
    domain: "coding",
    proposedLicense: "CC-BY-4.0",
    language: "TypeScript",
    framework: "Node.js",
    targetItems: 100,
    difficultyMix: "mostly_advanced",
    auditCoveragePct: 10,
    status: DatasetRequestStatus.submitted,
    adminNote: null,
    reviewedBy: null,
    reviewedAt: null,
    mintedBountyId: null,
    ...over,
  };
  state.requests.set(row.id, row);
  return row;
}

/* ----------------------------------------------------------------------- *
 * Row-lock double
 *
 * One exclusive lease per row id, handed out FIFO. Acquired only by a
 * `$queryRaw` whose SQL contains `FOR UPDATE`, released when the transaction
 * callback settles — i.e. the same window Postgres holds it for.
 * ----------------------------------------------------------------------- */
const lockQueues = new Map<string, Promise<void>>();

async function acquireRowLock(id: string): Promise<() => void> {
  if (!state.enforceRowLocks) return () => undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waitFor = lockQueues.get(id) ?? Promise.resolve();
  lockQueues.set(
    id,
    waitFor.then(() => held)
  );
  await waitFor;
  return release;
}

/** Yield the event loop, so concurrent transactions genuinely interleave
 *  between a read and its dependent write instead of running to completion
 *  one at a time by accident of the microtask queue. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeTx(releases: (() => void)[]) {
  return {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
      if (/FOR UPDATE/i.test(sql) && /dataset_requests/i.test(sql)) {
        const id = String(values[0]);
        state.txOps.push(`lock:${id}`);
        releases.push(await acquireRowLock(id));
      }
      return [];
    },
    datasetRequest: {
      findUnique: async ({ where, include }: { where: { id: string }; include?: { datasetType?: boolean } }) => {
        await tick();
        const row = state.requests.get(where.id);
        state.txOps.push(`read:${where.id}:${row?.status ?? "missing"}:minted=${row?.mintedBountyId ?? "-"}`);
        if (!row) return null;
        return include?.datasetType
          ? { ...row, datasetType: row.datasetTypeId ? { ...DATASET_TYPE, id: row.datasetTypeId } : null }
          : { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        await tick();
        const row = state.requests.get(where.id)!;
        Object.assign(row, data);
        state.txOps.push(`update:${where.id}:${row.status}`);
        return { ...row };
      },
    },
    bounty: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        await tick();
        const bounty = {
          id: `bounty_${++state.bountySeq}`,
          acceptedItems: 0n,
          finalAcceptedItems: 0n,
          ...data,
        };
        state.bounties.push(bounty);
        state.txOps.push(`create-bounty:${bounty.id}`);
        return bounty;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const found = state.bounties.find((b) => b.id === where.id);
        if (!found) throw new Error(`bounty ${where.id} not found`);
        state.txOps.push(`replay-bounty:${where.id}`);
        return found;
      },
      // The mint route's shared-dataset-type guard for its sampleAssets copy
      // (admin-community.ts): counts OTHER bounties already on the same type,
      // checked before this call site's own bounty.create. No test in this
      // file seeds two bounties sharing one datasetTypeId, so 0 is honest here.
      count: async ({ where }: { where: { datasetTypeId?: string } }) =>
        state.bounties.filter((b) => (b as { datasetTypeId?: string }).datasetTypeId === where.datasetTypeId).length,
    },
    // The mint/implement routes' sampleAssets copy (services/bounties.ts
    // safeToWriteSampleAssetsFor + this write) — a no-op double, since no
    // test in this file asserts on the WRITTEN sampleAssets shape itself
    // (that's covered by admin-community.ts's own dedicated test file).
    datasetType: {
      update: async () => undefined,
    },
  };
}

const noop = async () => undefined;

vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => unknown) => {
      const releases: (() => void)[] = [];
      try {
        return await fn(makeTx(releases));
      } finally {
        releases.forEach((r) => r());
      }
    },
    datasetRequest: { findMany: async () => [], count: async () => 0, findUnique: async () => null },
    bounty: { findMany: async () => [], count: async () => 0, findUnique: async () => null },
    // Owner decision, 2026-09-09: minting is gated on at least one approved
    // reference sample (buildApprovedSampleAssets, services/bounties.ts).
    // Defaults to "one exists" so every pre-existing test in this file, none
    // of which are about sample gating, keeps passing unchanged; the gate's
    // OWN tests flip `state.hasApprovedSample` to false.
    artifact: {
      findMany: async () => (state.hasApprovedSample ? [{ storageKey: "fake-sample-key" }] : []),
    },
  },
}));

// The one approved artifact the mock above ever returns is a fake storage
// key — never real S3. Stubbed here so buildApprovedSampleAssets' per-sample
// JSON.parse has real content to parse instead of hitting network/credential
// errors this test environment has none of.
vi.mock("../../services/storage.js", () => ({
  getArtifactData: async () => Buffer.from(JSON.stringify({ example_field: "a fake but well-formed sample" })),
}));

vi.mock("../../lib/rbac.js", () => ({
  ADMIN_AND_MEMBER: ["admin", "member"],
  ADMIN_AND_ABOVE_READONLY: ["admin", "member", "support"],
  // Honest enough to distinguish the two staff identities: `member`-only has
  // to actually clear RBAC before it can be refused on self-review grounds,
  // which is the whole point of covering it.
  requireRole:
    (...roles: string[]) =>
    async (req: { authedUser?: unknown }, reply: { forbidden: (m: string) => unknown }) => {
      if (!roles.some((r) => state.actor.roles.includes(r))) {
        return reply.forbidden(`Requires one of role(s): ${roles.join(", ")}`);
      }
      (req as { authedUser?: unknown }).authedUser = state.actor;
    },
}));

vi.mock("../../lib/audit-log.js", () => ({
  writeAuditLog: async (_tx: unknown, entry: Record<string, unknown>) => {
    state.auditLogs.push(entry);
  },
}));

vi.mock("../../services/karma.js", async () => {
  // Only KARMA_RULES/getKarmaRules/awardKarma need test doubles (they touch
  // state/DB); createBountyKarmaQuote is pure (no I/O — see its own doc
  // comment), so the real implementation is pulled in via importActual
  // rather than re-stubbed, so this mock can't silently drift from it the
  // way it did when the mint routes started calling it and this file didn't
  // know the name existed (every mint call threw `createBountyKarmaQuote is
  // not a function`, turning every 201 in this suite into a 500).
  const actual = await vi.importActual<typeof import("../../services/karma.js")>("../../services/karma.js");
  return {
    ...actual,
    KARMA_RULES: DEFAULT_KARMA_RULES,
    getKarmaRules: async () => ({ rules: state.karmaRules, source: "stored" as const }),
    awardKarma: async (_tx: unknown, award: Record<string, unknown>) => {
      state.karmaAwards.push(award);
    },
  };
});

vi.mock("../../services/notifications.js", () => ({
  notifyEvent: async (_tx: unknown, type: string) => {
    state.notifications.push(type);
  },
  emitNewWorkMatches: async (bounty: { id: string }) => {
    state.newWorkAlerts.push(bounty.id);
  },
}));

vi.mock("../../services/artifacts.js", () => ({
  buildSampleGate: async () => ({ required: 0, provided: 0, satisfied: true }),
}));

vi.mock("../../services/community-publish.js", () => ({
  attestPublication: noop,
  enqueueCommunityPublish: noop,
  enqueueCommunityUnpublish: noop,
}));

const { adminCommunityRoutes } = await import("./admin-community.js");

let app: FastifyInstance;

const NOTE = "Reviewed against the open-program checklist.";

/** The four write routes an actor can reach on someone's dataset request. */
const WRITE_ROUTES = [
  {
    name: "POST /community/requests/:id/decision",
    url: (id: string) => `/community/requests/${id}/decision`,
    payload: { decision: "approved", adminNote: NOTE },
    selfMessage: "you cannot review your own dataset request",
  },
  {
    name: "POST /dataset-requests/:id/review (legacy)",
    url: (id: string) => `/dataset-requests/${id}/review`,
    payload: { status: "approved", adminNote: NOTE },
    selfMessage: "you cannot review your own dataset request",
  },
  {
    name: "POST /dataset-requests/:id/mint (legacy)",
    url: (id: string) => `/dataset-requests/${id}/mint`,
    payload: {
      title: "Function-calling traces for tool routing",
      description: "A community corpus of function-calling traces for tool-routing evaluation.",
      targetItems: 100,
    },
    selfMessage: "you cannot mint a community pool from your own dataset request",
  },
  {
    name: "POST /community/requests/:id/implement",
    url: (id: string) => `/community/requests/${id}/implement`,
    payload: { targetItems: 100 },
    selfMessage: "you cannot implement your own dataset request",
  },
] as const;

beforeEach(async () => {
  state.actor = { id: "reviewer-1", roles: ["admin"], apiKeyScopes: undefined };
  state.requests = new Map();
  state.bounties = [];
  state.karmaAwards = [];
  state.auditLogs = [];
  state.notifications = [];
  state.newWorkAlerts = [];
  state.txOps = [];
  state.enforceRowLocks = true;
  state.karmaRules = DEFAULT_KARMA_RULES;
  state.hasApprovedSample = true;
  state.bountySeq = 0;
  lockQueues.clear();

  app = Fastify();
  await app.register(import("@fastify/sensible"));
  await app.register(adminCommunityRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

/* ======================================================================= *
 * 1. Conflict of interest — a reviewer cannot act on their OWN request
 * ======================================================================= */
describe("self-review is refused on every write route, under both staff identities", () => {
  for (const roles of [["admin"], ["member"]]) {
    for (const route of WRITE_ROUTES) {
      it(`${route.name} refuses the requester acting as ${roles[0]}`, async () => {
        state.actor = { id: "sponsor-1", roles, apiKeyScopes: undefined };
        // `approved` so nothing but the conflict-of-interest gate can be what
        // stops the mint/implement routes — the status gate would 409 first
        // otherwise, and the test would pass for the wrong reason.
        const row = makeRequest({ requesterUserId: "sponsor-1", status: DatasetRequestStatus.approved });

        const res = await app.inject({ method: "POST", url: route.url(row.id), payload: route.payload });

        expect(res.statusCode).toBe(403);
        expect(res.json().message).toBe(route.selfMessage);
        // Nothing happened: no status change, no karma, no pool, no audit row.
        expect(state.requests.get(row.id)!.status).toBe(DatasetRequestStatus.approved);
        expect(state.requests.get(row.id)!.reviewedBy).toBeNull();
        expect(state.requests.get(row.id)!.mintedBountyId).toBeNull();
        expect(state.karmaAwards).toHaveLength(0);
        expect(state.bounties).toHaveLength(0);
        expect(state.auditLogs).toHaveLength(0);
        expect(state.newWorkAlerts).toHaveLength(0);
      });
    }
  }

  it("still lets a DIFFERENT reviewer approve and mint the same request — the gate is identity-scoped, not a blanket deny", async () => {
    const row = makeRequest({ requesterUserId: "sponsor-1", status: DatasetRequestStatus.submitted });
    state.actor = { id: "reviewer-1", roles: ["member"], apiKeyScopes: undefined };

    const approve = await app.inject({
      method: "POST",
      url: `/community/requests/${row.id}/decision`,
      payload: { decision: "approved", adminNote: NOTE },
    });
    expect(approve.statusCode).toBe(200);
    expect(state.karmaAwards).toHaveLength(1);
    expect(state.karmaAwards[0]!.userId).toBe("sponsor-1");

    const mint = await app.inject({
      method: "POST",
      url: `/community/requests/${row.id}/implement`,
      payload: { targetItems: 100 },
    });
    expect(mint.statusCode).toBe(201);
    expect(state.bounties).toHaveLength(1);
    expect(state.requests.get(row.id)!.status).toBe(DatasetRequestStatus.implemented);
  });

  it("refuses the requester on /implement even when the pool is ALREADY minted, so self-access cannot ride the idempotent replay", async () => {
    const row = makeRequest({
      requesterUserId: "sponsor-1",
      status: DatasetRequestStatus.implemented,
      mintedBountyId: "bounty_pre",
    });
    state.bounties.push({ id: "bounty_pre", targetItems: 100n, acceptedItems: 0n, finalAcceptedItems: 0n });
    state.actor = { id: "sponsor-1", roles: ["admin"], apiKeyScopes: undefined };

    const res = await app.inject({ method: "POST", url: `/community/requests/${row.id}/implement`, payload: { targetItems: 100 } });

    expect(res.statusCode).toBe(403);
    expect(state.txOps).not.toContain("replay-bounty:bounty_pre");
  });
});

/* ======================================================================= *
 * 2. State-transition guard — `implemented` is terminal on BOTH routes
 * ======================================================================= */
describe("`implemented` is terminal on both admin decision routes", () => {
  const canonical = (id: string, decision: string) => ({
    method: "POST" as const,
    url: `/community/requests/${id}/decision`,
    payload: { decision, adminNote: NOTE },
  });
  const legacy = (id: string, status: string) => ({
    method: "POST" as const,
    url: `/dataset-requests/${id}/review`,
    payload: { status, adminNote: NOTE },
  });

  for (const decision of ["declined", "under_review", "changes_requested", "approved"]) {
    it(`canonical /decision refuses implemented -> ${decision}`, async () => {
      const row = makeRequest({ status: DatasetRequestStatus.implemented, mintedBountyId: "bounty_live" });

      const res = await app.inject(canonical(row.id, decision));

      expect(res.statusCode).toBe(409);
      const message = res.json().message as string;
      // The message must name the from-state and the attempted decision, and
      // must say WHY — this is the reply an admin console surfaces verbatim.
      expect(message).toContain('"implemented"');
      expect(message).toContain(`"${decision}"`);
      expect(message).toContain("community pool is already live");
      expect(state.requests.get(row.id)!.status).toBe(DatasetRequestStatus.implemented);
      expect(state.requests.get(row.id)!.mintedBountyId).toBe("bounty_live");
      expect(state.auditLogs).toHaveLength(0);
      expect(state.karmaAwards).toHaveLength(0);
      expect(state.notifications).toHaveLength(0);
    });
  }

  for (const status of ["declined", "changes_requested", "approved"]) {
    it(`legacy /review refuses implemented -> ${status}`, async () => {
      const row = makeRequest({ status: DatasetRequestStatus.implemented, mintedBountyId: "bounty_live" });

      const res = await app.inject(legacy(row.id, status));

      expect(res.statusCode).toBe(409);
      const message = res.json().message as string;
      expect(message).toContain('"implemented"');
      expect(message).toContain(`"${status}"`);
      expect(message).toContain("community pool is already live");
      expect(state.requests.get(row.id)!.status).toBe(DatasetRequestStatus.implemented);
      expect(state.auditLogs).toHaveLength(0);
    });
  }

  it("takes the row lock BEFORE reading, so the transition decision cannot be made on a stale read", async () => {
    const row = makeRequest({ status: DatasetRequestStatus.implemented });
    await app.inject(canonical(row.id, "declined"));
    expect(state.txOps[0]).toBe(`lock:${row.id}`);
    expect(state.txOps[1]).toMatch(/^read:/);
  });

  it("the exact reported rollback chain implemented -> declined -> under_review is refused at the first step", async () => {
    const row = makeRequest({ status: DatasetRequestStatus.implemented, mintedBountyId: "bounty_live" });

    expect((await app.inject(canonical(row.id, "declined"))).statusCode).toBe(409);
    expect(state.requests.get(row.id)!.status).toBe(DatasetRequestStatus.implemented);
    expect((await app.inject(canonical(row.id, "under_review"))).statusCode).toBe(409);
    expect(state.requests.get(row.id)!.status).toBe(DatasetRequestStatus.implemented);
  });
});

describe("the transition table is a table, not a blanket deny", () => {
  const legal: [DatasetRequestStatus, string][] = [
    [DatasetRequestStatus.submitted, "under_review"],
    [DatasetRequestStatus.submitted, "approved"],
    [DatasetRequestStatus.submitted, "declined"],
    [DatasetRequestStatus.submitted, "changes_requested"],
    [DatasetRequestStatus.under_review, "approved"],
    [DatasetRequestStatus.under_review, "declined"],
    [DatasetRequestStatus.under_review, "changes_requested"],
    [DatasetRequestStatus.changes_requested, "approved"],
    [DatasetRequestStatus.changes_requested, "declined"],
    // Approval freezes the sample set, so this one backwards edge is what lets
    // an admin reopen a request the sponsor could otherwise never repair.
    [DatasetRequestStatus.approved, "changes_requested"],
  ];
  for (const [from, to] of legal) {
    it(`allows ${from} -> ${to}`, async () => {
      const row = makeRequest({ status: from });
      const res = await app.inject({
        method: "POST",
        url: `/community/requests/${row.id}/decision`,
        payload: { decision: to, adminNote: NOTE },
      });
      expect(res.statusCode).toBe(200);
      expect(state.requests.get(row.id)!.status).toBe(to);
    });
  }

  const illegal: [DatasetRequestStatus, string][] = [
    [DatasetRequestStatus.approved, "approved"],
    [DatasetRequestStatus.approved, "under_review"],
    [DatasetRequestStatus.approved, "declined"],
    [DatasetRequestStatus.declined, "approved"],
    [DatasetRequestStatus.declined, "under_review"],
    [DatasetRequestStatus.declined, "changes_requested"],
    [DatasetRequestStatus.changes_requested, "under_review"],
  ];
  for (const [from, to] of illegal) {
    it(`refuses ${from} -> ${to}`, async () => {
      const row = makeRequest({ status: from });
      const res = await app.inject({
        method: "POST",
        url: `/community/requests/${row.id}/decision`,
        payload: { decision: to, adminNote: NOTE },
      });
      expect(res.statusCode).toBe(409);
      expect(state.requests.get(row.id)!.status).toBe(from);
    });
  }
});

/* ======================================================================= *
 * 4. Reachability — no status may be a state a request can never leave
 * ======================================================================= */
describe("`disputed` has admin exits, so a disputed request is never stranded", () => {
  // A sponsor moves declined -> disputed themselves
  // (routes/v1/community.ts POST /requests/:id/dispute). These two rows are
  // the only way back out; without them the status would be a dead end.
  for (const decision of ["approved", "declined"]) {
    it(`resolves disputed -> ${decision}`, async () => {
      const row = makeRequest({ status: DatasetRequestStatus.disputed });
      const res = await app.inject({
        method: "POST",
        url: `/community/requests/${row.id}/decision`,
        payload: { decision, adminNote: NOTE },
      });
      expect(res.statusCode).toBe(200);
      expect(state.requests.get(row.id)!.status).toBe(decision);
    });
  }

  for (const decision of ["under_review", "changes_requested"]) {
    it(`refuses disputed -> ${decision} — a dispute is resolved, not re-triaged`, async () => {
      const row = makeRequest({ status: DatasetRequestStatus.disputed });
      const res = await app.inject({
        method: "POST",
        url: `/community/requests/${row.id}/decision`,
        payload: { decision, adminNote: NOTE },
      });
      expect(res.statusCode).toBe(409);
      expect(state.requests.get(row.id)!.status).toBe(DatasetRequestStatus.disputed);
    });
  }
});

/* ======================================================================= *
 * 3. Legacy /mint brought to /implement's gate set
 * ======================================================================= */
describe("legacy /dataset-requests/:id/mint — approved-status gate", () => {
  const mintPayload = {
    title: "Function-calling traces for tool routing",
    description: "A community corpus of function-calling traces for tool-routing evaluation.",
    targetItems: 100,
  };

  for (const status of [
    DatasetRequestStatus.submitted,
    DatasetRequestStatus.under_review,
    DatasetRequestStatus.changes_requested,
    DatasetRequestStatus.declined,
    DatasetRequestStatus.disputed,
  ]) {
    it(`refuses to mint a live public pool from a ${status} request`, async () => {
      const row = makeRequest({ status });

      const res = await app.inject({ method: "POST", url: `/dataset-requests/${row.id}/mint`, payload: mintPayload });

      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe("Only an approved request can be minted.");
      expect(state.bounties).toHaveLength(0);
      expect(state.requests.get(row.id)!.status).toBe(status);
      expect(state.requests.get(row.id)!.mintedBountyId).toBeNull();
    });
  }

  it("mints from an approved request", async () => {
    const row = makeRequest({ status: DatasetRequestStatus.approved });
    const res = await app.inject({ method: "POST", url: `/dataset-requests/${row.id}/mint`, payload: mintPayload });
    expect(res.statusCode).toBe(201);
    expect(state.bounties).toHaveLength(1);
    expect(state.requests.get(row.id)!.status).toBe(DatasetRequestStatus.implemented);
  });

  it("refuses a second mint of an already-minted request", async () => {
    const row = makeRequest({ status: DatasetRequestStatus.approved });
    expect((await app.inject({ method: "POST", url: `/dataset-requests/${row.id}/mint`, payload: mintPayload })).statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url: `/dataset-requests/${row.id}/mint`, payload: mintPayload });
    expect(second.statusCode).toBe(409);
    expect(second.json().message).toBe("Bounty already minted for this request");
    expect(state.bounties).toHaveLength(1);
  });
});

describe("no approved reference sample => refuse to mint at all (owner decision, 2026-09-09)", () => {
  const mintPayload = {
    title: "Function-calling traces for tool routing",
    description: "A community corpus of function-calling traces for tool-routing evaluation.",
    targetItems: 100,
  };

  it("legacy /dataset-requests/:id/mint refuses with 409 and creates no bounty", async () => {
    state.hasApprovedSample = false;
    const row = makeRequest({ status: DatasetRequestStatus.approved });

    const res = await app.inject({ method: "POST", url: `/dataset-requests/${row.id}/mint`, payload: mintPayload });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe(
      "This request has no approved reference example yet — a pool cannot launch until at least one sponsor_reference sample has been reviewed and approved (Open Program → review samples)."
    );
    expect(state.bounties).toHaveLength(0);
    expect(state.requests.get(row.id)!.status).toBe(DatasetRequestStatus.approved);
    expect(state.requests.get(row.id)!.mintedBountyId).toBeNull();
  });

  it("/community/requests/:id/implement refuses with 409 and creates no bounty", async () => {
    state.hasApprovedSample = false;
    const row = makeRequest({ status: DatasetRequestStatus.approved });

    const res = await app.inject({ method: "POST", url: `/community/requests/${row.id}/implement`, payload: { targetItems: 100 } });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe(
      "This request has no approved reference example yet — a program cannot launch until at least one sponsor_reference sample has been reviewed and approved (Open Program → review samples)."
    );
    expect(state.bounties).toHaveLength(0);
    expect(state.requests.get(row.id)!.status).toBe(DatasetRequestStatus.approved);
    expect(state.requests.get(row.id)!.mintedBountyId).toBeNull();
  });

  it("mints normally once an approved sample exists — the gate is not stuck closed", async () => {
    state.hasApprovedSample = true;
    const row = makeRequest({ status: DatasetRequestStatus.approved });

    const res = await app.inject({ method: "POST", url: `/dataset-requests/${row.id}/mint`, payload: mintPayload });

    expect(res.statusCode).toBe(201);
    expect(state.bounties).toHaveLength(1);
  });
});

describe("legacy /dataset-requests/:id/mint — karmaPerAcceptedItem is bounded by the LIVE karma scale", () => {
  const mintPayload = (over: Record<string, unknown> = {}) => ({
    title: "Function-calling traces for tool routing",
    description: "A community corpus of function-calling traces for tool-routing evaluation.",
    targetItems: 100,
    ...over,
  });

  it("refuses 50000 — the rate that shipped a pool granting the top karma tier per accepted item", async () => {
    const row = makeRequest({ status: DatasetRequestStatus.approved });

    const res = await app.inject({
      method: "POST",
      url: `/dataset-requests/${row.id}/mint`,
      payload: mintPayload({ karmaPerAcceptedItem: 50_000 }),
    });

    expect(res.statusCode).toBe(409);
    // The bound must name the live ceiling, not just say "too high".
    expect(res.json().message).toContain("60 per item");
    expect(state.bounties).toHaveLength(0);
    expect(state.requests.get(row.id)!.mintedBountyId).toBeNull();
  });

  it("refuses one above the ceiling and accepts exactly the ceiling", async () => {
    const over = makeRequest({ status: DatasetRequestStatus.approved });
    expect(
      (await app.inject({ method: "POST", url: `/dataset-requests/${over.id}/mint`, payload: mintPayload({ karmaPerAcceptedItem: 61 }) })).statusCode
    ).toBe(409);

    const at = makeRequest({ status: DatasetRequestStatus.approved });
    const res = await app.inject({ method: "POST", url: `/dataset-requests/${at.id}/mint`, payload: mintPayload({ karmaPerAcceptedItem: 60 }) });
    expect(res.statusCode).toBe(201);
    expect(res.json().bounty.karmaPerAcceptedItem).toBe(60);
  });

  it("rejects a zero or negative rate at the schema boundary", async () => {
    const row = makeRequest({ status: DatasetRequestStatus.approved });
    for (const rate of [0, -1]) {
      const res = await app.inject({ method: "POST", url: `/dataset-requests/${row.id}/mint`, payload: mintPayload({ karmaPerAcceptedItem: rate }) });
      expect(res.statusCode).toBe(400);
    }
    expect(state.bounties).toHaveLength(0);
  });

  it("tracks the operator's configured scale rather than a hardcoded 60", async () => {
    // The bound is deliberately runtime, not a static `.max()`: an operator who
    // legally raises the advanced accepted-item rate must still be able to mint
    // against it. If this ever becomes a literal, this test fails.
    state.karmaRules = { ...DEFAULT_KARMA_RULES, acceptedItem: { beginner: 10, intermediate: 25, advanced: 500 } };

    const ok = makeRequest({ status: DatasetRequestStatus.approved });
    expect(
      (await app.inject({ method: "POST", url: `/dataset-requests/${ok.id}/mint`, payload: mintPayload({ karmaPerAcceptedItem: 500 }) })).statusCode
    ).toBe(201);

    const tooHigh = makeRequest({ status: DatasetRequestStatus.approved });
    const res = await app.inject({ method: "POST", url: `/dataset-requests/${tooHigh.id}/mint`, payload: mintPayload({ karmaPerAcceptedItem: 501 }) });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("500 per item");
  });

  it("resolves an omitted rate from the request's OWN difficulty mix, not a flat default", async () => {
    const advanced = makeRequest({ status: DatasetRequestStatus.approved, difficultyMix: "mostly_advanced" });
    const a = await app.inject({ method: "POST", url: `/dataset-requests/${advanced.id}/mint`, payload: mintPayload() });
    expect(a.json().bounty.karmaPerAcceptedItem).toBe(60);
    expect(a.json().bounty.poolDifficulty).toBe("advanced");

    const beginner = makeRequest({ status: DatasetRequestStatus.approved, difficultyMix: "mostly_beginner" });
    const b = await app.inject({ method: "POST", url: `/dataset-requests/${beginner.id}/mint`, payload: mintPayload() });
    expect(b.json().bounty.karmaPerAcceptedItem).toBe(10);
    expect(b.json().bounty.poolDifficulty).toBe("beginner");
  });
});

/* ======================================================================= *
 * 3b. Concurrency invariant — one request, one pool
 * ======================================================================= */
describe("concurrent mints of one request produce exactly one public pool", () => {
  const mintPayload = {
    title: "Function-calling traces for tool routing",
    description: "A community corpus of function-calling traces for tool-routing evaluation.",
    targetItems: 100,
  };

  async function eightWay(url: (id: string) => string, payload: Record<string, unknown>) {
    const row = makeRequest({ status: DatasetRequestStatus.approved });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => app.inject({ method: "POST", url: url(row.id), payload }))
    );
    return { row, codes: results.map((r) => r.statusCode) };
  }

  it("legacy /mint: 8 simultaneous calls -> 1 created, 7 refused, 1 bounty", async () => {
    const { row, codes } = await eightWay((id) => `/dataset-requests/${id}/mint`, mintPayload);

    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(7);
    expect(state.bounties).toHaveLength(1);
    expect(state.requests.get(row.id)!.mintedBountyId).toBe(state.bounties[0]!.id);
    expect(state.requests.get(row.id)!.status).toBe(DatasetRequestStatus.implemented);
  });

  it("/implement: 8 simultaneous calls -> 1 bounty, the losers replay the same one", async () => {
    const { row, codes } = await eightWay((id) => `/community/requests/${id}/implement`, { targetItems: 100 });

    // /implement is idempotent by design, so every caller gets a 2xx — but
    // only ONE bounty may exist, and every response must name that same one.
    expect(state.bounties).toHaveLength(1);
    expect(codes.every((c) => c === 201)).toBe(true);
    expect(state.requests.get(row.id)!.mintedBountyId).toBe(state.bounties[0]!.id);
    // The watch alert fires once, on the transaction that actually minted.
    expect(state.newWorkAlerts).toEqual([state.bounties[0]!.id]);
  });

  it("CONTROL: with the row lock not honoured, the same 8 calls mint 8 pools — so the test above is not vacuous", async () => {
    state.enforceRowLocks = false;

    const { codes } = await eightWay((id) => `/dataset-requests/${id}/mint`, mintPayload);

    // This is precisely the reported defect: 8 live public pools, 7 orphaned.
    expect(state.bounties.length).toBeGreaterThan(1);
    expect(codes.filter((c) => c === 201).length).toBeGreaterThan(1);
  });

  it("takes the lock, then reads, then creates — all inside ONE transaction, so the minted check cannot go stale", async () => {
    const row = makeRequest({ status: DatasetRequestStatus.approved });
    await app.inject({ method: "POST", url: `/dataset-requests/${row.id}/mint`, payload: mintPayload });

    expect(state.txOps).toEqual([
      `lock:${row.id}`,
      `read:${row.id}:approved:minted=-`,
      "create-bounty:bounty_1",
      `update:${row.id}:implemented`,
    ]);
  });
});

/* ======================================================================= *
 * 4. /community/requests/:id/implement — communityLicenseUrl is derived,
 *    not left null
 *
 * Live-reproduced same-day: /implement carries `request.proposedLicense`
 * onto `Bounty.communityLicense` (unlike the legacy mint route above, it
 * takes no licence in its own request body — `implementBody` is
 * `{ targetItems }` only) but never set `Bounty.communityLicenseUrl`, so
 * every request-minted community pool published with a licence NAME and no
 * licence URL, forever — nothing downstream re-derives it after mint.
 * Confirmed live against a real Postgres-backed run (fix11_lic_* rows,
 * cleaned up after) before this test was written: POST /implement returned
 * `"communityLicense":"ODC-By-1.0","communityLicenseUrl":null`.
 * ======================================================================= */
describe("/community/requests/:id/implement — communityLicenseUrl is derived from the request's own licence", () => {
  const implementPayload = { targetItems: 100 };

  it("derives communityLicenseUrl from the request's proposedLicense (default CC-BY-4.0)", async () => {
    const row = makeRequest({ status: DatasetRequestStatus.approved });
    const res = await app.inject({ method: "POST", url: `/community/requests/${row.id}/implement`, payload: implementPayload });

    expect(res.statusCode).toBe(201);
    expect(res.json().bounty.communityLicense).toBe("CC-BY-4.0");
    expect(res.json().bounty.communityLicenseUrl).toBe(datasetLicense("CC-BY-4.0")!.url);
    expect(res.json().bounty.communityLicenseUrl).not.toBeNull();
  });

  it("derives communityLicenseUrl for a non-default bundled licence too, not just the default", async () => {
    const row = makeRequest({ status: DatasetRequestStatus.approved, proposedLicense: "ODC-By-1.0" });
    const res = await app.inject({ method: "POST", url: `/community/requests/${row.id}/implement`, payload: implementPayload });

    expect(res.statusCode).toBe(201);
    expect(res.json().bounty.communityLicense).toBe("ODC-By-1.0");
    expect(res.json().bounty.communityLicenseUrl).toBe("https://opendatacommons.org/licenses/by/1-0/");
  });

  it("an idempotent replay (already-minted request) returns the SAME bounty, url included", async () => {
    const row = makeRequest({ status: DatasetRequestStatus.approved, proposedLicense: "CC0-1.0" });
    const first = await app.inject({ method: "POST", url: `/community/requests/${row.id}/implement`, payload: implementPayload });
    const second = await app.inject({ method: "POST", url: `/community/requests/${row.id}/implement`, payload: implementPayload });

    expect(first.json().bounty.communityLicenseUrl).toBe(datasetLicense("CC0-1.0")!.url);
    expect(second.json().bounty.id).toBe(first.json().bounty.id);
    expect(second.json().bounty.communityLicenseUrl).toBe(first.json().bounty.communityLicenseUrl);
  });
});
