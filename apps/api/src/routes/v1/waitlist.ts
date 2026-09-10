// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DomainId } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

// Ported from V1's routes/v1/waitlist.ts, adapted to this schema's
// `WaitlistEntry` model (V1's is `WaitlistSignup`, anonymous-only). This
// model additionally carries an optional `userId` (a signed-in member can be
// linked) but has no `@@unique([domain, email])` constraint the way V1's
// does, so idempotency here is a real existence check rather than relying on
// a P2002 unique-constraint catch.
//
// Anonymous, public — landing's "coming soon" domain pages (legal/
// healthcare/finance/science) capture an email to notify when a domain
// opens. No user account or session required.
const joinBody = z.object({
  domain: z.nativeEnum(DomainId),
  email: z.string().trim().toLowerCase().email().max(320),
}).strict();

export async function waitlistRoutes(app: FastifyInstance) {
  app.post("/", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = joinBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.issues[0]?.message ?? "Invalid waitlist signup.");
    const { domain, email } = parsed.data;

    const existing = await prisma.waitlistEntry.findFirst({ where: { domain, email } });
    if (!existing) {
      // Same email joining the same domain twice is a no-op from the
      // caller's point of view, not an error — never make a visitor
      // re-submit a form that already succeeded the first time.
      await prisma.waitlistEntry.create({ data: { domain, email } });
    }

    const count = await prisma.waitlistEntry.count({ where: { domain } });
    return reply.code(201).send({ domain, joined: true, count });
  });

  // GET /v1/waitlist/:domain/count — real distinct-signup count for the
  // "N people waiting" copy on the domain page. Public, cacheable; never a
  // client-only, resets-on-refresh number.
  app.get("/:domain/count", async (req, reply) => {
    const parsed = z.nativeEnum(DomainId).safeParse((req.params as { domain: string }).domain);
    if (!parsed.success) return reply.badRequest("Unknown domain.");
    const count = await prisma.waitlistEntry.count({ where: { domain: parsed.data } });
    return reply.send({ domain: parsed.data, count });
  });
}
