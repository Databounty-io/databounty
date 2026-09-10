// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SubmissionStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { karmaTierForBalance } from "../../services/karma.js";

const sitemapQuery = z.object({
  cursor: z.string().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

/**
 * Public, anonymous profile-by-handle — no auth required. Backs both the
 * landing public-profile page and community/apps/admin's /open-leaderboard
 * row expander (its own comment: "Same public, anonymous endpoint the
 * landing profile page reads"). Every optional section is gated on the
 * member's own `User.publicProfilePrefs` (showKarma/showBadges/
 * showDatasets/showActivity — the same prefs GET /v1/me/public-profile
 * reads/writes), never shown just because the caller is an admin: an admin
 * sees exactly what a logged-out visitor would see, nothing more.
 */
export async function profileRoutes(app: FastifyInstance) {
  // Bounded, privacy-safe feed of public-profile handles for landing's
  // sitemap.ts — ported verbatim from databounty-api/src/routes/v1/
  // profiles.ts:13-25 (missing here until now, silently 404ing and making
  // landing's sitemap quietly omit every profile URL — found by a parity
  // audit 2026-09-01). Uses `profilePublic` + `handle` the same way
  // `/handle/:handle` below does — no separate launch-flag gate exists in
  // this codebase's profiles.ts, unlike v1's `isLaunchFeatureEnabled` check.
  app.get("/sitemap", async (req, reply) => {
    const parsed = sitemapQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest("invalid sitemap query");
    const rows = await prisma.user.findMany({
      where: {
        profilePublic: true,
        handle: { not: null, ...(parsed.data.cursor ? { gt: parsed.data.cursor } : {}) },
      },
      select: { handle: true, updatedAt: true },
      orderBy: { handle: "asc" },
      take: parsed.data.limit + 1,
    });
    const page = rows.slice(0, parsed.data.limit);
    return reply.send({
      profiles: page.map((row) => ({ handle: row.handle!, lastModified: row.updatedAt.toISOString() })),
      nextCursor: rows.length > parsed.data.limit ? (page.at(-1)?.handle ?? null) : null,
    });
  });

  app.get("/handle/:handle", async (req, reply) => {
    const { handle } = req.params as { handle: string };

    const user = await prisma.user.findUnique({
      where: { handle: handle.toLowerCase() },
      select: {
        id: true,
        displayName: true,
        handle: true,
        profilePublic: true,
        publicProfilePrefs: true,
        karmaTotal: true,
        createdAt: true,
      },
    });

    if (!user || !user.handle || !user.profilePublic) {
      return reply.notFound("Profile not found or not public");
    }

    const prefs = (user.publicProfilePrefs as Record<string, unknown> | null) ?? {};
    const showKarma = typeof prefs.showKarma === "boolean" ? prefs.showKarma : true;
    const showBadges = typeof prefs.showBadges === "boolean" ? prefs.showBadges : true;
    const showDatasets = typeof prefs.showDatasets === "boolean" ? prefs.showDatasets : true;
    const showActivity = typeof prefs.showActivity === "boolean" ? prefs.showActivity : true;

    const body: Record<string, unknown> = {
      handle: user.handle,
      displayName: user.displayName || undefined,
      memberSince: user.createdAt.toISOString(),
      publishedCredits: [] as { title: string; hfSlug: string; hfUrl: string }[],
    };

    // SEC-10: `showKarma` is the "karma & tier" toggle the member sees in the
    // dashboard (apps/web/app/(app)/profile/page.tsx), so it has to gate BOTH
    // fields. Previously `tier` was emitted unconditionally and only the
    // numeric `karma` was hidden, which meant a profile with every disclosure
    // toggle off still published a derived reputation category (executed
    // evidence: tier `moksha` returned with `karma` absent). The tier is
    // computed inside this branch as well, so an all-off profile does not even
    // read the karma matrix. Consumers must treat `tier` as optional — see
    // apps/landing/lib/public-data.ts.
    if (showKarma) {
      const tier = karmaTierForBalance(user.karmaTotal);
      body.tier = { id: tier.tier, label: tier.label, color: tier.color };
      body.karma = user.karmaTotal;
    }

    if (showBadges) {
      const awards = await prisma.userBadge.findMany({
        where: { userId: user.id },
        include: { badge: true },
        orderBy: { earnedAt: "desc" },
      });
      body.badges = awards.map((a) => ({ id: a.badge.id, family: a.badge.family, label: a.badge.label }));
    }

    if (showActivity) {
      const [acceptedItems, rank] = await Promise.all([
        prisma.submission.count({ where: { contributorUserId: user.id, status: SubmissionStatus.accepted } }),
        prisma.rank.findUnique({ where: { userId: user.id }, select: { auditsCompleted: true } }),
      ]);
      body.acceptedItems = acceptedItems;
      // No pipeline in this API increments a per-validator audit counter yet
      // (see services/profile-summary.ts's comment on the same gap) — this
      // honestly reads 0 from the real Rank row rather than fabricating one.
      body.audits = rank?.auditsCompleted ?? 0;
    }

    if (showDatasets) {
      const accepted = await prisma.submission.findMany({
        where: { contributorUserId: user.id, status: SubmissionStatus.accepted },
        select: { bountyId: true },
      });
      const bountyIds = [...new Set(accepted.map((s) => s.bountyId).filter((id): id is string => id !== null))];
      const itemsByBounty = new Map<string, number>();
      for (const s of accepted) {
        if (!s.bountyId) continue;
        itemsByBounty.set(s.bountyId, (itemsByBounty.get(s.bountyId) ?? 0) + 1);
      }

      if (bountyIds.length > 0) {
        const bounties = await prisma.bounty.findMany({
          where: { id: { in: bountyIds } },
          select: {
            id: true,
            title: true,
            publications: {
              where: { target: "huggingface", status: "published", externalId: { not: null } },
              select: { externalId: true, url: true },
              take: 1,
            },
          },
          take: 50,
        });

        body.datasets = bounties.map((b) => ({ id: b.id, title: b.title, items: itemsByBounty.get(b.id) ?? 0 }));
        body.datasetsContributed = bounties.length;
        body.publishedCredits = bounties
          .filter((b) => b.publications.length > 0 && b.publications[0]!.url)
          .map((b) => ({ title: b.title, hfSlug: b.publications[0]!.externalId ?? "", hfUrl: b.publications[0]!.url! }));
      } else {
        body.datasets = [];
        body.datasetsContributed = 0;
      }
    }

    return reply.send(body);
  });
}
