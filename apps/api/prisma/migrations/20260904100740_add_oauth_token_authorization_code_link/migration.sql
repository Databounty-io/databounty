-- Traces an OAuth access/refresh token back to the authorization code that
-- minted it (null for refresh-minted tokens, and for every pre-existing
-- row). Lets a REPLAYED authorization code (OAuth 2.1 §4.1.3 / §7.5.3: a
-- code presented again after it was already consumed) revoke exactly the
-- tokens that code produced, rather than the replay being a no-op refusal
-- that leaves a possibly-stolen token pair fully alive.
--
-- ON DELETE SET NULL, not RESTRICT or CASCADE: cleanupMcpOAuth's sweep must
-- remain free to delete a code row once every token it names is gone, and it
-- must never delete a LIVE token as a side effect of pruning the code that
-- once minted it. See the Prisma model doc comments for the full rationale.
ALTER TABLE "oauth_access_tokens" ADD COLUMN "authorization_code_id" TEXT;
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "authorization_code_id" TEXT;

CREATE INDEX "oauth_access_tokens_authorization_code_id_idx" ON "oauth_access_tokens"("authorization_code_id");
CREATE INDEX "oauth_refresh_tokens_authorization_code_id_idx" ON "oauth_refresh_tokens"("authorization_code_id");

ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_authorization_code_id_fkey"
  FOREIGN KEY ("authorization_code_id") REFERENCES "oauth_authorization_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_authorization_code_id_fkey"
  FOREIGN KEY ("authorization_code_id") REFERENCES "oauth_authorization_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
