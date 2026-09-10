-- Data-only migration, no schema change.
--
-- Backfills `dispute_cycle_window_opens_at` for any community pool that closed
-- BEFORE the 2026-09-08 settleDueCommunityPools fix shipped and therefore never
-- had a dispute-review window opened. Without this backfill, such a pool would
-- otherwise sit `status = active` until the next pool-reconcile heartbeat
-- tick discovers it and opens the window itself (settleDueCommunityPools already
-- does exactly this self-heal at runtime, every 10 minutes) -- this migration
-- just fast-forwards that first tick so a fresh deploy settles pre-existing
-- stuck pools on its own schedule instead of waiting on the next heartbeat.
--
-- Matches the runtime guard exactly: only touches active, closed, unsettled
-- community pools, and skips any pool with a currently open dispute (a dispute
-- being live means the pool is not actually clean, whatever this backfill would
-- otherwise do).
UPDATE bounties
SET dispute_cycle_window_opens_at = now()
WHERE kind = 'community'
  AND status = 'active'
  AND pool_closed_at IS NOT NULL
  AND dispute_cycle_window_opens_at IS NULL
  AND dispute_cycle_settled_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM disputes d WHERE d.bounty_id = bounties.id AND d.status = 'open'
  );
