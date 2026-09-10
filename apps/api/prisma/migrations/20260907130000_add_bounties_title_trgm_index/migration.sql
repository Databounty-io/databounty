-- Trigram index for bounty title search.
--
-- The admin, sponsor and pool listings search titles with `title ILIKE '%q%'`.
-- A leading-wildcard LIKE cannot use a btree index at all, so that search has
-- always been a sequential scan over `bounties`. pg_trgm + a GIN index lets
-- Postgres use trigram matching instead.
--
-- Why this is a fresh migration rather than a port: V1 added the same index in
-- 20260718014500_add_bounties_title_trgm_index but did NOT declare it in
-- schema.prisma. Because the datamodel did not know about it, the next
-- `prisma migrate dev` treated it as an unknown database object and
-- auto-emitted `DROP INDEX "bounties_title_trgm_idx"` at the top of an
-- unrelated migration (20260718043145_add_submission_lsh_bands), destroying it
-- 2h46m after it was created. It therefore exists in no V1 environment, and it
-- was never created in this tree at all.
--
-- The index IS now declared on the Bounty model in schema.prisma. Keep it
-- there: deleting that declaration re-arms exactly the same auto-DROP.
--
-- Cost: a plain CREATE INDEX is correct here. `bounties` is small, and
-- CONCURRENTLY cannot run inside the transaction Prisma wraps a migration in.
-- If this table ever grows large, build future indexes on it concurrently in a
-- separate, non-transactional step.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "bounties_title_trgm_idx"
  ON "bounties" USING GIN ("title" gin_trgm_ops);
