// SPDX-License-Identifier: Apache-2.0

/**
 * The anonymous public profile, `GET /v1/profiles/handle/:handle`, sent each
 * badge's raw catalog label, so databounty.io profile pages read
 * "{value} audits completed". Labels must arrive rendered: the amount measured
 * when the badge was awarded, or the threshold the badge certifies when no
 * amount was recorded.
 *
 * Same harness as profiles.tier-disclosure.test.ts: the real route module on a
 * real Fastify instance, with a `prisma` double returning fixed rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../../services/karma.js", () => ({
  karmaTierForBalance: () => ({ tier: "dharma", label: "Dharma", color: "#8a9382" }),
}));

vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: async () => ({
        id: "user-1",
        displayName: "Badge Holder",
        handle: "badge-holder",
        profilePublic: true,
        publicProfilePrefs: null,
        karmaTotal: 10,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
      findMany: async () => [],
    },
    userBadge: {
      findMany: async () => [
        {
          measuredValue: 512,
          badge: { id: "bdg_items_500", family: "build", label: "{value} items accepted", metric: "accepted_items", threshold: 500 },
        },
        {
          measuredValue: null,
          badge: { id: "bdg_audits_100", family: "audit", label: "{value} audits completed", metric: "completed_audits", threshold: 100 },
        },
        {
          measuredValue: null,
          badge: { id: "bdg_top_10", family: "platform", label: "Top 10 all time", metric: "leaderboard_rank", threshold: 10 },
        },
      ],
    },
    submission: { count: async () => 0, findMany: async () => [] },
    rank: { findUnique: async () => null },
    bounty: { findMany: async () => [] },
  },
}));

const { profileRoutes } = await import("./profiles.js");

let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify();
  await app.register(import("@fastify/sensible"));
  await app.register(profileRoutes, { prefix: "/v1/profiles" });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("public profile badges arrive rendered", () => {
  it("fills {value} from the award, or from the threshold when none was recorded", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/profiles/handle/badge-holder" });
    expect(res.statusCode).toBe(200);
    const labels = (res.json().badges as { label: string }[]).map((b) => b.label);
    expect(labels).toEqual(["512 items accepted", "100 audits completed", "Top 10 all time"]);
    expect(res.body).not.toContain("{value}");
  });
});
