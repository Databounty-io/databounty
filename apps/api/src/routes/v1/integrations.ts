// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { requireAuth, type AuthedUser } from "../../lib/rbac.js";
import { buildSlackAuthorizeUrl, completeSlackConnect, slackConfigured } from "../../services/slack.js";

const connectBody = z.object({ provider: z.enum(["slack", "google_chat", "microsoft_teams"]) });

export async function integrationRoutes(app: FastifyInstance) {
  // Start an OAuth "Add to <provider>" install. Only Slack has a real app
  // registered here — Google Chat and Microsoft Teams have no client
  // credentials configured, so they honestly 400 rather than issuing a
  // broken authorize URL. Both providers' users still connect the
  // webhook-URL way (POST /notifications/channels/:id/connect), same as
  // Discord — this route is Slack-only in practice.
  app.post("/connect", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = connectBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    if (parsed.data.provider !== "slack" || !slackConfigured()) {
      return reply.badRequest(`${parsed.data.provider} sign-in isn't configured on this deployment.`);
    }
    const url = buildSlackAuthorizeUrl(req, user.id);
    if (!url) return reply.badRequest("Slack sign-in isn't configured on this deployment.");
    return reply.send({ url });
  });

  // Public redirect target for Slack's "Add to Slack" consent screen — no
  // session here, same reasoning as the GitHub/ORCID callback: a full-page
  // browser redirect, not a fetch, so the signed `state` (not cookies)
  // proves which account started the flow.
  app.get("/slack/callback", async (req, reply) => {
    const query = req.query as { code?: string; state?: string; error?: string };
    if (query.error || !query.code || !query.state) {
      return reply.redirect(`${config.appUrl}/notifications?slack_error=1`);
    }
    const userId = await completeSlackConnect(req, query.state, query.code);
    return reply.redirect(userId ? `${config.appUrl}/notifications?slack_connected=1` : `${config.appUrl}/notifications?slack_error=1`);
  });
}
