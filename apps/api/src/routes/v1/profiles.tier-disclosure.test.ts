// SPDX-License-Identifier: Apache-2.0

/**
 * SEC-10 regression suite — hiding "karma & tier" must hide the tier too.
 *
 * The finding: `GET /v1/profiles/handle/:handle` returned `tier`
 * unconditionally and gated only the numeric `karma` field on the member's
 * `showKarma` preference — the very preference the dashboard labels
 * "karma & tier" (`apps/web/app/(app)/profile/page.tsx:28`). Executed
 * evidence: a dummy public profile with every disclosure toggle false still
 * returned tier `moksha`, with `karma` absent. A frontend-only fix would have
 * left the API disclosure intact, so the assertions below are against the
 * anonymous HTTP payload.
 *
 * How this file tests it: the REAL route module is loaded and registered on a
 * real Fastify instance and driven with `app.inject()` — no Postgres, no
 * `.env`. The `prisma` double returns fixed rows for the handful of reads
 * this route performs; the karma-matrix lookup is a spy so the suite can also
 * prove it is not consulted at all for a hidden profile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

type Prefs = {
  showKarma?: boolean;
  showBadges?: boolean;
  showDatasets?: boolean;
  showActivity?: boolean;
};

/** Mutable test state, reset per test. */
const state: {
  handle: string | null;
  profilePublic: boolean;
  prefs: Prefs | null;
  karmaTotal: number;
} = {
  handle: "dummy-member",
  profilePublic: true,
  prefs: null,
  karmaTotal: 12_345,
};

const karmaTierForBalance = vi.fn(() => ({ tier: "moksha", label: "Moksha", color: "#a3f60a" }));

vi.mock("../../services/karma.js", () => ({ karmaTierForBalance }));

vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { handle: string } }) => {
        if (state.handle === null || where.handle !== state.handle) return null;
        return {
          id: "user-1",
          displayName: "Dummy Member",
          handle: state.handle,
          profilePublic: state.profilePublic,
          publicProfilePrefs: state.prefs,
          karmaTotal: state.karmaTotal,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        };
      },
      findMany: async () => [],
    },
    userBadge: {
      findMany: async () => [{ badge: { id: "b1", family: "build", label: "first_build" } }],
    },
    submission: {
      count: async () => 7,
      findMany: async () => [{ bountyId: "bounty-1" }],
    },
    rank: { findUnique: async () => ({ auditsCompleted: 0 }) },
    bounty: {
      findMany: async () => [{ id: "bounty-1", title: "Dummy pool", publications: [] }],
    },
  },
}));

const { profileRoutes } = await import("./profiles.js");

let app: FastifyInstance;

beforeEach(async () => {
  state.handle = "dummy-member";
  state.profilePublic = true;
  state.prefs = null;
  state.karmaTotal = 12_345;
  karmaTierForBalance.mockClear();
  app = Fastify();
  await app.register(import("@fastify/sensible"));
  await app.register(profileRoutes, { prefix: "/v1/profiles" });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const get = () => app.inject({ method: "GET", url: "/v1/profiles/handle/dummy-member" });

const ALL_OFF: Prefs = { showKarma: false, showBadges: false, showDatasets: false, showActivity: false };
const ALL_ON: Prefs = { showKarma: true, showBadges: true, showDatasets: true, showActivity: true };

describe("SEC-10 · the anonymous payload gates tier and karma together", () => {
  it("omits BOTH fields when every disclosure toggle is off", async () => {
    state.prefs = ALL_OFF;
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The exact symptom of the finding: tier `moksha` came back here.
    expect(body).not.toHaveProperty("tier");
    expect(body).not.toHaveProperty("karma");
    // Nothing else regressed: the handle-level fields are still public.
    expect(body.handle).toBe("dummy-member");
    expect(body.memberSince).toBe("2026-01-01T00:00:00.000Z");
    expect(body.publishedCredits).toEqual([]);
  });

  it("omits both when only showKarma is off, other sections on", async () => {
    state.prefs = { ...ALL_ON, showKarma: false };
    const body = (await get()).json();
    expect(body).not.toHaveProperty("tier");
    expect(body).not.toHaveProperty("karma");
    expect(body.badges).toHaveLength(1);
    expect(body.acceptedItems).toBe(7);
  });

  it("does not even consult the karma matrix for a hidden profile", async () => {
    state.prefs = ALL_OFF;
    await get();
    expect(karmaTierForBalance).not.toHaveBeenCalled();
  });

  it("includes BOTH fields when the toggle is on", async () => {
    state.prefs = ALL_ON;
    const body = (await get()).json();
    expect(body.tier).toEqual({ id: "moksha", label: "Moksha", color: "#a3f60a" });
    expect(body.karma).toBe(12_345);
    expect(karmaTierForBalance).toHaveBeenCalledWith(12_345);
  });

  it("includes both on the default (no stored prefs) — showKarma defaults to true", async () => {
    state.prefs = null;
    const body = (await get()).json();
    expect(body.tier).toEqual({ id: "moksha", label: "Moksha", color: "#a3f60a" });
    expect(body.karma).toBe(12_345);
  });

  it("treats a non-boolean stored preference as the default, not as hidden", async () => {
    state.prefs = { showKarma: "yes" as unknown as boolean };
    const body = (await get()).json();
    expect(body.tier).toBeDefined();
    expect(body.karma).toBe(12_345);
  });

  it("still 404s a profile that is not public at all", async () => {
    state.profilePublic = false;
    const res = await get();
    expect(res.statusCode).toBe(404);
  });
});
