// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { verifyOAuthState } from "../../lib/profile-source-crypto.js";
import { completeOAuthConnect, oauthCapableKinds, type OAuthCapableKind } from "../../services/profile-source-oauth.js";

/**
 * Public redirect target for the GitHub/ORCID authorization-code flow
 * (`services/profile-source-oauth.ts` builds the matching authorize URL in
 * `POST /me/profile-sources/:id/connect`). No session auth here on purpose —
 * this is a full-page browser redirect from the provider, not a fetch call,
 * and the signed `state` param (not the request's own cookies) is what
 * proves which DataBounty account started the flow.
 */
export async function profileSourceOAuthRoutes(app: FastifyInstance) {
  app.get("/:provider/callback", async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const query = req.query as { code?: string; state?: string; error?: string };

    if (!oauthCapableKinds().includes(provider as OAuthCapableKind)) {
      return reply.redirect(`${config.appUrl}/profile?connect_error=${encodeURIComponent(provider)}`);
    }
    if (query.error || !query.code || !query.state) {
      return reply.redirect(`${config.appUrl}/profile?connect_error=${encodeURIComponent(provider)}`);
    }
    const verified = verifyOAuthState(query.state, provider);
    if (!verified) {
      return reply.redirect(`${config.appUrl}/profile?connect_error=${encodeURIComponent(provider)}`);
    }

    const ok = await completeOAuthConnect(req, provider as OAuthCapableKind, verified.userId, query.code);
    return reply.redirect(
      ok ? `${config.appUrl}/profile?connected=${encodeURIComponent(provider)}` : `${config.appUrl}/profile?connect_error=${encodeURIComponent(provider)}`
    );
  });
}
