-- Sponsor-requested execution-harness note on a fork/custom dataset type
-- (sponsor/create planner "fields" step). Plain text only, never executable
-- code, never run — purely informational for an admin deciding whether to
-- author a real harness via the existing admin-only harness flow. See the
-- Prisma model doc comment on DatasetType.sponsorHarnessNote for the full
-- security-boundary rationale.
ALTER TABLE "dataset_types" ADD COLUMN "sponsor_harness_note" TEXT;
