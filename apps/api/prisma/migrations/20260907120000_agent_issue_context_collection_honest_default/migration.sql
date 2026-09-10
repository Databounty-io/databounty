-- Agent issues: stop claiming a context snapshot that was never taken.
--
-- `agent_issues.context_collection` defaulted to 'complete'. Nothing wrote the
-- column, so every row asserted "every named resource was resolved and
-- authorized" while `context` was NULL, and the web rendered that as a green
-- "Context attached" pill. Trust claims must match stored evidence, so the
-- default becomes the honest floor and the rows that inherited the old default
-- with no resolved resources are corrected.

-- 1. Honest default for every future insert. Purely a default change: no
--    column type change, no NOT NULL change, no data loss. Reversing it is a
--    single ALTER ... SET DEFAULT 'complete'.
ALTER TABLE "agent_issues" ALTER COLUMN "context_collection" SET DEFAULT 'unavailable';

-- 2. Backfill. Scoped as narrowly as the evidence allows: only rows that
--    currently claim 'complete' AND carry no resolved resource in their
--    snapshot. A row with a real resolved resource list keeps its value, and
--    'partial' / 'pending' / 'unavailable' rows are untouched.
--
--    `context` is jsonb and may be NULL, a non-object, or an object without a
--    `resources` array; jsonb_typeof() guards all three, so the CASE yields 0
--    for anything that is not an actual array of resolved resources.
UPDATE "agent_issues"
SET "context_collection" = 'unavailable'
WHERE "context_collection" = 'complete'
  AND CASE
        WHEN jsonb_typeof("context" -> 'resources') = 'array'
          THEN jsonb_array_length("context" -> 'resources')
        ELSE 0
      END = 0;
